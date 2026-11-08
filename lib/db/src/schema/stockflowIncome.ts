import { pgTable, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// One locked ledger per normalized wallet. Receipts, cursor and proposals commit
// together, so another API instance cannot propose the same income twice.
export const stockflowIncomeTable = pgTable("stockflow_income", {
  wallet: text("wallet").primaryKey(),
  ledger: jsonb("ledger").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export const insertStockflowIncomeSchema = createInsertSchema(stockflowIncomeTable).omit({ updatedAt: true });
export type InsertStockflowIncome = z.infer<typeof insertStockflowIncomeSchema>;
export type StockflowIncomeRow = typeof stockflowIncomeTable.$inferSelect;
