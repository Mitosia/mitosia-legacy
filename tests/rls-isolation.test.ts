import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  auditLog,
  brand,
  campaign,
  client,
  contextSnapshot,
  episodeBrief,
  momentCandidate,
  momentDiscoveryRun,
  project,
  segmentClip,
  segmentPlanRun,
  source,
  sourceAnalysis,
  sourceArtifact,
  sourceChapter,
  sourceExtraction,
  sourceExtractionRun,
  sourceIndex,
  sourceQuestion,
  transcript,
  transcriptChunk,
  transcriptRevision,
  usageLedger,
} from "../lib/db/schema";

// Cross-tenant isolation suite — the S1 exit criterion.
//
// Runs against a DISPOSABLE database (TEST_DATABASE_URL, wiped every run).
// The URL must carry owner/superuser credentials: the suite migrates the
// schema, then creates an unprivileged role and re-connects as it for every
// assertion — mirroring production, where the app role is never a superuser
// (superusers silently bypass RLS, which would make this suite vacuous).

const TEST_ROLE = "mitosia_rls_test";

const ownerUrl = process.env.TEST_DATABASE_URL;

if (!ownerUrl) {
  throw new Error(
    "TEST_DATABASE_URL must point at a disposable database (it gets wiped)."
  );
}

const ownerPool = new Pool({ connectionString: ownerUrl });

const appUrl = new URL(ownerUrl);
appUrl.username = TEST_ROLE;
appUrl.password = TEST_ROLE;
const appPool = new Pool({ connectionString: appUrl.toString() });
const appDb = drizzle(appPool);

const ORG_A = "org_a_isolation";
const ORG_B = "org_b_isolation";
const RLS_VIOLATION = /row-level security/;

interface SeededIds {
  auditId: string;
  brandId: string;
  campaignId: string;
  clientId: string;
  ledgerId: string;
  projectId: string;
  sourceId: string;
}

const seeded = new Map<string, SeededIds>();

function scoped<T>(
  organizationId: string,
  fn: (tx: Parameters<Parameters<typeof appDb.transaction>[0]>[0]) => Promise<T>
): Promise<T> {
  return appDb.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.organization_id', ${organizationId}, true)`
    );
    return await fn(tx);
  });
}

