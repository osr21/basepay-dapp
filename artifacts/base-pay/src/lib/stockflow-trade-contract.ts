import { isAddress, parseAbi, type Address } from "viem";
import type { StockflowStock, StockflowTradeQuote } from "@workspace/api-client-react";

// Aerodrome's current Gauges V3 deployment, checked against its official
// slipstream README and the router/quoter factory() values on Base mainnet.
export const STOCKFLOW_ROUTER = "0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F" as const;
export const STOCKFLOW_FACTORY = "0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef" as const;
export const STOCKFLOW_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
export const stockflowErc20Abi = parseAbi([
  "function approve(address spender,uint256 amount) returns(bool)",
  "function allowance(address owner,address spender) view returns(uint256)",
  "function balanceOf(address owner) view returns(uint256)",
]);
export const stockflowSwapAbi = [{
  type: "function", name: "exactInputSingle", stateMutability: "payable",
  inputs: [{ name: "params", type: "tuple", components: [
    { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" },
    { name: "tickSpacing", type: "int24" }, { name: "recipient", type: "address" },
    { name: "deadline", type: "uint256" }, { name: "amountIn", type: "uint256" },
    { name: "amountOutMinimum", type: "uint256" }, { name: "sqrtPriceLimitX96", type: "uint160" },
  ] }], outputs: [{ name: "amountOut", type: "uint256" }],
}] as const;

export function validatedTradeParams(q: StockflowTradeQuote, wallet: Address, stock: StockflowStock, now = Date.now()) {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (q.chainId !== 8453 || !same(q.wallet, wallet) || !same(q.stockAddress, stock.address) ||
      !same(q.router, STOCKFLOW_ROUTER) || !same(q.factory, STOCKFLOW_FACTORY) ||
      !isAddress(q.pool) || /^0x0{40}$/i.test(q.pool) || ![1, 10, 50, 100, 200, 2000].includes(q.tickSpacing)) {
    throw new Error("Quote network, wallet, asset or approved venue does not match.");
  }
  if (q.side !== "buy" && q.side !== "sell") throw new Error("Invalid trade direction.");
  const buy = q.side === "buy";
  if (!same(q.tokenIn, buy ? STOCKFLOW_USDC : stock.address) ||
      !same(q.tokenOut, buy ? stock.address : STOCKFLOW_USDC) ||
      q.decimalsIn !== (buy ? 6 : stock.decimals) || q.decimalsOut !== (buy ? stock.decimals : 6)) {
    throw new Error("Quote token pair does not match the selected stock.");
  }
  const expiry = Date.parse(q.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= now || expiry > now + 90_000 ||
      !Number.isSafeInteger(q.deadline) || q.deadline * 1000 <= now ||
      q.deadline * 1000 > now + 120_000) throw new Error("Quote expired. Request a fresh quote.");
  if (!Number.isInteger(q.slippageBps) || q.slippageBps < 10 || q.slippageBps > 100 ||
      !Number.isInteger(q.priceImpactBps) || q.priceImpactBps < 0 || q.priceImpactBps > 500 ||
      ![q.amountIn, q.amountOut, q.minimumOut].every(x => /^[0-9]{1,78}$/.test(x))) {
    throw new Error("Quote amounts or safety limits are invalid.");
  }
  const amountIn = BigInt(q.amountIn), out = BigInt(q.amountOut), min = BigInt(q.minimumOut);
  if (amountIn <= 0n || amountIn >= 2n ** 256n || out <= 0n || out >= 2n ** 256n ||
      min <= 0n || min !== out * BigInt(10_000 - q.slippageBps) / 10_000n) {
    throw new Error("Quote minimum output is invalid.");
  }
  if ((buy ? amountIn : out) > 100_000000n) throw new Error("Quote exceeds the 100 USDC pilot limit.");
  return {
    tokenIn: q.tokenIn as Address, tokenOut: q.tokenOut as Address,
    tickSpacing: q.tickSpacing, recipient: wallet, deadline: BigInt(q.deadline),
    amountIn, amountOutMinimum: min, sqrtPriceLimitX96: 0n,
  };
}
