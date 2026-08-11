import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "../env";
import * as schema from "./schema";

// Pool sizing matters more than it looks once the database is a network hop
// away rather than a container on the same host.
//
// node-postgres closes idle connections after 10s by default. Against a
// managed Postgres that means most requests arrive to an empty pool and pay
// a full connect — measured at ~1.5s to Neon (TCP + TLS + SCRAM over the
// round trip), against ~240ms for a query on the same link. A quiet minute
// was enough to make the next click feel broken.
//
// Holding connections open costs nothing here: Neon's pooler is built for
// far more than this, and one long-lived Next server is the only client.
const IDLE_TIMEOUT_MS = 60_000;
// Fail a genuinely unreachable database fast and loudly instead of hanging
// a request until something upstream gives up.
const CONNECTION_TIMEOUT_MS = 10_000;
// A dead NAT/idle-timeout mapping otherwise surfaces as a request that hangs
// until the OS notices, which is minutes.
const KEEPALIVE_DELAY_MS = 10_000;

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
  idleTimeoutMillis: IDLE_TIMEOUT_MS,
  keepAlive: true,
  keepAliveInitialDelayMillis: KEEPALIVE_DELAY_MS,
});

export const db = drizzle(pool, { schema });
