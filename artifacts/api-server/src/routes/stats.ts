import { Router } from "express";
import { db, paymentRequestsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
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

  const paid = allRequests.filter(r => r.status === "paid");
  const pending = allRequests.filter(r => r.status === "pending");

  const totalAmountRequested = allRequests
    .reduce((sum, r) => sum + parseFloat(r.amount || "0"), 0)
    .toFixed(2);

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
    totalRequestsPaid: paid.length,
    totalAmountRequested,
    pendingRequests: pending.length,
    recentActivity,
  });
});

export default router;
