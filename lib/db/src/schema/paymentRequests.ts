import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { nanoid } from "nanoid";

export const paymentRequestsTable = pgTable("payment_requests", {
  id: text("id").primaryKey().$defaultFn(() => nanoid(10)),
  recipientAddress: text("recipient_address").notNull(),
  amount: text("amount").notNull(),
  token: text("token").notNull().default("USDC"),
  memo: text("memo"),
  status: text("status").notNull().default("pending"),
  paidTxHash: text("paid_tx_hash"),
  paidAt: timestamp("paid_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertPaymentRequestSchema = createInsertSchema(paymentRequestsTable).omit({ id: true, createdAt: true, paidAt: true });
export type InsertPaymentRequest = z.infer<typeof insertPaymentRequestSchema>;
export type PaymentRequest = typeof paymentRequestsTable.$inferSelect;
