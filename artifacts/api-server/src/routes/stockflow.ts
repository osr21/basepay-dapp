import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import { isAddress, type Address } from "viem";
import { ListStockflowStocksResponse, GetStockflowPositionsResponse } from "@workspace/api-zod";
import { getStockflowCatalogue, getStockflowBalances } from "../lib/stockflow";

const router: IRouter = Router();
router.get("/stockflow/stocks", async (req, res) => {
  try { res.json(ListStockflowStocksResponse.parse(await getStockflowCatalogue())); }
  catch (error) {
    req.log.warn({ err: error }, "StockFlow catalogue unavailable");
    res.status(503).json({ error: "Live stock reference data is unavailable. Try again shortly." });
  }
});
router.get("/stockflow/positions/:wallet", rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: "draft-7", legacyHeaders: false }), async (req, res) => {
  const wallet = req.params.wallet;
  if (typeof wallet !== "string" || !isAddress(wallet, { strict: false })) {
    res.status(400).json({ error: "A valid EVM wallet address is required." }); return;
  }
  try { res.json(GetStockflowPositionsResponse.parse(await getStockflowBalances(wallet as Address))); }
  catch (error) {
    req.log.warn({ err: error }, "StockFlow balances unavailable");
    res.status(503).json({ error: "Base balances could not be read. No zero balances were inferred." });
  }
});
export default router;
