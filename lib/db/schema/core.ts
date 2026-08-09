import { relations, sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organization, user } from "./auth";

// Every tenant-owned table carries organization_id and is protected by
// Postgres RLS (ENABLE + FORCE, see the rls migration). App code must only
// touch these tables inside withOrgScope() from lib/db/tenant.ts.

const CLIENT_STATUSES = ["active", "paused", "archived"] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];

const timestamps = {
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
};

export const client = pgTable(
  "client",
  {
    // uuidv7 keeps index locality; native in Postgres 18 (all environments)
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    name: text("name").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    status: text("status", { enum: CLIENT_STATUSES })
      .default("active")
      .notNull(),
    ...timestamps,
  },
  (table) => [index("client_org_idx").on(table.organizationId)]
);

export const brand = pgTable(
  "brand",
  {
    clientId: uuid("client_id")
      .notNull()
      .references(() => client.id, { onDelete: "cascade" }),
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    name: text("name").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    ...timestamps,
  },
  (table) => [
    index("brand_org_idx").on(table.organizationId),
    index("brand_client_idx").on(table.clientId),
  ]
);

export const campaign = pgTable(
  "campaign",
  {
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brand.id, { onDelete: "cascade" }),
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    name: text("name").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    ...timestamps,
  },
  (table) => [
    index("campaign_org_idx").on(table.organizationId),
    index("campaign_brand_idx").on(table.brandId),
  ]
);

export const project = pgTable(
  "project",
  {
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaign.id, { onDelete: "cascade" }),
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    name: text("name").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    ...timestamps,
  },
  (table) => [
    index("project_org_idx").on(table.organizationId),
    index("project_campaign_idx").on(table.campaignId),
  ]
);

// Append-only. No FK on entity_id (entities may be deleted; audit survives).
export const auditLog = pgTable(
  "audit_log",
  {
    action: text("action").notNull(),
    actorUserId: text("actor_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    entityId: text("entity_id"),
    entityType: text("entity_type").notNull(),
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    metadata: jsonb("metadata"),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("audit_log_org_idx").on(table.organizationId),
    index("audit_log_entity_idx").on(table.entityType, table.entityId),
  ]
);

export const clientRelations = relations(client, ({ many, one }) => ({
  brands: many(brand),
  organization: one(organization, {
    fields: [client.organizationId],
    references: [organization.id],
  }),
}));

export const brandRelations = relations(brand, ({ many, one }) => ({
  campaigns: many(campaign),
  client: one(client, {
    fields: [brand.clientId],
    references: [client.id],
  }),
}));

export const campaignRelations = relations(campaign, ({ many, one }) => ({
  brand: one(brand, {
    fields: [campaign.brandId],
    references: [brand.id],
  }),
  projects: many(project),
}));

export const projectRelations = relations(project, ({ one }) => ({
  campaign: one(campaign, {
    fields: [project.campaignId],
    references: [campaign.id],
  }),
}));
