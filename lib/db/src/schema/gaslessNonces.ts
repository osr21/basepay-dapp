import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const gaslessNoncesTable = pgTable("gasless_nonces", {
  nonce:         text("nonce").primaryKey(),
  senderAddress: text("sender_address").notNull(),
  txHash:        text("tx_hash").notNull(),
  createdAt:     timestamp("created_at").defaultNow().notNull(),
});

export type GaslessNonce = typeof gaslessNoncesTable.$inferSelect;
