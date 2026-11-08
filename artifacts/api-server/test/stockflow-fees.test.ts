import assert from "node:assert/strict";
import { after, afterEach, mock, test } from "node:test";
import { randomUUID } from "node:crypto";
import { encodeEventTopics } from "viem";
import { eq } from "drizzle-orm";
import { db, pool, stockflowQuotesTable, stockflowTradesTable } from "@workspace/db";
import { RecordStockflowTradeBody, RecordStockflowTradeResponse } from "@workspace/api-zod";
import { inspectPilotReceipt, pilotChain, pilotSwapData, pilotErc20Abi, PILOT_ROUTER, PILOT_FACTORY, PILOT_USDC, type PilotQuote } from "../src/lib/stockflow-market";

// Every chain method used here is mocked. These fixtures cannot submit a transaction.
const hash = `0x${"ab".repeat(32)}` as const, blockHash = `0x${"cd".repeat(32)}` as const;
const wallet = "0x1111111111111111111111111111111111111111";
const q: PilotQuote = {
  id: randomUUID(), chainId: 8453, wallet, stockAddress: "0x2222222222222222222222222222222222222222", symbol: "TEST",
  side: "buy", router: PILOT_ROUTER, factory: PILOT_FACTORY, pool: "0x3333333333333333333333333333333333333333",
  tokenIn: PILOT_USDC, tokenOut: "0x2222222222222222222222222222222222222222", tickSpacing: 100,
  decimalsIn: 6, decimalsOut: 18, amountIn: "1000000", amountOut: "10", minimumOut: "9",
  slippageBps: 100, priceImpactBps: 1, blockNumber: "1", deadline: 2000000000, expiresAt: "2030-01-01T00:00:00Z",
};
function chainMocks(status: "success" | "reverted", safe = 100n) {
  mock.method(pilotChain, "getTransaction", async () => ({
    from: wallet, to: PILOT_ROUTER, value: 0n, input: pilotSwapData(q),
  }));
  mock.method(pilotChain, "getTransactionReceipt", async () => ({
    transactionHash: hash, blockHash, blockNumber: 10n, status,
    logs: [{ address: q.tokenOut, topics: encodeEventTopics({
      abi: pilotErc20Abi, eventName: "Transfer", args: { from: q.pool as `0x${string}`, to: wallet },
    }), data: `0x${10n.toString(16).padStart(64, "0")}` }],
  }));
  mock.method(pilotChain, "getBlock", async () => ({ number: safe, hash: blockHash }));
  mock.method(pilotChain, "request", async () => ({
    transactionHash: hash, blockHash, blockNumber: "0xa", gasUsed: "0x20000000000001",
    effectiveGasPrice: "0x3", l1Fee: "0xc8", operatorFeeScalar: "0x2", operatorFeeConstant: "0x1",
    daFootprintGasScalar: "0x190",
  }));
  mock.method(pilotChain, "readContract", async () => { throw new Error("Unexpected contract read"); });
}
afterEach(() => mock.restoreAll());
after(() => pool.end());

test("server includes exact paid fees on successful, unsafe, and reverted receipts", async () => {
  for (const [status, safe, expected] of [["success", 100n, "confirmed"], ["success", 1n, "pending"], ["reverted", 100n, "failed"]] as const) {
    chainMocks(status, safe);
    const result = await inspectPilotReceipt(hash, q);
    assert.equal(result.status, expected);
    assert.deepEqual(result.networkFees, {
      executionWei: (9007199254740993n * 3n).toString(), l1DataWei: "200",
      operatorWei: (9007199254740993n * 2n * 100n + 1n).toString(),
      totalWei: (9007199254740993n * 203n + 201n).toString(),
    });
    mock.restoreAll();
  }
});
test("server can record a trade even when the supplemental fee read fails", async () => {
  chainMocks("success");
  mock.method(pilotChain, "request", async () => { throw new Error("fee RPC down"); });
  const result = await inspectPilotReceipt(hash, q);
  assert.equal(result.status, "confirmed");
  assert.deepEqual(result.networkFees, { executionWei: null, l1DataWei: null, operatorWei: null, totalWei: null });
});
test("a missing receipt is pending, with no actual fee", async () => {
  chainMocks("success");
  mock.method(pilotChain, "getTransactionReceipt", async () => {
    const e = new Error("not mined"); e.name = "TransactionReceiptNotFoundError"; throw e;
  });
  assert.deepEqual(await inspectPilotReceipt(hash, q), { status: "pending", amountOut: null, networkFees: null });
});
test("fees cannot make a non-matching swap eligible for history", async () => {
  chainMocks("success");
  mock.method(pilotChain, "getTransaction", async () => ({ from: wallet, to: wallet, value: 0n, input: pilotSwapData(q) }));
  await assert.rejects(inspectPilotReceipt(hash, q), /does not match/);
});
test("paid fee and reviewed estimate survive a database round trip without floating point", async () => {
  chainMocks("success");
  const result = await inspectPilotReceipt(hash, q);
  const reviewedSwapFee = { executionWei: "9007199254740993", l1DataWei: "42", operatorWei: null, totalWei: null };
  const input = RecordStockflowTradeBody.parse({ quoteId: q.id, hash, reviewedSwapFee, networkFees: { totalWei: "0" } });
  assert(!("networkFees" in input), "Clients cannot supply actual paid fees");
  const storedHash = `0x${randomUUID().replaceAll("-", "").repeat(2)}`;
  try {
    await db.insert(stockflowQuotesTable).values({ id: q.id, wallet, payload: q, expiresAt: new Date(q.expiresAt) });
    await db.insert(stockflowTradesTable).values({
      hash: storedHash, wallet, quoteId: q.id, symbol: q.symbol, side: q.side, ...result, reviewedSwapFee,
      amountIn: q.amountIn, decimalsIn: q.decimalsIn, decimalsOut: q.decimalsOut,
    });
    const [saved] = await db.select().from(stockflowTradesTable).where(eq(stockflowTradesTable.hash, storedHash));
    const response = RecordStockflowTradeResponse.parse({ ...saved, originalHash: storedHash, replacementHashes: [], createdAt: saved.createdAt.toISOString() });
    assert.deepEqual(response.networkFees, result.networkFees);
    assert.deepEqual(response.reviewedSwapFee, reviewedSwapFee);
  } finally {
    await db.delete(stockflowTradesTable).where(eq(stockflowTradesTable.hash, storedHash));
    await db.delete(stockflowQuotesTable).where(eq(stockflowQuotesTable.id, q.id));
  }
});
