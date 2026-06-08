import { Router } from "express";
import { db, paymentRequestsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { GetStatsParams } from "@workspace/api-zod";

const router = Router();

router.get("/stats/:address", async (req, res) => {
  const parsed = GetStatsParams.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid params" });
  }
  const { address } = parsed.data;

  const allRequests = await db
    .select()
    .from(paymentRequestsTable)
    .where(eq(paymentRequestsTable.recipientAddress, address));

  const paid    = allRequests.filter(r => r.status === "paid");
  const pending = allRequests.filter(r => r.status === "pending");

  // Accumulate in integer micro-units (6 decimal places) to avoid floating-point
  // drift when summing many amounts like "0.10" + "0.20" = 0.30000000000000004.
  const totalAmountMicro = allRequests.reduce((sum, r) => {
    const raw = r.amount ?? "0";
    // Amounts are stored as decimal strings like "10.50" with up to 6 dp.
    const [intPart = "0", fracPart = ""] = raw.split(".");
    const frac6 = fracPart.padEnd(6, "0").slice(0, 6);
    const micro = BigInt(intPart) * 1_000_000n + BigInt(frac6 || "0");
    return Number.isNaN(Number(raw)) ? sum : sum + micro;
  }, 0n);

  // Convert back to a decimal string with 2 dp for display
  const totalDollars  = totalAmountMicro / 1_000_000n;
  const totalCentsRem = (totalAmountMicro % 1_000_000n * 100n) / 1_000_000n;
  const totalAmountRequested = `${totalDollars}.${String(totalCentsRem).padStart(2, "0")}`;

  const recentActivity = [...allRequests]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, 10)
    .map(r => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
      paidAt: r.paidAt ? r.paidAt.toISOString() : null,
    }));

  return res.json({
    totalRequestsCreated: allRequests.length,
    totalRequestsPaid:    paid.length,
    totalAmountRequested,
    pendingRequests:      pending.length,
    recentActivity,
  });
});

export default router;
