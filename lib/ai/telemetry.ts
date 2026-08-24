// Langfuse tracing bootstrap, callable from BOTH runtimes that make AI
// calls: instrumentation.ts (Next server) and every ./trigger task at
// module scope (Next's register() never fires in Trigger workers — the
// tuneOutboundConnections precedent, extended to telemetry). Idempotent,
// and a no-op unless Langfuse keys are present: observability must never
// be a boot requirement.
//
// Spans reach Langfuse two ways, both through this one processor: our own
// AI SDK calls (v7 register-once telemetry) and Mastra's AI tracing via
// @mastra/langfuse configured on the Mastra instance. Flushes in
// request-scoped contexts ride after() — see flushTelemetry().

let initialized = false;
let flush: (() => Promise<void>) | null = null;

export function isTelemetryConfigured(): boolean {
  return Boolean(
    process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY
  );
}

export async function initAiTelemetry(): Promise<void> {
  if (initialized || !isTelemetryConfigured()) {
    return;
  }
  initialized = true;

  // Bundlers (Trigger's worker build included) wrap some of these packages
  // in ESM/CJS interop where named exports land under `default` — a plain
  // destructure then throws "X is not a constructor" (observed in the
  // deployed worker, run logs 2026-08-24). Resolve both shapes.
  const named = async <T>(specifier: () => Promise<object>, name: string) => {
    const mod = (await specifier()) as Record<string, T> & {
      default?: Record<string, T>;
    };
    const value = mod[name] ?? mod.default?.[name];
    if (!value) {
      throw new Error(`${name} not found in module exports`);
    }
    return value;
  };

  // Phase 1 — the AI SDK integration (registered FIRST and independently:
  // it is what creates generation spans, and it stores on globalThis, so
  // it must survive even if provider setup fails).
  try {
    const registerTelemetry = await named<(...integrations: unknown[]) => void>(
      () => import("ai"),
      "registerTelemetry"
    );
    const LangfuseVercelAiSdkIntegration = await named<new () => unknown>(
      () => import("@langfuse/vercel-ai-sdk"),
      "LangfuseVercelAiSdkIntegration"
    );
    registerTelemetry(new LangfuseVercelAiSdkIntegration());
  } catch (error) {
    console.error("[ai] telemetry integration registration failed:", error);
  }

  // Phase 2 — the span pipeline. The global OTel provider is unclaimed in
  // BOTH runtimes (Trigger keeps its own provider private — verified:
  // global is ProxyTracerProvider in workers), so this registration wins
  // everywhere and the processor ships spans straight to Langfuse.
  try {
    const LangfuseSpanProcessor = await named<
      new (
        options: Record<string, unknown>
      ) => {
        forceFlush: () => Promise<void>;
      }
    >(() => import("@langfuse/otel"), "LangfuseSpanProcessor");
    const NodeTracerProvider = await named<
      new (
        options: Record<string, unknown>
      ) => { register: () => void }
    >(() => import("@opentelemetry/sdk-trace-node"), "NodeTracerProvider");
    const processor = new LangfuseSpanProcessor({
      baseUrl: process.env.LANGFUSE_BASE_URL,
      publicKey: process.env.LANGFUSE_PUBLIC_KEY,
      secretKey: process.env.LANGFUSE_SECRET_KEY,
    });
    const provider = new NodeTracerProvider({ spanProcessors: [processor] });
    provider.register();
    flush = () => processor.forceFlush();
  } catch (error) {
    // Tracing is diagnostic infrastructure; a failed init must never take
    // the app or a worker down with it.
    console.error("[ai] telemetry span pipeline init failed:", error);
  }
}

// Await in after()/task-completion paths so short-lived contexts do not
// drop buffered spans.
export async function flushTelemetry(): Promise<void> {
  await flush?.().catch((error) => {
    console.error("[ai] telemetry flush failed:", error);
  });
}
