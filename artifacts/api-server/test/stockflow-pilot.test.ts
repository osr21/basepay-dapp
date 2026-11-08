import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Attribution } from "ox/erc8021";
import type { Request, Response } from "express";
import { db, pool, stockflowPilotTable, stockflowChallengesTable, stockflowQuotesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  pilotConfig, pilotCountryAllowed, normalizePilotCountry, validatePilotApprovalCountry, pilotSession, createPilotChallenge,
  authenticatePilot, pilotIdentity, requirePilotWallet, requirePilotAdmin, PILOT_COOKIE,
} from "../src/lib/stockflow-pilot-access";
import { parsePilotAmount, priceImpactBps, quotePilotTrade, PILOT_ROUTER, PILOT_FACTORY, PILOT_USDC, pilotSwapData, pilotCalldataMatches } from "../src/lib/stockflow-market";

// Ephemeral test accounts only. No imported keys, wallet funding, approvals,
// sendTransaction/writeContract calls, or public-chain writes.
const account = privateKeyToAccount(generatePrivateKey());
const other = privateKeyToAccount(generatePrivateKey());
const wallet = account.address.toLowerCase();
const priorAdmin = process.env.STOCKFLOW_PILOT_ADMIN_WALLETS;
const priorEnabled = process.env.STOCKFLOW_PILOT_ENABLED;
let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; process.stdout.write(`PASS ${name}\n`); };

