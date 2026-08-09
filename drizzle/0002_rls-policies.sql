-- Tenant isolation via Row Level Security.
--
-- Every tenant-owned table is scoped to the transaction-local setting
-- app.organization_id (set by withOrgScope in lib/db/tenant.ts).
-- FORCE is required because the app connects as the table owner, and
-- owners bypass RLS unless forced. current_setting(..., true) returns
-- NULL when the setting is absent, so with no org context every table
-- reads as empty and all writes are rejected: fail closed.

ALTER TABLE "client" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "client" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "client_org_isolation" ON "client"
  USING ("organization_id" = current_setting('app.organization_id', true))
  WITH CHECK ("organization_id" = current_setting('app.organization_id', true));--> statement-breakpoint

ALTER TABLE "brand" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "brand" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "brand_org_isolation" ON "brand"
  USING ("organization_id" = current_setting('app.organization_id', true))
  WITH CHECK ("organization_id" = current_setting('app.organization_id', true));--> statement-breakpoint

ALTER TABLE "campaign" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "campaign" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "campaign_org_isolation" ON "campaign"
  USING ("organization_id" = current_setting('app.organization_id', true))
  WITH CHECK ("organization_id" = current_setting('app.organization_id', true));--> statement-breakpoint

ALTER TABLE "project" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "project_org_isolation" ON "project"
  USING ("organization_id" = current_setting('app.organization_id', true))
  WITH CHECK ("organization_id" = current_setting('app.organization_id', true));--> statement-breakpoint

ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "audit_log_org_isolation" ON "audit_log"
  USING ("organization_id" = current_setting('app.organization_id', true))
  WITH CHECK ("organization_id" = current_setting('app.organization_id', true));
