import { describe, expect, it } from "vitest";
import type { StockflowStock, StockflowTradeQuote } from "@workspace/api-client-react";
import { STOCKFLOW_FACTORY, STOCKFLOW_ROUTER, STOCKFLOW_USDC, validatedTradeParams } from "../src/lib/stockflow-trade-contract";
const wallet = "0x0000000000000000000000000000000000000001";
const stock: StockflowStock = {
  address: "0xb20000000000000000000078ee7ce2fE4908108C", symbol: "NVDAc", name: "Nvidia", decimals: 8,
  multiplier: 1, referencePrice: null, priceUpdatedAt: null, iconUrl: null, pausedFeatures: [],
};
function quote(): StockflowTradeQuote {
  return {
    id: "test", wallet, stockAddress: stock.address, symbol: stock.symbol, side: "buy",
    chainId: 8453, factory: STOCKFLOW_FACTORY, router: STOCKFLOW_ROUTER,
    pool: "0x853F5f1B92b16714Fe6CDA67CAad0856B83C7ab9", tickSpacing: 10,
    tokenIn: STOCKFLOW_USDC, tokenOut: stock.address, decimalsIn: 6, decimalsOut: 8,
    amountIn: "100000", amountOut: "50000", minimumOut: "49750",
    slippageBps: 50, priceImpactBps: 3, blockNumber: "100",
    expiresAt: new Date(Date.now() + 45_000).toISOString(), deadline: Math.floor(Date.now() / 1000) + 60,
  };
}
describe("mainnet trade transaction validation", () => {
  it("uses only the selected stock, connected recipient and exact integer amounts", () => {
    const p = validatedTradeParams(quote(), wallet, stock);
    expect(p.recipient).toBe(wallet); expect(p.amountIn).toBe(100000n);
    expect(p.amountOutMinimum).toBe(49750n); expect(p.sqrtPriceLimitX96).toBe(0n);
  });
  it("rejects wallet, router, network, factory, asset, pool and decimal substitution", () => {
    for (const change of [
      { wallet: stock.address }, { router: wallet }, { factory: wallet }, { chainId: 84532 },
      { stockAddress: wallet }, { tokenOut: wallet }, { tokenIn: wallet },
      { pool: "0x0000000000000000000000000000000000000000" }, { decimalsOut: 18 }, { tickSpacing: 999 },
    ]) expect(() => validatedTradeParams({ ...quote(), ...change }, wallet, stock)).toThrow();
  });
  it("rejects expiry, excessive slippage/impact, zero minimum and malformed amounts", () => {
    for (const change of [
      { expiresAt: new Date(Date.now() - 1).toISOString() }, { deadline: 1 },
      { slippageBps: 101 }, { priceImpactBps: 501 }, { minimumOut: "0" },
      { minimumOut: "49000" }, { amountIn: "-1" }, { amountIn: "1e6" },
      { amountIn: "0" }, { amountIn: "100000001" },
    ]) expect(() => validatedTradeParams({ ...quote(), ...change }, wallet, stock)).toThrow();
  });
});
