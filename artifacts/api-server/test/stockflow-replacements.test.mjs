// Offline chain fixtures only. No public RPC, funded accounts or chain writes.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
import express from "express";
import { encodeAbiParameters, encodeEventTopics, parseAbi, zeroAddress } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { Attribution } from "ox/erc8021";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, ".cache/stockflow-replacements.mjs");
await mkdir(path.dirname(output), { recursive: true });
const require = createRequire(import.meta.url);
await build({
  stdin: {
    contents: `export * from "./src/lib/stockflow-market";
      export { default as router } from "./src/routes/stockflow-pilot";
      export { createPilotChallenge, authenticatePilot, PILOT_COOKIE } from "./src/lib/stockflow-pilot-access";
      export { db, pool, stockflowQuotesTable, stockflowTradesTable, stockflowChallengesTable } from "@workspace/db";`,
    resolveDir: root, loader: "ts",
  },
  outfile: output, bundle: true, platform: "node", format: "esm", packages: "external",
  plugins: [{
    name: "bundle-workspace",
    setup(b) {
      b.onResolve({ filter: /^@workspace\// }, args => ({ path: require.resolve(args.path), external: false }));
      // Workspace libraries own their dependencies (notably pg); resolve bare
      // imports relative to their source rather than the generated test bundle.
      b.onResolve({ filter: /^[^./]/ }, args => ({
        path: createRequire(args.importer || import.meta.url).resolve(args.path), external: true,
      }));
    },
  }],
});
const {
  pilotChain, pilotSwapData, pilotCalldataMatches, reconcilePilotTrade,
  PILOT_ROUTER, PILOT_FACTORY, PILOT_USDC, router, createPilotChallenge, authenticatePilot,
  db, pool, stockflowQuotesTable, stockflowTradesTable, stockflowChallengesTable,
} = await import(pathToFileURL(output));
const { eq } = await import("drizzle-orm");
const account = privateKeyToAccount(generatePrivateKey());
const wallet = account.address.toLowerCase();
const other = "0x2222222222222222222222222222222222222222";
const stock = "0x3333333333333333333333333333333333333333";
const hash = c => `0x${c.repeat(64)}`;
const ORIGINAL = hash("a"), REPLACEMENT = hash("b"), SECOND = hash("c"), BLOCK = hash("d");
const q = {
  id: crypto.randomUUID(), chainId: 8453, wallet, stockAddress: stock, symbol: "FIXTURE", side: "buy",
  router: PILOT_ROUTER, factory: PILOT_FACTORY, pool: other, tickSpacing: 10,
  tokenIn: PILOT_USDC, tokenOut: stock, decimalsIn: 6, decimalsOut: 8,
  amountIn: "100000", amountOut: "50000", minimumOut: "49750", slippageBps: 50, priceImpactBps: 3,
  // Recovery must not require a fresh quote or an active participant.
  expiresAt: new Date(Date.now() - 1000).toISOString(), deadline: Math.floor(Date.now() / 1000) - 1, blockNumber: "80",
};
const transferAbi = parseAbi(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
let transactions, receipts, safe, latest, count, scanned;
function transaction(h, changes = {}) {
  return { hash: h, from: wallet, to: PILOT_ROUTER, nonce: 7, input: pilotSwapData(q), value: 0n, blockNumber: null, ...changes };
}
function receipt(h, changes = {}) {
  return {
    transactionHash: h, blockHash: BLOCK, blockNumber: 100n, status: "success",
    logs: [{
      address: stock, topics: encodeEventTopics({ abi: transferAbi, eventName: "Transfer", args: { from: other, to: wallet } }),
      data: encodeAbiParameters([{ type: "uint256" }], [50000n]),
    }], ...changes,
  };
}
const missing = name => Object.assign(new Error("not found"), { name });
function reset() {
  transactions = new Map([[ORIGINAL, transaction(ORIGINAL)]]);
  receipts = new Map(); safe = 99n; latest = 100n; count = 7; scanned = [];
}
pilotChain.getTransaction = async ({ hash: h }) => {
  if (!transactions.has(h)) throw missing("TransactionNotFoundError");
  return transactions.get(h);
};
pilotChain.getTransactionReceipt = async ({ hash: h }) => {
  if (!receipts.has(h)) throw missing("TransactionReceiptNotFoundError");
  return receipts.get(h);
};
pilotChain.getBlockNumber = async () => latest;
pilotChain.getTransactionCount = async () => count;
pilotChain.getBlock = async ({ blockTag, blockNumber, includeTransactions }) => {
  if (blockTag === "safe") return { number: safe, hash: BLOCK, transactions: [] };
  if (includeTransactions) scanned.push(blockNumber);
  return { number: blockNumber, hash: BLOCK, transactions: [...transactions.values()].filter(t => t.blockNumber === blockNumber) };
};
// Fail explicitly if a future implementation tries any other network/wallet path.
pilotChain.request = async ({ method, params }) => {
  if (method !== "eth_getTransactionReceipt") throw new Error("Unexpected public-chain RPC in offline test");
  const r = receipts.get(params[0]);
  if (!r) return null;
  return {
    transactionHash: r.transactionHash, blockHash: r.blockHash, blockNumber: "0x64",
    gasUsed: "0x5208", effectiveGasPrice: "0xa", l1Fee: "0x64",
    operatorFeeScalar: "0x0", operatorFeeConstant: "0x0",
  };
};
let passed = 0;
async function check(name, fn) {
  reset(); await fn(); passed++; process.stdout.write(`PASS ${name}\n`);
}
let server;
const quoteIds = [q.id];
try {
  await check("canonical calldata accepts attribution, never arbitrary bytes or changed economics", async () => {
    const data = pilotSwapData(q), suffix = Attribution.toDataSuffix({ codes: ["fixture"] });
    assert(pilotCalldataMatches(data, q)); assert(pilotCalldataMatches(`${data}${suffix.slice(2)}`, q));
    for (const bad of [`${data}00`, `${data}deadbeef`, `${data}${suffix.slice(2)}00`, `${data}00${suffix.slice(2)}`]) assert(!pilotCalldataMatches(bad, q));
    for (const change of [{ amountIn: "100001" }, { minimumOut: "49749" }, { deadline: q.deadline + 1 }, { tokenOut: other }, { wallet: other }, { tickSpacing: 50 }]) {
      assert(!pilotCalldataMatches(pilotSwapData({ ...q, ...change }), q));
    }
  });
  await check("a speed-up remains pending until safe and uses the actual mined hash", async () => {
    const anchor = await reconcilePilotTrade(q, ORIGINAL);
    assert.equal(anchor.status, "pending");
    transactions.delete(ORIGINAL);
    transactions.set(REPLACEMENT, transaction(REPLACEMENT, {
      blockNumber: 100n, input: `${pilotSwapData(q)}${Attribution.toDataSuffix({ codes: ["fixture"] }).slice(2)}`,
    }));
    receipts.set(REPLACEMENT, receipt(REPLACEMENT));
    const included = await reconcilePilotTrade(q, ORIGINAL, [REPLACEMENT], anchor.tracking);
    assert.equal(included.hash, REPLACEMENT); assert.equal(included.status, "pending");
    safe = 100n;
    const confirmed = await reconcilePilotTrade(q, ORIGINAL, [], included.tracking);
    assert.equal(confirmed.status, "confirmed"); assert.equal(confirmed.amountOut, "50000");
    assert.equal(confirmed.tracking.originalHash, ORIGINAL); assert.deepEqual(confirmed.tracking.hashes, [REPLACEMENT]);
  });
  await check("safe cancellations, including attributed self-sends, are not stock trades", async () => {
    const { tracking } = await reconcilePilotTrade(q, ORIGINAL);
    for (const input of ["0x", Attribution.toDataSuffix({ codes: ["fixture"] })]) {
      transactions.set(REPLACEMENT, transaction(REPLACEMENT, { to: wallet, input, blockNumber: 100n }));
      receipts.set(REPLACEMENT, receipt(REPLACEMENT, { logs: [] }));
      assert.equal((await reconcilePilotTrade(q, ORIGINAL, [REPLACEMENT], tracking)).status, "pending");
      safe = 100n;
      const result = await reconcilePilotTrade(q, ORIGINAL, [REPLACEMENT], tracking);
      assert.equal(result.status, "cancelled"); assert.equal(result.amountOut, null);
      safe = 99n;
    }
  });
  await check("changed calldata, destination or value never counts as a successful swap", async () => {
    const { tracking } = await reconcilePilotTrade(q, ORIGINAL);
    safe = 100n;
    for (const change of [
      { input: pilotSwapData({ ...q, amountIn: "100001" }) }, { input: `${pilotSwapData(q)}deadbeef` },
      { to: other }, { value: 1n }, { input: pilotSwapData({ ...q, wallet: other }) },
    ]) {
      transactions.set(REPLACEMENT, transaction(REPLACEMENT, { blockNumber: 100n, ...change }));
      receipts.set(REPLACEMENT, receipt(REPLACEMENT));
      const result = await reconcilePilotTrade(q, ORIGINAL, [REPLACEMENT], tracking);
      assert.equal(result.status, "changed"); assert.equal(result.amountOut, null);
    }
  });
  await check("wrong replacement sender and nonce are rejected", async () => {
    const { tracking } = await reconcilePilotTrade(q, ORIGINAL);
    for (const change of [{ from: other }, { nonce: 8 }]) {
      transactions.set(REPLACEMENT, transaction(REPLACEMENT, { blockNumber: 100n, ...change }));
      await assert.rejects(reconcilePilotTrade(q, ORIGINAL, [REPLACEMENT], tracking), /sender or nonce/);
    }
    await assert.rejects(reconcilePilotTrade(q, SECOND, [], tracking), /already tracks/);
  });
  await check("a reverted repricing is failed only after safe confirmation", async () => {
    const { tracking } = await reconcilePilotTrade(q, ORIGINAL);
    transactions.set(REPLACEMENT, transaction(REPLACEMENT, { blockNumber: 100n }));
    receipts.set(REPLACEMENT, receipt(REPLACEMENT, { status: "reverted", logs: [] }));
    assert.equal((await reconcilePilotTrade(q, ORIGINAL, [REPLACEMENT], tracking)).status, "pending");
    safe = 100n; assert.equal((await reconcilePilotTrade(q, ORIGINAL, [REPLACEMENT], tracking)).status, "failed");
  });
  await check("receipt hash, canonical block and minimum output cannot be spoofed", async () => {
    const { tracking } = await reconcilePilotTrade(q, ORIGINAL);
    transactions.set(REPLACEMENT, transaction(REPLACEMENT, { blockNumber: 100n }));
    for (const change of [{ transactionHash: SECOND }, { blockHash: SECOND }, { logs: [] }]) {
      receipts.set(REPLACEMENT, receipt(REPLACEMENT, change));
      await assert.rejects(reconcilePilotTrade(q, ORIGINAL, [REPLACEMENT], tracking), /mismatch|canonical|output/);
    }
  });
  await check("reload recovery discovers an unreported consumed nonce without resending", async () => {
    const { tracking } = await reconcilePilotTrade(q, ORIGINAL);
    transactions.delete(ORIGINAL); count = 8; safe = 100n;
    transactions.set(REPLACEMENT, transaction(REPLACEMENT, { blockNumber: 100n }));
    receipts.set(REPLACEMENT, receipt(REPLACEMENT));
    const result = await reconcilePilotTrade(q, ORIGINAL, [], JSON.parse(JSON.stringify(tracking)));
    assert.equal(result.status, "confirmed"); assert.equal(result.hash, REPLACEMENT);
    assert(scanned.length <= 120);
  });
  await check("long recovery scans are bounded and resume from persisted safe progress", async () => {
    const { tracking } = await reconcilePilotTrade(q, ORIGINAL);
    transactions.delete(ORIGINAL); count = 8; latest = 400n; safe = 400n;
    transactions.set(REPLACEMENT, transaction(REPLACEMENT, { blockNumber: 250n }));
    receipts.set(REPLACEMENT, receipt(REPLACEMENT, { blockNumber: 250n }));
    let result = await reconcilePilotTrade(q, ORIGINAL, [], tracking);
    assert.equal(result.status, "pending"); assert.equal(scanned.length, 120);
    assert.equal(result.tracking.scanBlock, "120");
    scanned = [];
    result = await reconcilePilotTrade(q, ORIGINAL, [], result.tracking);
    assert.equal(result.status, "pending"); assert.equal(scanned.length, 120);
    result = await reconcilePilotTrade(q, ORIGINAL, [], result.tracking);
    assert.equal(result.status, "confirmed"); assert.equal(result.hash, REPLACEMENT);
  });
  await check("missing original evidence fails closed, never guesses a trade", async () => {
    transactions.delete(ORIGINAL);
    await assert.rejects(reconcilePilotTrade(q, ORIGINAL, [REPLACEMENT]), /not found/);
  });

  // Exercise the real HTTP route, generated schemas and transactional storage.
  // Only ephemeral rows in the development DB; all chain methods remain mocked.
  const challenge = await createPilotChallenge(account.address, "offline-fixture.invalid");
  let cookie;
  await authenticatePilot(account.address, challenge.id, await account.signMessage({ message: challenge.message }), {
    cookie(name, value) { cookie = `${name}=${value}`; },
  });
  const app = express();
  app.use(express.json(), (req, _res, next) => { req.log = { warn() {} }; next(); });
  app.use("/api", router);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/stockflow/trading/history`;
  const post = async (body, signedIn = true) => {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...(signedIn ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  await db.insert(stockflowQuotesTable).values({ id: q.id, wallet, payload: q, expiresAt: new Date(q.expiresAt) });
  await check("revoked/unapproved wallets reconcile, retries are idempotent and history has one mined order", async () => {
    const reviewedSwapFee = { executionWei: "123", l1DataWei: "456", operatorWei: "0", totalWei: "579" };
    assert.equal((await post({ quoteId: q.id, hash: ORIGINAL, reviewedSwapFee })).status, 200);
    transactions.delete(ORIGINAL);
    transactions.set(REPLACEMENT, transaction(REPLACEMENT, { blockNumber: 100n }));
    receipts.set(REPLACEMENT, receipt(REPLACEMENT)); safe = 100n;
    const results = await Promise.all(Array.from({ length: 3 }, () => post({
      quoteId: q.id, hash: ORIGINAL, replacementHashes: [REPLACEMENT],
      reviewedSwapFee: { executionWei: "999", l1DataWei: "0", operatorWei: "0", totalWei: "999" },
      networkFees: { totalWei: "0" },
    })));
    for (const r of results) {
      assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.hash, REPLACEMENT);
      assert.equal(r.body.status, "confirmed"); assert.equal(r.body.originalHash, ORIGINAL);
      assert.deepEqual(r.body.replacementHashes, [REPLACEMENT]);
      assert.deepEqual(r.body.reviewedSwapFee, reviewedSwapFee, "Reconciliation must not rewrite the original review");
      assert.deepEqual(r.body.networkFees, { executionWei: "210000", l1DataWei: "100", operatorWei: "0", totalWei: "210100" });
    }
    const rows = await db.select().from(stockflowTradesTable).where(eq(stockflowTradesTable.wallet, wallet));
    assert.equal(rows.length, 1); assert.equal(rows[0].hash, REPLACEMENT);
    const response = await fetch(url, { headers: { Cookie: cookie } });
    const history = await response.json();
    assert.equal(history.length, 1); assert.equal(history[0].originalHash, ORIGINAL);
    // A second nonce with identical economics cannot be attached to this order.
    transactions.set(SECOND, transaction(SECOND, { nonce: 8, blockNumber: 101n }));
    assert.equal((await post({ quoteId: q.id, hash: SECOND })).status, 422);
  });
  await check("route rejects foreign-wallet quotes and invalid hashes and requires authentication", async () => {
    const foreign = { ...q, id: crypto.randomUUID(), wallet: other };
    quoteIds.push(foreign.id);
    await db.insert(stockflowQuotesTable).values({ id: foreign.id, wallet: other, payload: foreign, expiresAt: new Date(q.expiresAt) });
    assert.equal((await post({ quoteId: foreign.id, hash: ORIGINAL })).status, 404);
    assert.equal((await post({ quoteId: q.id, hash: ORIGINAL }, false)).status, 401);
    assert.equal((await post({ quoteId: q.id, hash: "bad" })).status, 400);
    assert.equal((await post({ quoteId: q.id, hash: ORIGINAL, replacementHashes: [zeroAddress] })).status, 400);
  });
  await check("history polling discovers and records a cancellation after the browser reloads", async () => {
    const fresh = { ...q, id: crypto.randomUUID() }; quoteIds.push(fresh.id);
    await db.insert(stockflowQuotesTable).values({ id: fresh.id, wallet, payload: fresh, expiresAt: new Date(q.expiresAt) });
    // Different fixture hashes avoid sharing a transaction across two quotes.
    const original = hash("e"), cancel = hash("f");
    transactions = new Map([[original, transaction(original)]]);
    assert.equal((await post({ quoteId: fresh.id, hash: original })).status, 200);
    transactions.delete(original); count = 8; safe = 100n;
    transactions.set(cancel, transaction(cancel, { to: wallet, input: "0x", blockNumber: 100n }));
    receipts.set(cancel, receipt(cancel, { logs: [] }));
    const r = await fetch(url, { headers: { Cookie: cookie } });
    const entry = (await r.json()).find(row => row.quoteId === fresh.id);
    assert.equal(entry.status, "cancelled"); assert.equal(entry.hash, cancel);
    assert.equal(entry.originalHash, original); assert.equal(entry.amountOut, null);
  });
  process.stdout.write(`StockFlow replacement reconciliation: ${passed} offline regressions passed; no public-chain funds spent.\n`);
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await db.delete(stockflowTradesTable).where(eq(stockflowTradesTable.wallet, wallet));
  for (const id of quoteIds) await db.delete(stockflowQuotesTable).where(eq(stockflowQuotesTable.id, id));
  await db.delete(stockflowChallengesTable).where(eq(stockflowChallengesTable.wallet, wallet));
  await pool.end();
}