async function seedOrgChain(organizationId: string): Promise<SeededIds> {
  return await scoped(organizationId, async (tx) => {
    const [clientRow] = await tx
      .insert(client)
      .values({ name: `${organizationId} client`, organizationId })
      .returning({ id: client.id });
    const [brandRow] = await tx
      .insert(brand)
      .values({
        // biome-ignore lint/style/noNonNullAssertion: seeded row always returns
        clientId: clientRow!.id,
        name: `${organizationId} brand`,
        organizationId,
      })
      .returning({ id: brand.id });
    const [campaignRow] = await tx
      .insert(campaign)
      .values({
        // biome-ignore lint/style/noNonNullAssertion: seeded row always returns
        brandId: brandRow!.id,
        name: `${organizationId} campaign`,
        organizationId,
      })
      .returning({ id: campaign.id });
    const [projectRow] = await tx
      .insert(project)
      .values({
        // biome-ignore lint/style/noNonNullAssertion: seeded row always returns
        campaignId: campaignRow!.id,
        name: `${organizationId} project`,
        organizationId,
      })
      .returning({ id: project.id });
    const [auditRow] = await tx
      .insert(auditLog)
      .values({
        action: "test.seeded",
        entityType: "test",
        organizationId,
      })
      .returning({ id: auditLog.id });
    const [sourceRow] = await tx
      .insert(source)
      .values({
        mimeType: "video/mp4",
        organizationId,
        originalFilename: "seed.mp4",
        // biome-ignore lint/style/noNonNullAssertion: seeded row always returns
        projectId: projectRow!.id,
        status: "uploaded",
        storageKey: `org/${organizationId}/source/seed/original/seed.mp4`,
        title: `${organizationId} source`,
      })
      .returning({ id: source.id });
    await tx.insert(sourceArtifact).values({
      kind: "hls_master",
      mimeType: "application/vnd.apple.mpegurl",
      organizationId,
      // biome-ignore lint/style/noNonNullAssertion: seeded row always returns
      sourceId: sourceRow!.id,
      storageKey: `org/${organizationId}/source/seed/hls/master.m3u8`,
    });
    const [snapshotRow] = await tx
      .insert(contextSnapshot)
      .values({
        content: { seeded: true },
        hash: `hash-${organizationId}`,
        kind: "source-analysis",
        organizationId,
      })
      .returning({ id: contextSnapshot.id });
    const [analysisRow] = await tx
      .insert(sourceAnalysis)
      .values({
        // biome-ignore lint/style/noNonNullAssertion: seeded row always returns
        contextSnapshotId: snapshotRow!.id,
        organizationId,
        // biome-ignore lint/style/noNonNullAssertion: seeded row always returns
        sourceId: sourceRow!.id,
        status: "ready",
      })
      .returning({ id: sourceAnalysis.id });
    await tx.insert(sourceChapter).values({
      // biome-ignore lint/style/noNonNullAssertion: seeded row always returns
      analysisId: analysisRow!.id,
      endMs: 1000,
      idx: 0,
      organizationId,
      startMs: 0,
      title: `${organizationId} chapter`,
    });
    const [extractionRunRow] = await tx
      .insert(sourceExtractionRun)
      .values({
        organizationId,
        revision: 1,
        // biome-ignore lint/style/noNonNullAssertion: seeded row always returns
        sourceId: sourceRow!.id,
        status: "ready",
      })
      .returning({ id: sourceExtractionRun.id });
    await tx.insert(sourceExtraction).values({
      confidence: 0.9,
      endMs: 1000,
      grounded: true,
      groundingScore: 1,
      kind: "quote",
      organizationId,
      revision: 1,
      // biome-ignore lint/style/noNonNullAssertion: seeded row always returns
      runId: extractionRunRow!.id,
      // biome-ignore lint/style/noNonNullAssertion: seeded row always returns
      sourceId: sourceRow!.id,
      speaker: "0",
      startMs: 0,
      text: `${organizationId} extraction`,
    });
    const [discoveryRunRow] = await tx
      .insert(momentDiscoveryRun)
      .values({
        organizationId,
        revision: 1,
        // biome-ignore lint/style/noNonNullAssertion: seeded row always returns
        sourceId: sourceRow!.id,
        status: "ready",
      })
      .returning({ id: momentDiscoveryRun.id });
    await tx.insert(momentCandidate).values({
      anchorText: `${organizationId} anchor`,
      composite: 0.8,
      endMs: 1000,
      grounded: true,
      groundingScore: 1,
      hook: "A seeded hook.",
      organizationId,
      rank: 0,
      rawEndMs: 1000,
      rawStartMs: 0,
      revision: 1,
      // biome-ignore lint/style/noNonNullAssertion: seeded row always returns
      runId: discoveryRunRow!.id,
      scores: {
        comprehensibility: 0.8,
        hook: 0.8,
        insight: 0.8,
        relevance: 0.8,
        risk: 0.1,
      },
      seedIds: [],
      sensitive: false,
      // biome-ignore lint/style/noNonNullAssertion: seeded row always returns
      sourceId: sourceRow!.id,
      startMs: 0,
      summary: "A seeded summary.",
      suppressed: false,
      title: `${organizationId} moment`,
    });
    const [segmentRunRow] = await tx
      .insert(segmentPlanRun)
      .values({
        organizationId,
        revision: 1,
        // biome-ignore lint/style/noNonNullAssertion: seeded row always returns
        sourceId: sourceRow!.id,
        status: "ready",
      })
      .returning({ id: segmentPlanRun.id });
    await tx.insert(segmentClip).values({
      endMs: 1000,
      flags: [],
      grounded: true,
      groundingScore: 1,
      idx: 0,
      kind: "keep",
      organizationId,
      rawEndMs: 1000,
      rawStartMs: 0,
      revision: 1,
      // biome-ignore lint/style/noNonNullAssertion: seeded row always returns
      runId: segmentRunRow!.id,
      // biome-ignore lint/style/noNonNullAssertion: seeded row always returns
      sourceId: sourceRow!.id,
      startMs: 0,
      title: `${organizationId} segment`,
    });
    await tx.insert(episodeBrief).values({
      brief: { seeded: true },
      model: "mock",
      organizationId,
      revision: 1,
      // biome-ignore lint/style/noNonNullAssertion: seeded row always returns
      sourceId: sourceRow!.id,
    });
    await tx.insert(sourceQuestion).values({
      answer: "seed answer",
      answerable: true,
      citations: [],
      organizationId,
      question: `${organizationId} question`,
      // biome-ignore lint/style/noNonNullAssertion: seeded row always returns
      sourceId: sourceRow!.id,
      status: "ready",
    });
    await tx.insert(sourceIndex).values({
      organizationId,
      revision: 1,
      // biome-ignore lint/style/noNonNullAssertion: seeded row always returns
      sourceId: sourceRow!.id,
      status: "ready",
    });
    await tx.insert(transcriptChunk).values({
      embedding: new Array(1024).fill(0),
      embeddingModel: "mock-embed-1",
      endMs: 1000,
      idx: 0,
      organizationId,
      revision: 1,
      // biome-ignore lint/style/noNonNullAssertion: seeded row always returns
      sourceId: sourceRow!.id,
      speakers: ["0"],
      startMs: 0,
      text: `${organizationId} chunk`,
      tokenCount: 2,
    });
    const [transcriptRow] = await tx
      .insert(transcript)
      .values({
        organizationId,
        // biome-ignore lint/style/noNonNullAssertion: seeded row always returns
        sourceId: sourceRow!.id,
        status: "ready",
      })
      .returning({ id: transcript.id });
    await tx.insert(transcriptRevision).values({
      organizationId,
      revision: 1,
      sizeBytes: 128,
      storageKey: `org/${organizationId}/source/seed/transcript/rev-1.json`,
      // biome-ignore lint/style/noNonNullAssertion: seeded row always returns
      transcriptId: transcriptRow!.id,
    });
    const [ledgerRow] = await tx
      .insert(usageLedger)
      .values({
        correlationId: `seed:${organizationId}`,
        entryType: "storage_bytes",
        organizationId,
        quantity: 1024,
        // biome-ignore lint/style/noNonNullAssertion: seeded row always returns
        sourceId: sourceRow!.id,
        unit: "bytes",
      })
      .returning({ id: usageLedger.id });

    return {
      // biome-ignore lint/style/noNonNullAssertion: seeded rows always return
      auditId: auditRow!.id,
      // biome-ignore lint/style/noNonNullAssertion: seeded rows always return
      brandId: brandRow!.id,
      // biome-ignore lint/style/noNonNullAssertion: seeded rows always return
      campaignId: campaignRow!.id,
      // biome-ignore lint/style/noNonNullAssertion: seeded rows always return
      clientId: clientRow!.id,
      // biome-ignore lint/style/noNonNullAssertion: seeded rows always return
      ledgerId: ledgerRow!.id,
      // biome-ignore lint/style/noNonNullAssertion: seeded rows always return
      projectId: projectRow!.id,
      // biome-ignore lint/style/noNonNullAssertion: seeded rows always return
      sourceId: sourceRow!.id,
    };
  });
}

