import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { randomUUID } from "node:crypto";
import { and, desc, eq, ne } from "drizzle-orm";
import { isAddress, type Address, type Hash } from "viem";
import {
  db, stockflowPilotTable, stockflowPilotAuditTable, stockflowQuotesTable, stockflowTradesTable,
} from "@workspace/db";
import * as api from "@workspace/api-zod";
import {
  PilotError, pilotIdentity, pilotSession, requirePilotAdmin, requirePilotWallet,
  createPilotChallenge, authenticatePilot, serializeParticipant, normalizePilotCountry, validatePilotApprovalCountry,
  PILOT_COOKIE, PILOT_COOKIE_PATH,
} from "../lib/stockflow-pilot-access";
import {
  quotePilotTrade, pilotChain, pilotErc20Abi, PILOT_ROUTER, pilotSwapAbi, pilotSwapParams,
  reconcilePilotTrade, type PilotQuote, type PilotTracking,
} from "../lib/stockflow-market";

import { deserializeFee, serializeFee, type StoredTransactionFee } from "@workspace/base-fees";

const router: IRouter = Router();
router.use(["/stockflow/pilot", "/stockflow/trading"], rateLimit({
  windowMs: 60_000, limit: 60, standardHeaders: "draft-7", legacyHeaders: false,
}));
// Strict same-site cookies plus explicit Origin checking for browser mutations.
// Requests without Origin still need a wallet session and one-use signature.
router.use(["/stockflow/pilot", "/stockflow/trading"], (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  const origin = req.headers.origin;
  if (req.method !== "GET" && origin) {
    try {
      if (new URL(origin).host !== req.get("host")) { res.status(403).json({ error: "Cross-origin trading request rejected." }); return; }
    } catch { res.status(403).json({ error: "Invalid request origin." }); return; }
  }
  next();
});
const wrap = (fn: (req: Request, res: Response) => Promise<void>) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try { await fn(req, res); }
    catch (error) {
      if (error instanceof PilotError) { res.status(error.status).json({ error: error.message }); return; }
      if (error instanceof Error && error.name === "ZodError") { res.status(400).json({ error: "Invalid request or response data." }); return; }
      req.log.warn({ err: error }, "StockFlow pilot request failed");
      next(error);
    }
  };
