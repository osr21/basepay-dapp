import { pgTable, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
export const stockflowPilotTable = pgTable("stockflow_pilot", {
  wallet: text("wallet").primaryKey(),
  countryCode: text("country_code").notNull(),
  approved: boolean("approved").notNull().default(false),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  reviewedBy: text("reviewed_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
export const insertStockflowPilotSchema = createInsertSchema(stockflowPilotTable);
export type StockflowPilot = typeof stockflowPilotTable.$inferSelect;