const TENANT_TABLES = [
  { label: "client", table: client },
  { label: "brand", table: brand },
  { label: "campaign", table: campaign },
  { label: "project", table: project },
  { label: "audit_log", table: auditLog },
  { label: "source", table: source },
  { label: "source_artifact", table: sourceArtifact },
  { label: "transcript", table: transcript },
  { label: "transcript_revision", table: transcriptRevision },
  { label: "source_index", table: sourceIndex },
  { label: "transcript_chunk", table: transcriptChunk },
  { label: "source_extraction_run", table: sourceExtractionRun },
  { label: "source_extraction", table: sourceExtraction },
  { label: "moment_discovery_run", table: momentDiscoveryRun },
  { label: "moment_candidate", table: momentCandidate },
  { label: "segment_plan_run", table: segmentPlanRun },
  { label: "segment_clip", table: segmentClip },
  { label: "episode_brief", table: episodeBrief },
  { label: "source_question", table: sourceQuestion },
  { label: "context_snapshot", table: contextSnapshot },
  { label: "source_analysis", table: sourceAnalysis },
  { label: "source_chapter", table: sourceChapter },
  { label: "usage_ledger", table: usageLedger },
] as const;

beforeAll(async () => {
  // Wipe and rebuild the disposable database from migrations.
  await ownerPool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await ownerPool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await ownerPool.query("CREATE SCHEMA public");
  await migrate(drizzle(ownerPool), { migrationsFolder: "./drizzle" });

  // Unprivileged app role — RLS applies to it (unlike the owner).
  await ownerPool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${TEST_ROLE}') THEN
        CREATE ROLE ${TEST_ROLE} LOGIN PASSWORD '${TEST_ROLE}';
      END IF;
    END $$`);
  const dbName = new URL(ownerUrl).pathname.slice(1);
  await ownerPool.query(
    `GRANT CONNECT ON DATABASE "${dbName}" TO ${TEST_ROLE}`
  );
  await ownerPool.query(`GRANT USAGE ON SCHEMA public TO ${TEST_ROLE}`);
  await ownerPool.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${TEST_ROLE}`
  );

  // Organizations are not tenant-scoped rows; seed them as owner.
  await ownerPool.query(
    `INSERT INTO organization (id, name, slug, created_at)
     VALUES ($1, 'Org A', 'org-a-iso', now()), ($2, 'Org B', 'org-b-iso', now())`,
    [ORG_A, ORG_B]
  );

  seeded.set(ORG_A, await seedOrgChain(ORG_A));
  seeded.set(ORG_B, await seedOrgChain(ORG_B));
});

