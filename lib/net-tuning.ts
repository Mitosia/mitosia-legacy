import dns from "node:dns";
import net from "node:net";

// Connection tuning for reaching a managed database across a WAN. Node's
// defaults assume the database is close; ours is a Neon endpoint in
// us-east-2 and the VPS is ~230ms away.
//
// Two defaults conspire against that:
//
//  1. Happy Eyeballs (`autoSelectFamily`, on by default since Node 20) races
//     every resolved address and gives each one just 250ms. A TCP+TLS
//     handshake at 230ms RTT does not fit, so attempts are abandoned as
//     "ETIMEDOUT" that were merely in progress.
//  2. Neon publishes AAAA records, and the container has no IPv6 route, so
//     half the candidates fail with ENETUNREACH.
//
// Together they fail every address in under a second and surface as a bare
// `AggregateError`. That is what it looked like from the outside: migrations
// failed, the container exited 1, Swarm rolled the deploy back, and the
// Dokploy API, the deployment list and `docker service update` all still
// reported success. Only the dead container's log told the truth.
//
// Set in code rather than NODE_OPTIONS so it cannot be silently shadowed by
// an environment that forgets it — the failure mode is a container that
// cannot reach its database at all.

const ATTEMPT_TIMEOUT_MS = 3000;

export function tuneOutboundConnections(): void {
  // IPv4 first: the AAAA records are real, the route to them is not.
  dns.setDefaultResultOrder("ipv4first");
  // Room for a cross-region handshake before an address is written off.
  net.setDefaultAutoSelectFamilyAttemptTimeout(ATTEMPT_TIMEOUT_MS);
}
