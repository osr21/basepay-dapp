import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics, TransactionReceiptNotFoundError, verifyMessage, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { pool } from "../../lib/db/src/index";
import {
  CONFIRMATIONS, TOKENS, TRANSFER, emptyIncome, extractIncome, reconcileIncome, policyError,
  type ChainReceipt, type StockflowIncomePolicy,
} from "../../artifacts/api-server/src/lib/stockflowIncomeLogic";
import { changeIncome, readIncome, syncIncome, type IncomeChain } from "../../artifacts/api-server/src/lib/stockflowIncome";
import { buildOwnershipMessage, verifyOwnershipProof } from "../../artifacts/api-server/src/lib/walletProof";
import { basePublicClient } from "../../artifacts/api-server/src/lib/rpc";
import { SetStockflowIncomePolicyBody } from "../../lib/api-zod/src/index";

const wallet = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
const other = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
const sender = "0x1111111111111111111111111111111111111111";
const hash = `0x${"ab".repeat(32)}` as Hex;
const blockHash = `0x${"cd".repeat(32)}` as Hex;
const usdc = Object.keys(TOKENS)[0]!;
const eurc = Object.keys(TOKENS)[1]!;
const now = Date.now();
const policy: StockflowIncomePolicy = { id: "core", name: "Core", incomePct: 50, maxPerPurchase: 30, dailyMax: 50,
  expiresAt: now + 86400000, status: "active", createdAt: now, updatedAt: now,
  allocations: [{ address: sender, symbol: "AAA", weight: 60 }, { address: other, symbol: "BBB", weight: 40 }] };
const log = (value = 100000000n, address = usdc, to = wallet, index = 3) => ({
  address, logIndex: index, topics: encodeEventTopics({ abi: [TRANSFER], args: { from: sender, to: to as Hex } }) as Hex[],
  data: encodeAbiParameters([{ type: "uint256" }], [value]),
});
const receipt = (override: Partial<ChainReceipt> = {}): ChainReceipt => ({
  status: "success", transactionHash: hash, blockNumber: 100n, blockHash, logs: [log()], ...override,
});
const income = () => ({ ...emptyIncome(wallet), policy: structuredClone(policy) });
const verified = (tx = receipt(), head = 111n) => extractIncome(wallet, tx, tx.blockHash, BigInt(Math.floor(now / 1000)), head);

