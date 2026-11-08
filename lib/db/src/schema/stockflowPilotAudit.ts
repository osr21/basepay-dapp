import { pgTable, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
export const stockflowPilotAuditTable = pgTable("stockflow_pilot_audit", {
  id: text("id").primaryKey(),
  wallet: text("wallet").notNull(),
  actor: text("actor").notNull(),
  decision: jsonb("decision").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
export const insertStockflowPilotAuditSchema = createInsertSchema(stockflowPilotAuditTable);