async function main() {
  process.env.STOCKFLOW_PILOT_ADMIN_WALLETS = wallet;
  process.env.STOCKFLOW_PILOT_ENABLED = "true";
  check("only a configured administrator can enable the pilot", () => assert.equal(pilotConfig().enabled, true));
  check("region selection is bounded; US and restricted/unknown countries are denied", () => {
    for (const code of ["GB", "DE", "IN", "SG", "JP"]) assert(pilotCountryAllowed(code));
    for (const code of ["US", "RU", "IR", "KP", "ZZ", "AU", "gb"]) assert(!pilotCountryAllowed(code));
  });
  check("UK inputs normalize to GB without bypassing operator review or region restrictions", () => {
    for (const value of ["UK", " uk ", "GB", "gb"]) {
      assert.equal(normalizePilotCountry(value), "GB");
      assert.equal(validatePilotApprovalCountry(value, true), "GB");
      assert.throws(() => validatePilotApprovalCountry(value, false), /Confirm the operator/);
    }
    for (const value of ["Europe", "Asia", "any", "US", "RU", "ZZ"]) {
      assert.throws(() => validatePilotApprovalCountry(value, true), /supported European or Asian ISO country code/);
    }
  });
  check("amount parsing never rounds away excess precision or accepts exponent notation", () => {
    assert.equal(parsePilotAmount("0.1", 6), 100000n);
    for (const value of ["0", "-1", "1e6", "NaN", "0.0000001", "01", "1."]) assert.throws(() => parsePilotAmount(value, 6));
  });
  check("price-impact calculation handles both swap directions and rounds conservatively", () => {
    const sqrt = 2n ** 96n;
    assert.equal(priceImpactBps(10000n, 9900n, sqrt, "0x1", "0x2"), 100);
    assert.equal(priceImpactBps(10000n, 9900n, sqrt, "0x2", "0x1"), 100);
    assert.equal(priceImpactBps(10000n, 10001n, sqrt, "0x1", "0x2"), 0);
  });
  const initial = await pilotSession(wallet);
  assert(initial.isAdmin && !initial.approved); passed++; process.stdout.write("PASS administrator is not automatically approved to trade\n");
  const challenge = await createPilotChallenge(account.address, "unit-test.invalid");
  await assert.rejects(
    authenticatePilot(other.address, challenge.id, await other.signMessage({ message: challenge.message }), {} as Response),
    /expired or already used/,
  ); passed++; process.stdout.write("PASS challenges are wallet-bound\n");
  const signature = await account.signMessage({ message: challenge.message });
  let cookie = "";
  const response = { cookie(name: string, token: string, options: Record<string, unknown>) {
    assert.equal(name, PILOT_COOKIE); assert(options.httpOnly && options.secure && options.sameSite === "strict");
    cookie = `${name}=${token}`;
  } } as unknown as Response;
  const authResults = await Promise.allSettled([
    authenticatePilot(account.address, challenge.id, signature, response),
    authenticatePilot(account.address, challenge.id, signature, response),
  ]);
  assert.equal(authResults.filter(r => r.status === "fulfilled").length, 1);
  passed++; process.stdout.write("PASS a persisted challenge can create only one session under concurrent replay\n");
  const request = { headers: { cookie } } as Request;
  assert.equal(await pilotIdentity(request), wallet);
  assert.equal(await requirePilotAdmin(request), wallet);
  await assert.rejects(requirePilotWallet(request, true), /approval/);
  passed++; process.stdout.write("PASS a valid session is not sufficient for trading\n");
  const grant = {
    wallet, countryCode: "GB", approved: true, expiresAt: new Date(Date.now() + 60_000),
    reviewedBy: wallet, updatedAt: new Date(),
  };
  await db.insert(stockflowPilotTable).values(grant);
  assert.equal((await pilotSession(wallet)).approved, true);
  assert.equal(await requirePilotWallet(request, true), wallet);
  await db.update(stockflowPilotTable).set({ approved: false }).where(eq(stockflowPilotTable.wallet, wallet));
  await assert.rejects(requirePilotWallet(request, true), /approval/);
  await db.update(stockflowPilotTable).set({ approved: true, expiresAt: new Date(Date.now() - 1) }).where(eq(stockflowPilotTable.wallet, wallet));
  assert.equal((await pilotSession(wallet)).approved, false);
  await db.update(stockflowPilotTable).set({ countryCode: "US", expiresAt: new Date(Date.now() + 60_000) }).where(eq(stockflowPilotTable.wallet, wallet));
  assert.equal((await pilotSession(wallet)).approved, false);
  passed++; process.stdout.write("PASS approval, immediate revocation, expiry and country restrictions are checked afresh\n");
  process.env.STOCKFLOW_PILOT_ENABLED = "false";
  assert.equal((await pilotSession(wallet)).approved, false);
  process.env.STOCKFLOW_PILOT_ADMIN_WALLETS = "invalid";
  assert.equal(pilotConfig().enabled, false);
  passed++; process.stdout.write("PASS paused and invalid administrator configurations fail closed\n");
  if (process.argv.includes("--live")) {
    const stock = "0xb20000000000000000000078ee7ce2fE4908108C";
    for (const side of ["buy", "sell"] as const) {
      const quote = await quotePilotTrade(account.address, { stockAddress: stock, side, amount: side === "buy" ? "0.1" : "0.001", slippageBps: 50 });
      assert.equal(quote.router, PILOT_ROUTER); assert.equal(quote.factory, PILOT_FACTORY);
      assert.equal(quote.wallet, wallet);
      assert.equal(quote.tokenIn.toLowerCase(), (side === "buy" ? PILOT_USDC : stock).toLowerCase());
      assert.equal(BigInt(quote.minimumOut), BigInt(quote.amountOut) * 9950n / 10000n);
      assert(BigInt(quote.amountOut) > 0n && quote.priceImpactBps <= 500);
      assert(pilotSwapData(quote).startsWith("0x"));
      const data = pilotSwapData(quote);
      const suffix = Attribution.toDataSuffix({ codes: ["test-pilot"] });
      assert(pilotCalldataMatches(data, quote));
      assert(pilotCalldataMatches(`${data}${suffix.slice(2)}`, quote));
      assert(!pilotCalldataMatches(`${data}deadbeef`, quote));
      assert(!pilotCalldataMatches(data, { ...quote, amountIn: (BigInt(quote.amountIn) + 1n).toString() }));
      passed++; process.stdout.write(`PASS live mainnet ${side} quote via eth_call only\n`);
    }
    await assert.rejects(quotePilotTrade(account.address, {
      stockAddress: stock, side: "buy", amount: "100.000001", slippageBps: 50,
    }), /100 USDC/); passed++; process.stdout.write("PASS pilot buy quote amount cap\n");
  }
  if (process.argv.includes("--http")) {
    // Exercise the actual running development API through its shared proxy.
    // Session cookies and ephemeral signatures stay in memory, never in logs.
    let sessionCookie = "";
    const call = async (path: string, body?: unknown) => {
      const response = await fetch(`http://localhost:80/api/stockflow${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json", ...(sessionCookie ? { cookie: sessionCookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const payload = await response.json() as Record<string, any>;
      return { response, payload };
    };
    const challenge = await call("/pilot/challenge", { address: wallet });
    assert.equal(challenge.response.status, 200);
    const signature = await account.signMessage({ message: challenge.payload.message });
    const login = await call("/pilot/auth", { address: wallet, challengeId: challenge.payload.id, signature });
    assert.equal(login.response.status, 200);
    sessionCookie = login.response.headers.get("set-cookie")?.split(";")[0] ?? "";
    assert(sessionCookie.startsWith(`${PILOT_COOKIE}=`));
    assert.equal(login.payload.address, wallet);
    assert.equal(login.payload.isAdmin, false);
    assert.equal(login.payload.approved, false);
    const trade = { stockAddress: "0xb20000000000000000000078ee7ce2fE4908108C", side: "buy", amount: "0.1", slippageBps: 50 };
    assert.equal((await call("/trading/quote", trade)).response.status, 403);
    assert.equal((await call("/pilot/participants", {
      wallet, countryCode: "SG", days: 1, approved: true, reviewConfirmed: true,
    })).response.status, 403);
    passed++; process.stdout.write("PASS HTTP wallet sign-in succeeds but self-approval and unapproved quotes are forbidden\n");
    // A temporary unfunded test fixture, removed in finally; not a real participant.
    await db.update(stockflowPilotTable).set({
      countryCode: "SG", approved: true, expiresAt: new Date(Date.now() + 60_000),
    }).where(eq(stockflowPilotTable.wallet, wallet));
    const live = await call("/trading/quote", trade);
    assert.equal(live.response.status, 200, live.payload.error);
    assert.equal(live.payload.amountIn, "100000");
    assert.equal(live.payload.wallet, wallet);
    assert(BigInt(live.payload.minimumOut) > 0n);
    const prepare = await call("/trading/prepare", { quoteId: live.payload.id });
    assert.equal(prepare.response.status, 422);
    assert.match(prepare.payload.error, /Insufficient input-token balance/);
    passed++; process.stdout.write("PASS HTTP decimal quote matches and an unfunded wallet is blocked before approval\n");
    await db.update(stockflowPilotTable).set({ approved: false }).where(eq(stockflowPilotTable.wallet, wallet));
    assert.equal((await call("/trading/prepare", { quoteId: live.payload.id })).response.status, 403);
    assert.equal((await call("/trading/quote", trade)).response.status, 403);
    passed++; process.stdout.write("PASS HTTP revocation blocks both new quotes and existing-quote preparation\n");
  }
  process.stdout.write(`StockFlow pilot: ${passed} checks passed; no public-chain transactions submitted.\n`);
}
main().finally(async () => {
  if (priorAdmin === undefined) delete process.env.STOCKFLOW_PILOT_ADMIN_WALLETS;
  else process.env.STOCKFLOW_PILOT_ADMIN_WALLETS = priorAdmin;
  if (priorEnabled === undefined) delete process.env.STOCKFLOW_PILOT_ENABLED;
  else process.env.STOCKFLOW_PILOT_ENABLED = priorEnabled;
  await db.delete(stockflowQuotesTable).where(eq(stockflowQuotesTable.wallet, wallet));
  await db.delete(stockflowPilotTable).where(eq(stockflowPilotTable.wallet, wallet));
  await db.delete(stockflowChallengesTable).where(eq(stockflowChallengesTable.wallet, wallet));
  await pool.end();
}).catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