afterAll(async () => {
  await appPool.end();
  await ownerPool.end();
});

describe("cross-tenant isolation (RLS)", () => {
  it("app role is not a superuser and cannot bypass RLS", async () => {
    const { rows } = await appPool.query(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user"
    );
    expect(rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
  });

  for (const { label, table } of TENANT_TABLES) {
    it(`${label}: org A sees only its own rows`, async () => {
      const rows = await scoped(ORG_A, (tx) => tx.select().from(table));
      expect(rows).toHaveLength(1);
      expect((rows[0] as { organizationId: string }).organizationId).toBe(
        ORG_A
      );
    });

    it(`${label}: no org context reads zero rows`, async () => {
      const rows = await appDb.select().from(table);
      expect(rows).toHaveLength(0);
    });
  }

  it("rejects inserting a row tagged with another organization", async () => {
    // drizzle wraps the pg error; the RLS message lives on error.cause
    const error = await scoped(ORG_A, (tx) =>
      tx
        .insert(client)
        .values({ name: "cross-tenant write", organizationId: ORG_B })
    ).then(
      () => null,
      (thrown: Error & { cause?: Error }) => thrown
    );

    expect(error).not.toBeNull();
    const message = `${error?.message} ${error?.cause?.message}`;
    expect(RLS_VIOLATION.test(message)).toBe(true);
  });

  it("cross-tenant updates affect zero rows", async () => {
    // biome-ignore lint/style/noNonNullAssertion: seeded in beforeAll
    const targetId = seeded.get(ORG_B)!.clientId;
    const updated = await scoped(ORG_A, (tx) =>
      tx
        .update(client)
        .set({ name: "hijacked" })
        .where(sql`${client.id} = ${targetId}`)
        .returning({ id: client.id })
    );
    expect(updated).toHaveLength(0);
  });

  it("cross-tenant deletes affect zero rows", async () => {
    // biome-ignore lint/style/noNonNullAssertion: seeded in beforeAll
    const targetId = seeded.get(ORG_B)!.projectId;
    const deleted = await scoped(ORG_A, (tx) =>
      tx
        .delete(project)
        .where(sql`${project.id} = ${targetId}`)
        .returning({ id: project.id })
    );
    expect(deleted).toHaveLength(0);
  });

  // The ledger has only SELECT and INSERT policies — RLS default-denies
  // UPDATE and DELETE, so history is immutable even inside the owning org.
  it("usage_ledger: updates are denied even within the same org", async () => {
    // biome-ignore lint/style/noNonNullAssertion: seeded in beforeAll
    const ownId = seeded.get(ORG_A)!.ledgerId;
    const updated = await scoped(ORG_A, (tx) =>
      tx
        .update(usageLedger)
        .set({ quantity: 0 })
        .where(sql`${usageLedger.id} = ${ownId}`)
        .returning({ id: usageLedger.id })
    );
    expect(updated).toHaveLength(0);
  });

  it("usage_ledger: deletes are denied even within the same org", async () => {
    // biome-ignore lint/style/noNonNullAssertion: seeded in beforeAll
    const ownId = seeded.get(ORG_A)!.ledgerId;
    const deleted = await scoped(ORG_A, (tx) =>
      tx
        .delete(usageLedger)
        .where(sql`${usageLedger.id} = ${ownId}`)
        .returning({ id: usageLedger.id })
    );
    expect(deleted).toHaveLength(0);
  });

  it("cross-tenant reads by exact primary key return nothing", async () => {
    // biome-ignore lint/style/noNonNullAssertion: seeded in beforeAll
    const targetId = seeded.get(ORG_B)!.clientId;
    const rows = await scoped(ORG_A, (tx) =>
      tx.select().from(client).where(sql`${client.id} = ${targetId}`)
    );
    expect(rows).toHaveLength(0);
  });
});
