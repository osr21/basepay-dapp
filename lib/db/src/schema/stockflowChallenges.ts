import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
export const stockflowChallengesTable = pgTable("stockflow_challenges", {
  id: text("id").primaryKey(),
  wallet: text("wallet").notNull(),
  message: text("message").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, table => [index("stockflow_challenge_expiry").on(table.expiresAt)]);
export const insertStockflowChallengeSchema = createInsertSchema(stockflowChallengesTable);
