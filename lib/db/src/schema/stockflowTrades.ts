import { pgTable, text, integer, timestamp, index, jsonb } from "drizzle-orm/pg-core";
import type { StoredTransactionFee } from "@workspace/base-fees";
import { createInsertSchema } from "drizzle-zod";
import { stockflowQuotesTable } from "./stockflowQuotes";
export const stockflowTradesTable = pgTable("stockflow_trades", {
  hash: text("hash").primaryKey(),
  wallet: text("wallet").notNull(),
  quoteId: text("quote_id").notNull().references(() => stockflowQuotesTable.id),
  symbol: text("symbol").notNull(),
  side: text("side").$type<"buy" | "sell">().notNull(),
  status: text("status").$type<"pending" | "confirmed" | "failed" | "cancelled" | "changed">().notNull(),
  amountIn: text("amount_in").notNull(),
  amountOut: text("amount_out"),
  networkFees: jsonb("network_fees").$type<StoredTransactionFee>(),
  reviewedSwapFee: jsonb("reviewed_swap_fee").$type<StoredTransactionFee>(),
  decimalsIn: integer("decimals_in").notNull(),
  decimalsOut: integer("decimals_out").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, table => [index("stockflow_trades_wallet").on(table.wallet)]);
export const insertStockflowTradeSchema = createInsertSchema(stockflowTradesTable);
