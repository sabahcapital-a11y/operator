import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  integer,
  pgEnum,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// ── Enums ──────────────────────────────────────────────────────────────────────

export const planEnum = pgEnum("plan", ["freelancer", "agency", "agency_plus"]);
export const siteStatusEnum = pgEnum("site_status", [
  "active",
  "paused",
  "error",
  "deleted",
]);
export const journeyTypeEnum = pgEnum("journey_type", [
  "contact_form",
  "booking",
  "checkout",
  "phone_link",
  "pixel",
  "chat_widget",
]);
export const runStatusEnum = pgEnum("run_status", [
  "pending",
  "running",
  "passed",
  "failed",
  "flaky",
  "error",
]);
export const alertSeverityEnum = pgEnum("alert_severity", [
  "info",
  "warning",
  "critical",
]);
export const alertChannelEnum = pgEnum("alert_channel", ["email", "slack"]);

// ── Tables ─────────────────────────────────────────────────────────────────────

export const agencies = pgTable("agencies", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  stripeCustomerId: varchar("stripe_customer_id", { length: 255 }),
  plan: planEnum("plan").notNull().default("freelancer"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const sites = pgTable(
  "sites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agencyId: uuid("agency_id")
      .notNull()
      .references(() => agencies.id, { onDelete: "cascade" }),
    url: varchar("url", { length: 2048 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    plan: planEnum("plan").notNull().default("freelancer"),
    status: siteStatusEnum("status").notNull().default("active"),
    checkIntervalMinutes: integer("check_interval_minutes").notNull().default(1440), // daily = 1440
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    agencyIdx: index("sites_agency_idx").on(table.agencyId),
    statusIdx: index("sites_status_idx").on(table.status),
  })
);

export const journeys = pgTable(
  "journeys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    type: journeyTypeEnum("type").notNull(),
    playwrightScript: text("playwright_script").notNull(),
    // When this journey is due for its next run
    nextRunAt: timestamp("next_run_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // How often to run (overrides site default if set)
    checkIntervalMinutes: integer("check_interval_minutes"),
    enabled: integer("enabled").notNull().default(1), // boolean
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    siteIdx: index("journeys_site_idx").on(table.siteId),
    dueIdx: index("journeys_due_idx").on(table.nextRunAt, table.enabled),
  })
);

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    journeyId: uuid("journey_id")
      .notNull()
      .references(() => journeys.id, { onDelete: "cascade" }),
    status: runStatusEnum("status").notNull().default("pending"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    // Runner output
    screenshotUrl: text("screenshot_url"),
    consoleErrors: jsonb("console_errors").$type<string[]>(),
    networkLog: jsonb("network_log").$type<
      { url: string; status: number; method: string; type: string }[]
    >(),
    diagnosis: text("diagnosis"),
    // Retry tracking
    attempt: integer("attempt").notNull().default(1),
    retryOf: uuid("retry_of"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    journeyIdx: index("runs_journey_idx").on(table.journeyId),
    statusIdx: index("runs_status_idx").on(table.status),
    createdIdx: index("runs_created_idx").on(table.createdAt),
  })
);

export const alerts = pgTable(
  "alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    agencyId: uuid("agency_id")
      .notNull()
      .references(() => agencies.id, { onDelete: "cascade" }),
    severity: alertSeverityEnum("severity").notNull().default("warning"),
    channel: alertChannelEnum("channel").notNull().default("email"),
    subject: varchar("subject", { length: 512 }).notNull(),
    body: text("body"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    runIdx: index("alerts_run_idx").on(table.runId),
    agencyIdx: index("alerts_agency_idx").on(table.agencyId),
  })
);

// ── Type Exports ───────────────────────────────────────────────────────────────

export type Agency = typeof agencies.$inferSelect;
export type NewAgency = typeof agencies.$inferInsert;
export type Site = typeof sites.$inferSelect;
export type NewSite = typeof sites.$inferInsert;
export type Journey = typeof journeys.$inferSelect;
export type NewJourney = typeof journeys.$inferInsert;
export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
export type Alert = typeof alerts.$inferSelect;
export type NewAlert = typeof alerts.$inferInsert;