after(async () => {
  for (const address of [wallet, other]) await pool.query("DELETE FROM stockflow_income WHERE wallet = $1", [address]);
  await pool.end();
});
describe("StockFlow verified receipt identity and planning", () => {
  it("requires exact supported-token logs, successful tx, recipient, positive amount and confirmations", () => {
    assert.equal(verified(receipt(), 110n)[0]!.status, "confirming");
    assert.equal(verified()[0]!.confirmations, CONFIRMATIONS);
    assert.equal(verified()[0]!.status, "confirmed");
    assert.equal(verified(receipt({ status: "reverted" })).length, 0);
    assert.equal(verified(receipt({ logs: [log(1n, sender)] })).length, 0);
    assert.equal(verified(receipt({ logs: [log(1n, usdc, other)] })).length, 0);
    assert.equal(verified(receipt({ logs: [log(0n)] })).length, 0);
    assert.equal(extractIncome(wallet, receipt(), `0x${"ee".repeat(32)}`, 1n, 111n).length, 0);
    const self = log(); self.topics = encodeEventTopics({ abi: [TRANSFER], args: { from: wallet as Hex, to: wallet as Hex } }) as Hex[];
    assert.equal(verified(receipt({ logs: [self] })).length, 0);
  });
  it("deduplicates source overlap and replay; multiple distinct transfers count once each", () => {
    const events = verified(receipt({ logs: [log(), log(2000000n, usdc, wallet, 4)] }));
    let state = reconcileIncome(income(), [...events, ...events], now);
    assert.equal(state.receipts.length, 2);
    assert.equal(state.proposals.length, 2);
    assert.equal(state.proposals[0]!.totalUsd, "50.00");
    assert.equal(state.proposals[1]!.status, "blocked");
    state = reconcileIncome(JSON.parse(JSON.stringify(state)), events, now);
    assert.equal(state.proposals.length, 2);
  });
  it("invalidates a removed/reorged receipt and never silently reproposes a resurrected payment", () => {
    const state = reconcileIncome(income(), verified(), now);
    state.proposals[0]!.status = "reviewed"; state.proposals[0]!.reviewedAt = new Date(now).toISOString();
    const missing = reconcileIncome(state, [], now);
    assert.equal(missing.receipts[0]!.status, "orphaned");
    assert.equal(missing.proposals[0]!.status, "invalidated");
    assert.equal(missing.proposals[0]!.reviewedAt, null);
    // A moved transaction changes its global log index but retains receipt-local identity.
    const moved = verified(receipt({ blockHash: `0x${"ef".repeat(32)}`, logs: [log(100000000n, usdc, wallet, 99)] }));
    const restored = reconcileIncome(missing, moved, now);
    assert.equal(restored.receipts.length, 1);
    assert.equal(restored.receipts[0]!.logIndex, 99);
    assert.equal(restored.proposals.length, 1);
    assert.equal(restored.proposals[0]!.status, "invalidated");
  });
  it("does not propose unconfirmed income, expired rules, missing rules, or assume EURC is USD", () => {
    assert.equal(reconcileIncome(income(), verified(receipt(), 105n), now).proposals.length, 0);
    assert.equal(reconcileIncome({ ...income(), policy: null }, verified(), now).proposals.length, 0);
    assert.equal(reconcileIncome(income(), verified(), policy.expiresAt).proposals.length, 0);
    const eur = reconcileIncome(income(), verified(receipt({ logs: [log(100000000n, eurc)] })), now);
    assert.equal(eur.receipts[0]!.token, "EURC");
    assert.equal(eur.proposals[0]!.status, "blocked");
    assert.equal(eur.proposals[0]!.totalUsd, "0.00");
    assert.match(eur.proposals[0]!.reason!, /conversion/);
  });
  it("enforces exact cents, per-purchase and cumulative daily caps across policy changes, and UTC reset", () => {
    let state = reconcileIncome(income(), verified(), now);
    assert.deepEqual(state.proposals[0]!.lines.map(l => l.amountUsd), ["30.00", "20.00"]);
    state.proposals[0]!.status = "dismissed";
    state.policy = { ...policy, id: "new-version" };
    const events = [...verified(), ...verified(receipt({ transactionHash: `0x${"aa".repeat(32)}` }))];
    state = reconcileIncome(state, events, now);
    assert.equal(state.proposals[1]!.totalUsd, "0.00");
    const tomorrow = Date.parse(new Date(now + 86400000).toISOString().slice(0, 10) + "T00:00:00Z");
    state.policy.expiresAt = tomorrow + 86400000;
    const newEvents = [...events, ...verified(receipt({ transactionHash: `0x${"bb".repeat(32)}` }))];
    const nextDay = reconcileIncome(state, newEvents, tomorrow);
    assert.equal(nextDay.proposals[2]!.totalUsd, "50.00");
    assert.match(policyError({ ...policy, maxPerPurchase: 0.001 }, now)!, /two decimal/);
    assert.ok(policyError({ ...policy, allocations: [{ ...policy.allocations[0]!, weight: 99 }] }, now));
    const huge = reconcileIncome(income(), verified(receipt({ logs: [log(2n ** 200n)] })), now);
    assert.equal(huge.proposals[0]!.totalUsd, "50.00");
  });
});

function fakeChain() {
  let head = 111n;
  let transactions = [receipt()];
  let fail = false;
  let canonicalHash: Hex = blockHash;
  const ranges: [bigint, bigint][] = [];
  const chain = {
    getBlockNumber: async () => head,
    getBlock: async () => ({ hash: canonicalHash, timestamp: BigInt(Math.floor(now / 1000)) }),
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      ranges.push([fromBlock, toBlock]);
      return transactions.filter(t => t.blockNumber >= fromBlock && t.blockNumber <= toBlock).map(t => ({ transactionHash: t.transactionHash }));
    },
    getTransactionReceipt: async ({ hash: requested }: { hash: Hex }) => {
      if (fail) throw new Error("simulated transport outage");
      const tx = transactions.find(t => t.transactionHash === requested);
      if (!tx) throw new TransactionReceiptNotFoundError({ hash: requested });
      return tx;
    },
  } as unknown as IncomeChain;
  return { chain, ranges, setHead: (n: bigint) => { head = n; }, remove: () => { transactions = []; },
    fail: () => { fail = true; }, fork: () => { canonicalHash = `0x${"fe".repeat(32)}`; } };
}

