import { Router } from "express";
import {
  isAddress,
  isHex,
  createPublicClient,
  http,
  parseAbi,
  type Hex,
} from "viem";
import { base } from "viem/chains";
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

// ── On-chain client for tx receipt verification ───────────────────────────────
const publicClient = createPublicClient({ chain: base, transport: http("https://mainnet.base.org") });

const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const USDC_TRANSFER_EVENT = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

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
  if (!isAddress(recipientAddress)) {
    return res.status(400).json({ error: "recipientAddress must be a valid Ethereum address" });
  }
  const rows = await db
    .select()
    .from(paymentRequestsTable)
    .where(eq(paymentRequestsTable.recipientAddress, recipientAddress))
    .limit(200);
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

/**
 * PATCH /api/payment-requests/:id?recipientAddress=0x...
 *
 * Two valid authorization paths:
 *
 * 1. Recipient auth — caller provides `?recipientAddress=` matching the stored
 *    recipient.  Required for:
 *    - status: "cancelled"  (only the recipient may cancel their own request)
 *    - status: "paid" without a paidTxHash (manual mark-paid by the recipient)
 *
 * 2. Tx proof — caller provides a `paidTxHash` for status: "paid".  The server
 *    verifies on-chain that the tx succeeded and included a USDC Transfer to the
 *    recipient.  Used by the payer flow in Pay.tsx — the payer is not the
 *    recipient so they cannot use recipient auth.
 */
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

  // Fetch existing row first so we can enforce state transitions + ownership
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

  // ── Authorization ─────────────────────────────────────────────────────────
  const callerAddress = req.query.recipientAddress as string | undefined;
  const isRecipientAuth =
    !!callerAddress &&
    isAddress(callerAddress) &&
    existing.recipientAddress.toLowerCase() === callerAddress.toLowerCase();

  const { status, paidTxHash } = bodyParsed.data;

  if (status === "cancelled") {
    // Only the recipient may cancel
    if (!callerAddress) {
      return res.status(400).json({ error: "recipientAddress query param is required to cancel a request" });
    }
    if (!isAddress(callerAddress)) {
      return res.status(400).json({ error: "recipientAddress must be a valid Ethereum address" });
    }
    if (!isRecipientAuth) {
      return res.status(403).json({ error: "Not authorised to cancel this payment request" });
    }
  }

  if (status === "paid") {
    if (paidTxHash) {
      // Tx-proof path: verify on-chain that the tx succeeded and paid the recipient
      try {
        const receipt = await publicClient.getTransactionReceipt({ hash: paidTxHash as Hex });
        if (receipt.status !== "success") {
          return res.status(400).json({ error: "Transaction did not succeed on-chain" });
        }
        // Verify a USDC Transfer(to=recipientAddress) log exists in the receipt
        const recipientLc = existing.recipientAddress.toLowerCase();
        const hasTransferToRecipient = receipt.logs.some((log) => {
          if (log.address.toLowerCase() !== USDC_ADDRESS.toLowerCase()) return false;
          // Transfer event topic0 = keccak256("Transfer(address,address,uint256)")
          const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
          if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) return false;
          // topics[2] = "to" address, zero-padded to 32 bytes
          const toRaw = log.topics[2];
          if (!toRaw) return false;
          const to = "0x" + toRaw.slice(-40); // last 20 bytes
          return to.toLowerCase() === recipientLc;
        });
        if (!hasTransferToRecipient) {
          req.log.warn({ paidTxHash, recipient: existing.recipientAddress }, "tx does not contain USDC Transfer to recipient");
          return res.status(400).json({ error: "Transaction does not include a USDC payment to the recipient" });
        }
      } catch (rpcErr) {
        req.log.error({ err: rpcErr, paidTxHash }, "on-chain tx verification failed");
        return res.status(400).json({ error: "Could not verify transaction on-chain — check the hash and try again" });
      }
    } else {
      // No tx hash — only the recipient may self-mark as paid (off-band payment)
      if (!isRecipientAuth) {
        if (!callerAddress) {
          return res.status(400).json({ error: "Either paidTxHash or recipientAddress (for recipient-auth) is required" });
        }
        if (!isAddress(callerAddress)) {
          return res.status(400).json({ error: "recipientAddress must be a valid Ethereum address" });
        }
        return res.status(403).json({ error: "Not authorised to mark this payment request as paid without a transaction hash" });
      }
    }
  }

  // ── Apply update ──────────────────────────────────────────────────────────
  const updates: Record<string, unknown> = {};
  if (status)     updates.status     = status;
  if (paidTxHash) updates.paidTxHash = paidTxHash;
  if (status === "paid") updates.paidAt = new Date();

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
