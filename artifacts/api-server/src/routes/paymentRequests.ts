import { Router } from "express";
import { isAddress, isHex } from "viem";
import { db, paymentRequestsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  ListPaymentRequestsQueryParams,
  CreatePaymentRequestBody,
  GetPaymentRequestParams,
  UpdatePaymentRequestParams,
  UpdatePaymentRequestBody,
} from "@workspace/api-zod";

const router = Router();

// ── Field constraints (enforced here; generated schema has no maxes/formats) ──
const MAX_MEMO_LEN    = 500;
const MAX_AMOUNT_LEN  = 20;       // e.g. "1000000.000000"
const AMOUNT_RE       = /^\d+(\.\d{1,6})?$/; // positive decimal, up to 6 dp
const TX_HASH_RE      = /^0x[0-9a-fA-F]{64}$/;

function serializeRow(r: typeof paymentRequestsTable.$inferSelect) {
  return {
    ...r,
    createdAt: r.createdAt.toISOString(),
    paidAt: r.paidAt ? r.paidAt.toISOString() : null,
  };
}

/**
 * GET /api/payment-requests?recipientAddress=0x...
 * recipientAddress is required — we never expose the full table.
 */
router.get("/payment-requests", async (req, res) => {
  const parsed = ListPaymentRequestsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid query params" });
  }
  const { recipientAddress } = parsed.data;
  if (!recipientAddress) {
    return res.status(400).json({ error: "recipientAddress is required" });
  }
  const rows = await db
    .select()
    .from(paymentRequestsTable)
    .where(eq(paymentRequestsTable.recipientAddress, recipientAddress));
  return res.json(rows.map(serializeRow));
});

router.post("/payment-requests", async (req, res) => {
  const parsed = CreatePaymentRequestBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid body" });
  }
  const { recipientAddress, amount, memo } = parsed.data;

  // Extra validation beyond the generated schema
  if (!isAddress(recipientAddress)) {
    return res.status(400).json({ error: "recipientAddress must be a valid Ethereum address" });
  }
  if (amount.length > MAX_AMOUNT_LEN || !AMOUNT_RE.test(amount) || parseFloat(amount) <= 0) {
    return res.status(400).json({ error: "amount must be a positive decimal with up to 6 decimal places (e.g. \"10.50\")" });
  }
  if (memo && memo.length > MAX_MEMO_LEN) {
    return res.status(400).json({ error: `memo must be at most ${MAX_MEMO_LEN} characters` });
  }

  const [row] = await db.insert(paymentRequestsTable).values(parsed.data).returning();
  return res.status(201).json(serializeRow(row));
});

router.get("/payment-requests/:id", async (req, res) => {
  const parsed = GetPaymentRequestParams.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid params" });
  }
  const [row] = await db
    .select()
    .from(paymentRequestsTable)
    .where(eq(paymentRequestsTable.id, parsed.data.id));
  if (!row) {
    return res.status(404).json({ error: "Payment request not found" });
  }
  return res.json(serializeRow(row));
});

router.patch("/payment-requests/:id", async (req, res) => {
  const paramsParsed = UpdatePaymentRequestParams.safeParse(req.params);
  const bodyParsed   = UpdatePaymentRequestBody.safeParse(req.body);
  if (!paramsParsed.success || !bodyParsed.success) {
    return res.status(400).json({ error: "Invalid request" });
  }

  // Validate paidTxHash format — must be a 0x-prefixed 32-byte tx hash
  if (bodyParsed.data.paidTxHash) {
    if (!TX_HASH_RE.test(bodyParsed.data.paidTxHash) || !isHex(bodyParsed.data.paidTxHash)) {
      return res.status(400).json({ error: "paidTxHash must be a 0x-prefixed 32-byte transaction hash" });
    }
  }

  // Fetch existing row first so we can enforce state transitions
  const [existing] = await db
    .select()
    .from(paymentRequestsTable)
    .where(eq(paymentRequestsTable.id, paramsParsed.data.id));
  if (!existing) {
    return res.status(404).json({ error: "Payment request not found" });
  }

  // Only pending requests may be updated — prevent re-marking or reverting
  if (existing.status !== "pending") {
    return res.status(409).json({ error: "Only pending payment requests can be updated" });
  }

  // Require a txHash when marking as paid so a plausible on-chain reference is present
  if (bodyParsed.data.status === "paid" && !bodyParsed.data.paidTxHash) {
    return res.status(400).json({ error: "paidTxHash is required when marking a request as paid" });
  }

  const updates: Record<string, unknown> = {};
  if (bodyParsed.data.status)     updates.status     = bodyParsed.data.status;
  if (bodyParsed.data.paidTxHash) updates.paidTxHash = bodyParsed.data.paidTxHash;
  if (bodyParsed.data.status === "paid") updates.paidAt = new Date();

  const [row] = await db
    .update(paymentRequestsTable)
    .set(updates)
    .where(eq(paymentRequestsTable.id, paramsParsed.data.id))
    .returning();
  if (!row) {
    return res.status(404).json({ error: "Payment request not found" });
  }
  return res.json(serializeRow(row));
});

export default router;
