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
  try {
    const [
      { LangfuseSpanProcessor },
      { NodeTracerProvider },
      { registerTelemetry },
      { LangfuseVercelAiSdkIntegration },
    ] = await Promise.all([
      import("@langfuse/otel"),
      import("@opentelemetry/sdk-trace-node"),
      import("ai"),
      import("@langfuse/vercel-ai-sdk"),
    ]);
    const processor = new LangfuseSpanProcessor({
      baseUrl: process.env.LANGFUSE_BASE_URL,
      publicKey: process.env.LANGFUSE_PUBLIC_KEY,
      secretKey: process.env.LANGFUSE_SECRET_KEY,
    });
    const provider = new NodeTracerProvider({ spanProcessors: [processor] });
    // In the Next runtime this becomes the global provider. In Trigger
    // workers the register() silently LOSES to Trigger's own provider —
    // there, spans reach Langfuse via the OTLP exporter in
    // trigger.config.ts telemetry.exporters instead.
    provider.register();
    // AI SDK v7 emits NO spans by itself: telemetry is a register-once
    // integration receiving lifecycle events. This is what actually
    // creates the generation spans (model, tokens, i/o) on whichever
    // provider is global.
    registerTelemetry(new LangfuseVercelAiSdkIntegration());
    flush = () => processor.forceFlush();
  } catch (error) {
    // Tracing is diagnostic infrastructure; a failed init must never take
    // the app or a worker down with it.
    console.error("[ai] telemetry init failed:", error);
  }
}

// Await in after()/task-completion paths so short-lived contexts do not
// drop buffered spans.
export async function flushTelemetry(): Promise<void> {
  await flush?.().catch((error) => {
    console.error("[ai] telemetry flush failed:", error);
  });
}