async function storedQuote(id: string, wallet: string, fresh = true) {
  const [row] = await db.select().from(stockflowQuotesTable).where(and(eq(stockflowQuotesTable.id, id), eq(stockflowQuotesTable.wallet, wallet)));
  if (!row) throw new PilotError(404, "Quote not found for this wallet.");
  if (fresh && row.expiresAt.getTime() <= Date.now()) throw new PilotError(409, "Quote expired. Request a new quote before any further approval or trade.");
  return api.CreateStockflowTradeQuoteResponse.parse(row.payload) as PilotQuote;
}
router.get("/stockflow/pilot/session", wrap(async (req, res) => {
  res.json(api.GetStockflowPilotSessionResponse.parse(await pilotSession(await pilotIdentity(req))));
}));
router.post("/stockflow/pilot/challenge", rateLimit({ windowMs: 60_000, limit: 10, legacyHeaders: false }), wrap(async (req, res) => {
  const data = api.CreateStockflowPilotChallengeBody.parse(req.body);
  res.json(api.CreateStockflowPilotChallengeResponse.parse(await createPilotChallenge(data.address, req.get("host") ?? "BasePay")));
}));
router.post("/stockflow/pilot/auth", rateLimit({ windowMs: 60_000, limit: 10, legacyHeaders: false }), wrap(async (req, res) => {
  const data = api.AuthenticateStockflowPilotBody.parse(req.body);
  res.json(api.AuthenticateStockflowPilotResponse.parse(await authenticatePilot(data.address, data.challengeId, data.signature, res)));
}));
router.post("/stockflow/pilot/logout", wrap(async (_req, res) => {
  res.clearCookie(PILOT_COOKIE, { path: PILOT_COOKIE_PATH, secure: true, httpOnly: true, sameSite: "strict" });
  res.json({ success: true });
}));
router.get("/stockflow/pilot/participants", wrap(async (req, res) => {
  await requirePilotAdmin(req);
  const rows = await db.select().from(stockflowPilotTable).orderBy(desc(stockflowPilotTable.updatedAt));
  res.json(api.ListStockflowPilotParticipantsResponse.parse(rows.map(serializeParticipant)));
}));
router.post("/stockflow/pilot/participants", wrap(async (req, res) => {
  const actor = await requirePilotAdmin(req);
  const data = api.SaveStockflowPilotParticipantBody.parse(req.body);
  const wallet = data.wallet.toLowerCase();
  if (!isAddress(wallet) || /^0x0{40}$/.test(wallet)) throw new PilotError(400, "A valid nonzero wallet is required.");
  if (!Number.isInteger(data.days) || data.days < 1 || data.days > 30) throw new PilotError(400, "Approval must expire in 1–30 days.");
  const countryCode = data.approved
    ? validatePilotApprovalCountry(data.countryCode, data.reviewConfirmed)
    : normalizePilotCountry(data.countryCode);
  const now = new Date();
  const row = await db.transaction(async tx => {
    const [prior] = await tx.select().from(stockflowPilotTable).where(eq(stockflowPilotTable.wallet, wallet));
    if (!data.approved && !prior) throw new PilotError(404, "Participant does not exist.");
    const values = {
      wallet, countryCode: data.approved ? countryCode : prior!.countryCode,
      approved: data.approved, expiresAt: data.approved ? new Date(now.getTime() + data.days * 86_400_000) : prior!.expiresAt,
      reviewedBy: actor, updatedAt: now,
    };
    const [saved] = await tx.insert(stockflowPilotTable).values(values).onConflictDoUpdate({
      target: stockflowPilotTable.wallet, set: values,
    }).returning();
    await tx.insert(stockflowPilotAuditTable).values({
      id: randomUUID(), wallet, actor,
      decision: { previous: prior ? serializeParticipant(prior) : null, next: serializeParticipant(saved!), reviewConfirmed: data.approved && data.reviewConfirmed },
    });
    return saved!;
  });
  res.json(api.SaveStockflowPilotParticipantResponse.parse(serializeParticipant(row)));
}));
router.post("/stockflow/trading/quote", rateLimit({ windowMs: 60_000, limit: 10, legacyHeaders: false }), wrap(async (req, res) => {
  const wallet = await requirePilotWallet(req, true);
  const data = api.CreateStockflowTradeQuoteBody.parse(req.body);
  let quote: PilotQuote;
  try { quote = await quotePilotTrade(wallet as Address, data); }
  catch (err) { throw new PilotError(422, err instanceof Error ? err.message : "Live quote unavailable."); }
  // An operator may revoke access while RPC calls are in flight.
  await requirePilotWallet(req, true);
  await db.insert(stockflowQuotesTable).values({
    id: quote.id, wallet, payload: quote, expiresAt: new Date(quote.expiresAt),
  });
  res.json(api.CreateStockflowTradeQuoteResponse.parse(quote));
}));
router.post("/stockflow/trading/prepare", wrap(async (req, res) => {
  const wallet = await requirePilotWallet(req, true);
  const { quoteId } = api.PrepareStockflowTradeBody.parse(req.body);
  const quote = await storedQuote(quoteId, wallet);
  const [tracked] = await db.select().from(stockflowTradesTable).where(and(
    eq(stockflowTradesTable.quoteId, quoteId), eq(stockflowTradesTable.wallet, wallet),
  )).limit(1);
  if (tracked) throw new PilotError(409, "This quote already has a submitted swap. Reconcile its history; do not resend.");
  const [balance, allowance] = await Promise.all([
    pilotChain.readContract({ address: quote.tokenIn as Address, abi: pilotErc20Abi, functionName: "balanceOf", args: [wallet as Address] }),
    pilotChain.readContract({ address: quote.tokenIn as Address, abi: pilotErc20Abi, functionName: "allowance", args: [wallet as Address, PILOT_ROUTER] }),
  ]);
  if (balance < BigInt(quote.amountIn)) throw new PilotError(422, "Insufficient input-token balance. No transaction was submitted.");
  const approvalRequired = allowance < BigInt(quote.amountIn);
  if (!approvalRequired) {
    try {
      await pilotChain.simulateContract({
        address: PILOT_ROUTER, abi: pilotSwapAbi, functionName: "exactInputSingle",
        args: [pilotSwapParams(quote)], account: wallet as Address,
      });
    } catch { throw new PilotError(422, "Trade simulation failed. Quote, token policy, balance or liquidity may have changed; no trade was sent."); }
  }
  await storedQuote(quoteId, wallet);
  await requirePilotWallet(req, true);
  res.json(api.PrepareStockflowTradeResponse.parse({
    quote, balance: balance.toString(), allowance: allowance.toString(), approvalRequired, simulated: !approvalRequired,
  }));
}));
const tradeResponse = (row: typeof stockflowTradesTable.$inferSelect, tracking?: PilotTracking) => ({
  hash: row.hash, quoteId: row.quoteId, symbol: row.symbol, side: row.side, status: row.status,
  originalHash: tracking?.originalHash ?? row.hash, replacementHashes: tracking?.hashes ?? [],
  amountIn: row.amountIn, amountOut: row.amountOut, decimalsIn: row.decimalsIn,
  networkFees: row.networkFees, reviewedSwapFee: row.reviewedSwapFee,
  decimalsOut: row.decimalsOut, createdAt: row.createdAt.toISOString(),
});
// Serialize by stored quote. Concurrent history polls/retries cannot create an
// original and a replacement as two orders, or overwrite another wallet's row.
async function reconcileStoredTrade(wallet: string, quoteId: string, hash: Hash, hints: Hash[] = [], reviewedSwapFee?: StoredTransactionFee | null) {
  return db.transaction(async tx => {
    const [stored] = await tx.select().from(stockflowQuotesTable)
      .where(and(eq(stockflowQuotesTable.id, quoteId), eq(stockflowQuotesTable.wallet, wallet))).for("update");
    if (!stored) throw new PilotError(404, "Quote not found for this wallet.");
    const quote = api.CreateStockflowTradeQuoteResponse.parse(stored.payload) as PilotQuote;
    const prior = (stored.payload as PilotQuote & { tracking?: PilotTracking }).tracking;
    const [previous] = await tx.select().from(stockflowTradesTable).where(and(
      eq(stockflowTradesTable.wallet, wallet), eq(stockflowTradesTable.quoteId, quoteId),
    )).limit(1);
    const { tracking, ...result } = await reconcilePilotTrade(quote, hash, hints, prior);
    const normalized = {
      ...result, hash: result.hash.toLowerCase(),
      // Preserve the original client review even when reconciliation changes the
      // stored hash. Never accept actual paid fees from the browser.
      reviewedSwapFee: previous ? previous.reviewedSwapFee : reviewedSwapFee ? serializeFee(deserializeFee(reviewedSwapFee)) : null,
    };
    const [saved] = await tx.insert(stockflowTradesTable).values({
      wallet, quoteId, symbol: quote.symbol, side: quote.side, ...normalized,
      amountIn: quote.amountIn, decimalsIn: quote.decimalsIn, decimalsOut: quote.decimalsOut,
      createdAt: previous?.createdAt,
    }).onConflictDoUpdate({
      target: stockflowTradesTable.hash, set: normalized,
      setWhere: and(eq(stockflowTradesTable.wallet, wallet), eq(stockflowTradesTable.quoteId, quoteId)),
    }).returning();
    if (!saved) throw new PilotError(409, "Transaction is already recorded against a different quote.");
    await tx.delete(stockflowTradesTable).where(and(
      eq(stockflowTradesTable.wallet, wallet), eq(stockflowTradesTable.quoteId, quoteId), ne(stockflowTradesTable.hash, saved.hash),
    ));
    await tx.update(stockflowQuotesTable).set({ payload: { ...quote, tracking } }).where(eq(stockflowQuotesTable.id, quoteId));
    return tradeResponse(saved, tracking);
  });
}
router.post("/stockflow/trading/history", wrap(async (req, res) => {
  const wallet = await requirePilotWallet(req); // Revoked users can reconcile old transactions.
  const data = api.RecordStockflowTradeBody.parse(req.body);
  try {
    const saved = await reconcileStoredTrade(wallet, data.quoteId, data.hash.toLowerCase() as Hash, data.replacementHashes as Hash[] | undefined, data.reviewedSwapFee);
    res.json(api.RecordStockflowTradeResponse.parse(saved));
  } catch (err) {
    if (err instanceof PilotError) throw err;
    throw new PilotError(422, err instanceof Error ? err.message : "Transaction not yet verified. Keep its hash and retry; do not send another trade.");
  }
}));
router.get("/stockflow/trading/history", wrap(async (req, res) => {
  const wallet = await requirePilotWallet(req);
  const rows = await db.select({ trade: stockflowTradesTable, payload: stockflowQuotesTable.payload }).from(stockflowTradesTable)
    .innerJoin(stockflowQuotesTable, eq(stockflowTradesTable.quoteId, stockflowQuotesTable.id)).where(eq(stockflowTradesTable.wallet, wallet))
    .orderBy(desc(stockflowTradesTable.createdAt)).limit(50);
  const results = rows.map(({ trade, payload }) => tradeResponse(trade, (payload as { tracking?: PilotTracking }).tracking));
  // Prioritize outcome reconciliation, then backfill old / incomplete fee
  // records. A temporary fee RPC failure must not become permanent after safe
  // confirmation. Never let backfills consume pending trades' reconciliation.
  const pendingRows = results.filter(r => r.status === "pending").slice(0, 5);
  const feeRows = results.filter(r => r.status !== "pending" && (!r.networkFees || r.networkFees.totalWei === null))
    .slice(0, 5 - pendingRows.length);
  await Promise.all([...pendingRows, ...feeRows].map(async row => {
    try {
      const result = await reconcileStoredTrade(wallet, row.quoteId, row.originalHash as Hash);
      Object.assign(row, result);
    } catch (err) { req.log.warn({ err, hash: row.hash }, "Pending stock trade could not be reconciled"); }
  }));
  res.json(api.ListStockflowTradeHistoryResponse.parse(results));
}));
export default router;
