import { Router, type IRouter, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import {
  GetStockflowIncomeParams, GetStockflowIncomeQueryParams, GetStockflowIncomeResponse,
  SetStockflowIncomePolicyBody, SyncStockflowIncomeBody, ReviewStockflowProposalBody, ReviewStockflowProposalParams,
} from "@workspace/api-zod";
import { verifyOwnershipProof } from "../lib/walletProof";
import { readIncome, changeIncome, syncIncome, walletPaymentRequests, IncomeError } from "../lib/stockflowIncome";
import { policyError } from "../lib/stockflowIncomeLogic";

const router: IRouter = Router();
router.use("/stockflow/income", rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: "draft-7", legacyHeaders: false }));

async function authorize(req: Request, res: Response, body: { signature: string; timestamp: number }, action = "stockflow-income", fields: Record<string, string> = {}) {
  const params = GetStockflowIncomeParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "A valid wallet is required." }); return null; }
  const wallet = params.data.wallet.toLowerCase();
  const proof = await verifyOwnershipProof({ address: wallet, ...body, action, fields, singleUse: action !== "stockflow-income" });
  if (!proof.ok) { res.status(proof.status).json({ error: proof.error }); return null; }
  res.setHeader("Cache-Control", "no-store");
  return wallet;
}
function failure(req: Request, res: Response, error: unknown) {
  req.log.warn({ err: error }, "StockFlow income operation failed");
  res.status(error instanceof IncomeError ? error.status : 503).json({
    error: error instanceof IncomeError ? error.message : "Income could not be verified or saved. Nothing changed; retry shortly.",
  });
}
router.get("/stockflow/income/:wallet", async (req, res): Promise<void> => {
  const input = GetStockflowIncomeQueryParams.safeParse(req.query);
  if (!input.success) { res.status(400).json({ error: "Wallet proof is required." }); return; }
  const wallet = await authorize(req, res, input.data);
  if (!wallet) return;
  try { res.json(GetStockflowIncomeResponse.parse(await readIncome(wallet))); }
  catch (e) { failure(req, res, e); }
});
router.put("/stockflow/income/:wallet", async (req, res): Promise<void> => {
  const input = SetStockflowIncomePolicyBody.safeParse(req.body);
  if (!input.success) { res.status(400).json({ error: "Invalid income policy." }); return; }
  const { policy } = input.data;
  const invalid = policy && policyError(policy, Date.now());
  if (invalid) { res.status(400).json({ error: invalid }); return; }
  const wallet = await authorize(req, res, input.data, "stockflow-policy", { policy: JSON.stringify(policy) });
  if (!wallet) return;
  try {
    res.json(await changeIncome(wallet, async state => {
      if (JSON.stringify(state.policy) === JSON.stringify(policy)) return state;
      state.policy = policy;
      // Updating/pausing the source policy invalidates unreviewed proposals;
      // immutable reviewed/dismissed history remains visible.
      for (const proposal of state.proposals) if (proposal.status === "pending_review") {
        proposal.status = "invalidated"; proposal.reason = "Income policy changed or was paused. This proposal is no longer reviewable.";
      }
      return state;
    }));
  } catch (e) { failure(req, res, e); }
});
router.post("/stockflow/income/:wallet/sync", async (req, res): Promise<void> => {
  const input = SyncStockflowIncomeBody.safeParse(req.body);
  if (!input.success) { res.status(400).json({ error: "Invalid synchronization request." }); return; }
  const wallet = await authorize(req, res, input.data);
  if (!wallet) return;
  try {
    const requests = await walletPaymentRequests(wallet);
    res.json(await changeIncome(wallet, state => syncIncome(state, requests, input.data.txHash)));
  } catch (e) { failure(req, res, e); }
});
router.patch("/stockflow/income/:wallet/proposals/:id", async (req, res): Promise<void> => {
  const input = ReviewStockflowProposalBody.safeParse(req.body);
  const params = ReviewStockflowProposalParams.safeParse(req.params);
  if (!input.success || !params.success) { res.status(400).json({ error: "Invalid review." }); return; }
  const { id } = params.data;
  const { status } = input.data;
  const wallet = await authorize(req, res, input.data, "stockflow-review", { id, status });
  if (!wallet) return;
  try {
    const requests = await walletPaymentRequests(wallet);
    res.json(await changeIncome(wallet, async state => {
      // A persisted "confirmed" flag is not sufficient at review time.
      const current = await syncIncome(state, requests);
      const proposal = current.proposals.find(p => p.id === id);
      if (!proposal) throw new IncomeError(404, "Proposal not found for this wallet.");
      if (proposal.status !== "pending_review") {
        // Keep reorg invalidation even when this decision can no longer apply.
        return current;
      }
      if (!current.policy || policyError(current.policy, Date.now())) {
        proposal.status = "invalidated"; proposal.reason = "Income policy has expired or been paused.";
      } else {
        proposal.status = status; proposal.reviewedAt = new Date().toISOString();
      }
      return current;
    }));
  } catch (e) { failure(req, res, e); }
});
export default router;
