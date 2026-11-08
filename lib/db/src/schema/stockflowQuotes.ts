import { pgTable, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
export const stockflowQuotesTable = pgTable("stockflow_quotes", {
  id: text("id").primaryKey(),
  wallet: text("wallet").notNull(),
  payload: jsonb("payload").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, table => [index("stockflow_quotes_wallet").on(table.wallet)]);
export const insertStockflowQuoteSchema = createInsertSchema(stockflowQuotesTable);
