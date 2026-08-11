// Runs once per server instance, before any request is handled. Next calls
// `register` in every runtime, so Node-only APIs need the guard.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { tuneOutboundConnections } = await import("@/lib/net-tuning");
    tuneOutboundConnections();
  }
}
