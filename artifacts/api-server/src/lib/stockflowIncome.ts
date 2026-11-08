import { db, stockflowIncomeTable, paymentRequestsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { GetStockflowIncomeResponse } from "@workspace/api-zod";
import { TransactionReceiptNotFoundError, type Address, type Hex } from "viem";
import { basePublicClient } from "./rpc";
import { emptyIncome, extractIncome, reconcileIncome, TOKENS, TRANSFER, type ChainReceipt, type StockflowIncome } from "./stockflowIncomeLogic";

// Bounded discovery, never silently claim to have scanned full history.
export const SCAN_BLOCKS = 2000n;
const LOOKBACK = 43200n; // ~24h at Base's two-second block interval
const OVERLAP = 64n;
export class IncomeError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function readIncome(wallet: string): Promise<StockflowIncome> {
  const [row] = await db.select().from(stockflowIncomeTable).where(eq(stockflowIncomeTable.wallet, wallet));
  return row ? GetStockflowIncomeResponse.parse(row.ledger) : emptyIncome(wallet);
}

/** Row locks survive process boundaries. The cursor and all proposal decisions
 * are atomic with their receipt set; RPC failure rolls the entire sync back. */
export async function changeIncome(wallet: string, change: (s: StockflowIncome) => Promise<StockflowIncome>): Promise<StockflowIncome> {
  return db.transaction(async tx => {
    await tx.insert(stockflowIncomeTable).values({ wallet, ledger: emptyIncome(wallet) }).onConflictDoNothing();
    const [row] = await tx.select().from(stockflowIncomeTable).where(eq(stockflowIncomeTable.wallet, wallet)).for("update");
    const next = GetStockflowIncomeResponse.parse(await change(GetStockflowIncomeResponse.parse(row!.ledger)));
    await tx.update(stockflowIncomeTable).set({ ledger: next, updatedAt: new Date() }).where(eq(stockflowIncomeTable.wallet, wallet));
    return next;
  });
}

// Testable, strictly read-only dependency boundary: no wallet/relayer client.
export type IncomeChain = Pick<typeof basePublicClient, "getBlockNumber" | "getBlock" | "getLogs" | "getTransactionReceipt">;
export async function syncIncome(
  state: StockflowIncome,
  requests: { id: string; paidTxHash: string | null; amount: string; token: string }[],
  txHash?: string,
  chain: IncomeChain = basePublicClient,
): Promise<StockflowIncome> {
  const head = await chain.getBlockNumber({ cacheTime: 0 });
  const start = state.scanStartBlock === null || BigInt(state.scanStartBlock) > head
    ? (head > LOOKBACK ? head - LOOKBACK : 0n) : BigInt(state.scanStartBlock);
  const cursor = state.scannedThroughBlock === null ? start : BigInt(state.scannedThroughBlock);
  const cursorBlock = state.scannedThroughBlock && cursor <= head ? await chain.getBlock({ blockNumber: cursor }) : null;
  const reorg = cursor > head || (state.scannedBlockHash && cursorBlock?.hash !== state.scannedBlockHash);
  const rewind = reorg ? start : cursor;
  const from = rewind > start + OVERLAP ? rewind - OVERLAP : start;
  const to = from + SCAN_BLOCKS - 1n < head ? from + SCAN_BLOCKS - 1n : head;
  const scanCheckpoint = await chain.getBlock({ blockNumber: to });
  const logs = await chain.getLogs({
    address: Object.keys(TOKENS) as Address[], event: TRANSFER,
    args: { to: state.wallet as Address }, fromBlock: from, toBlock: to, strict: true,
  });
  const hashes = new Set([
    ...state.receipts.map(r => r.txHash), ...logs.map(l => l.transactionHash),
    ...requests.map(r => r.paidTxHash), txHash,
  ].filter((h): h is string => !!h).map(h => h.toLowerCase()));
  if (hashes.size > 5000) throw new IncomeError(503, "Income history exceeds the safety limit. No cursor or proposal changes were saved.");
  const verified = [];
  const blocks = new Map<string, Awaited<ReturnType<IncomeChain["getBlock"]>>>();
  for (const hash of hashes) {
    let receipt;
    try { receipt = await chain.getTransactionReceipt({ hash: hash as Hex }); }
    catch (e) {
      if (e instanceof TransactionReceiptNotFoundError || (e instanceof Error && e.name === "TransactionReceiptNotFoundError")) {
        if (hash === txHash?.toLowerCase()) throw new IncomeError(400, "Transaction was not found on Base.");
        continue; // removed/missing, NOT a generic RPC error
      }
      throw e;
    }
    const blockKey = receipt.blockNumber.toString();
    let block = blocks.get(blockKey);
    if (!block) { block = await chain.getBlock({ blockNumber: receipt.blockNumber }); blocks.set(blockKey, block); }
    const incoming = extractIncome(state.wallet, receipt as ChainReceipt, block.hash!, block.timestamp, head);
    if (hash === txHash?.toLowerCase() && incoming.length === 0) throw new IncomeError(400, "Transaction has no successful incoming USDC or EURC transfer to this wallet on Base.");
    for (const event of incoming) {
      // A request's "paid" flag is insufficient; its USDC transfer must cover
      // the request. Manual marks and ETH requests never become verified links.
      event.paymentRequestIds = requests.filter(r => r.paidTxHash?.toLowerCase() === hash && r.token === "USDC"
        && event.token === "USDC" && /^\d+(\.\d{1,6})?$/.test(r.amount)
        && BigInt(event.amountAtomic) >= BigInt(r.amount.split(".")[0]!) * 1000000n + BigInt((r.amount.split(".")[1] ?? "").padEnd(6, "0")))
        .map(r => r.id);
      verified.push(event);
    }
  }
  // Detect chain movement during a long scan. Do not commit a mixed-fork view.
  const checkpoint = await chain.getBlock({ blockNumber: to });
  for (const [number, block] of blocks) {
    const current = await chain.getBlock({ blockNumber: BigInt(number) });
    if (current.hash !== block.hash) throw new IncomeError(503, "Base reorganized during verification. Retry synchronization.");
  }
  if (!checkpoint.hash || checkpoint.hash !== scanCheckpoint.hash) throw new IncomeError(503, "Base reorganized during scanning. Retry synchronization.");
  const next = reconcileIncome(state, verified, Date.now());
  next.scanStartBlock = start.toString(); next.scannedThroughBlock = to.toString();
  next.headBlock = head.toString(); next.syncedAt = new Date().toISOString();
  next.scannedBlockHash = checkpoint.hash;
  return next;
}

export async function walletPaymentRequests(wallet: string) {
  return db.select({ id: paymentRequestsTable.id, paidTxHash: paymentRequestsTable.paidTxHash,
    amount: paymentRequestsTable.amount, token: paymentRequestsTable.token })
    .from(paymentRequestsTable).where(and(eq(paymentRequestsTable.recipientAddress, wallet), eq(paymentRequestsTable.status, "paid")));
}