describe("StockFlow synchronization and durable wallet accounting", () => {
  it("verifies BasePay records independently and deduplicates direct/receipt/history sources", async () => {
    const fake = fakeChain();
    const requests = [{ id: "verified-request", paidTxHash: hash, amount: "100", token: "USDC" },
      { id: "uncovered", paidTxHash: hash, amount: "101", token: "USDC" },
      { id: "manual-only", paidTxHash: null, amount: "100", token: "USDC" },
      { id: "wrong-token", paidTxHash: hash, amount: "1", token: "ETH" }];
    const synced = await syncIncome(income(), requests, hash, fake.chain);
    assert.equal(synced.receipts.length, 1);
    assert.equal(synced.proposals.length, 1);
    assert.deepEqual(synced.receipts[0]!.paymentRequestIds, ["verified-request"]);
    assert.equal((await syncIncome(synced, requests, hash, fake.chain)).proposals.length, 1);
  });
  it("rechecks old receipts outside discovery, handles missing txs, and never mistakes RPC failure for a reorg", async () => {
    const fake = fakeChain();
    const state = await syncIncome(income(), [], hash, fake.chain);
    fake.setHead(50000n);
    const later = await syncIncome(state, [], undefined, fake.chain);
    assert.equal(later.receipts[0]!.status, "confirmed");
    fake.fail();
    await assert.rejects(syncIncome(later, [], undefined, fake.chain), /transport outage/);
    assert.equal(later.receipts[0]!.status, "confirmed");
    const removed = fakeChain(); removed.remove();
    assert.equal((await syncIncome(state, [], undefined, removed.chain)).proposals[0]!.status, "invalidated");
  });
  it("discloses bounded catch-up, rewinds a changed cursor checkpoint and rejects irrelevant historical hashes", async () => {
    const fake = fakeChain(); fake.setHead(100000n);
    const state = await syncIncome(income(), [], undefined, fake.chain);
    assert.equal(BigInt(state.scannedThroughBlock!) - BigInt(state.scanStartBlock!) + 1n, 2000n);
    assert.ok(BigInt(state.scannedThroughBlock!) < BigInt(state.headBlock!));
    await syncIncome(state, [], undefined, fake.chain);
    assert.ok(fake.ranges[1]![0] > fake.ranges[0]![0]);
    fake.fork();
    await syncIncome(state, [], undefined, fake.chain);
    assert.equal(fake.ranges[2]![0], BigInt(state.scanStartBlock!));
    const invalid = fakeChain();
    await assert.rejects(syncIncome({ ...emptyIncome(other), policy }, [], hash, invalid.chain), /no successful incoming/);
  });
  it("serializes concurrent sessions and persists receipts, rules, decisions and cursor without crossing wallets", async () => {
    const fake = fakeChain();
    await changeIncome(wallet, async () => income());
    await Promise.all([1, 2].map(() => changeIncome(wallet, state => syncIncome(state, [], hash, fake.chain))));
    const sessionOne = await readIncome(wallet);
    assert.equal(sessionOne.receipts.length, 1);
    assert.equal(sessionOne.proposals.length, 1);
    await changeIncome(wallet, async state => {
      state.proposals[0]!.status = "reviewed"; state.proposals[0]!.reviewedAt = new Date().toISOString(); return state;
    });
    const sessionTwo = await readIncome(wallet);
    assert.equal(sessionTwo.proposals[0]!.status, "reviewed");
    assert.equal(sessionTwo.scannedThroughBlock, sessionOne.scannedThroughBlock);
    assert.equal(sessionTwo.policy!.name, "Core");
    assert.equal((await readIncome(other)).receipts.length, 0);
    await assert.rejects(changeIncome(wallet, async () => { throw new Error("RPC failed"); }), /RPC failed/);
    assert.equal((await readIncome(wallet)).proposals[0]!.status, "reviewed");
  });
  it("binds read proofs to the wallet, action, fields and original timestamp, including cached proofs", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await account.signMessage({ message: buildOwnershipMessage("stockflow-income", {}, timestamp) });
    // Offline cryptographic verification; no live chain/keys or funding needed.
    const original = basePublicClient.verifyMessage;
    basePublicClient.verifyMessage = async args => verifyMessage(args);
    try {
      const args = { address: account.address, action: "stockflow-income", fields: {}, timestamp, signature, singleUse: false };
      assert.equal((await verifyOwnershipProof(args)).ok, true);
      assert.equal((await verifyOwnershipProof(args)).ok, true);
      assert.equal((await verifyOwnershipProof({ ...args, address: other })).ok, false);
      assert.equal((await verifyOwnershipProof({ ...args, fields: { altered: "yes" } })).ok, false);
      assert.equal((await verifyOwnershipProof({ ...args, timestamp: timestamp - 1 })).ok, false);
      assert.equal((await verifyOwnershipProof({ ...args, timestamp: timestamp - 301 })).ok, false);
      assert.equal((await verifyOwnershipProof({ ...args, action: "stockflow-policy" })).ok, false);
      const parsed = SetStockflowIncomePolicyBody.parse({ policy, signature, timestamp });
      const mutationSignature = await account.signMessage({ message: buildOwnershipMessage("stockflow-policy", { policy: JSON.stringify(parsed.policy) }, timestamp) });
      const mutation = { ...args, action: "stockflow-policy", fields: { policy: JSON.stringify(parsed.policy) }, signature: mutationSignature, singleUse: true };
      assert.equal((await verifyOwnershipProof(mutation)).ok, true);
      assert.equal((await verifyOwnershipProof(mutation)).ok, false);
    } finally { basePublicClient.verifyMessage = original; }
  });
});
