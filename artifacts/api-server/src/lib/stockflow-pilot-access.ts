import { randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { isAddress, zeroAddress } from "viem";
import { and, eq, gt, lt } from "drizzle-orm";
import { db, stockflowPilotTable, stockflowChallengesTable } from "@workspace/db";
import type { Request, Response } from "express";
import { pilotChain } from "./stockflow-market";

export class PilotError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export const PILOT_COOKIE = "stockflow_pilot_session";
export const PILOT_COOKIE_PATH = "/api/stockflow";
// Target regions, not an assertion of investor eligibility. Each participant
// still requires an operator's jurisdiction/investor/issuer review.
export const PILOT_REGION_CODES = new Set((
  "AL AD AM AT AZ BH BD BE BT BA BN BG KH CN HR CY CZ DK EE FI FR GE DE GR HK HU IS IN ID IE IL IT JP JO KZ XK KW KG LA LV LB LI LT LU MO MY MV MT MD MC MN ME NP NL MK NO OM PK PS PH PL PT QA RO SM SA RS SG SK SI KR ES LK SE CH TW TJ TH TL TR TM AE GB UZ VA VN YE"
).split(" "));
const RESTRICTED = new Set(["US", "RU", "BY", "IR", "KP", "SY", "AF", "MM", "YE"]);
export function pilotCountryAllowed(country: string) {
  return /^[A-Z]{2}$/.test(country) && PILOT_REGION_CODES.has(country) && !RESTRICTED.has(country);
}
export function normalizePilotCountry(country: string) {
  const code = country.trim().toUpperCase();
  return code === "UK" ? "GB" : code;
}
export function validatePilotApprovalCountry(country: string, reviewConfirmed: boolean) {
  const code = normalizePilotCountry(country);
  if (!pilotCountryAllowed(code)) {
    throw new PilotError(400, "Enter a supported European or Asian ISO country code. For the United Kingdom use GB (UK is also accepted). Regions such as Europe or Asia are not country codes.");
  }
  if (!reviewConfirmed) {
    throw new PilotError(400, "Confirm the operator's investor, issuer, jurisdiction and sanctions review before granting trading access. Country selection alone is not an eligibility review.");
  }
  return code;
}
export function pilotConfig() {
  const configured = (process.env.STOCKFLOW_PILOT_ADMIN_WALLETS ?? "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  const valid = configured.length > 0 && configured.every(s => isAddress(s) && s !== zeroAddress);
  const admins = valid ? configured : [];
  return { admins, enabled: process.env.STOCKFLOW_PILOT_ENABLED === "true" && admins.length > 0 };
}
function secret() {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32) throw new PilotError(503, "Wallet sessions are not configured.");
  return new TextEncoder().encode(value);
}
export async function pilotIdentity(req: Request) {
  const raw = req.headers.cookie?.split(";").map(s => s.trim()).find(s => s.startsWith(`${PILOT_COOKIE}=`))?.slice(PILOT_COOKIE.length + 1);
  if (!raw) return null;
  try {
    const { payload } = await jwtVerify(raw, secret(), { algorithms: ["HS256"], issuer: "basepay-stockflow", audience: "stockflow-pilot" });
    return typeof payload.sub === "string" && isAddress(payload.sub) ? payload.sub.toLowerCase() : null;
  } catch { return null; }
}
export function serializeParticipant(row: typeof stockflowPilotTable.$inferSelect) {
  return { ...row, expiresAt: row.expiresAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}
export async function pilotSession(address: string | null) {
  const config = pilotConfig();
  const [participant] = address ? await db.select().from(stockflowPilotTable).where(eq(stockflowPilotTable.wallet, address)) : [];
  const approved = !!(config.enabled && participant?.approved && participant.expiresAt.getTime() > Date.now() && pilotCountryAllowed(participant.countryCode));
  return {
    authenticated: !!address, address, isAdmin: !!address && config.admins.includes(address),
    enabled: config.enabled, approved,
    reason: !config.admins.length ? "Pilot administrator has not been configured." :
      !config.enabled ? "Mainnet pilot is paused." :
      !address ? "Sign in with your connected wallet to check pilot access." :
      approved ? "Operator-reviewed pilot access is active." :
      participant && participant.expiresAt.getTime() <= Date.now() ? "Pilot approval has expired." :
      participant && !participant.approved ? "Pilot access has been revoked." : "This wallet is not approved for the mainnet pilot.",
    participant: participant ? serializeParticipant(participant) : null,
  };
}
export async function requirePilotWallet(req: Request, approved = false) {
  const wallet = await pilotIdentity(req);
  if (!wallet) throw new PilotError(401, "Sign in with your wallet first.");
  if (approved && !(await pilotSession(wallet)).approved) throw new PilotError(403, "An active, reviewed pilot approval is required.");
  return wallet;
}
export async function requirePilotAdmin(req: Request) {
  const wallet = await requirePilotWallet(req);
  if (!pilotConfig().admins.includes(wallet)) throw new PilotError(403, "Pilot administrator access required.");
  return wallet;
}
export async function createPilotChallenge(address: string, host: string) {
  if (!isAddress(address, { strict: false })) throw new PilotError(400, "Invalid wallet address.");
  const id = randomUUID(), wallet = address.toLowerCase(), now = new Date();
  const message = [
    "BasePay StockFlow pilot sign-in", `Domain: ${host}`, "Chain ID: 8453",
    `Wallet: ${wallet}`, `Nonce: ${id}`, `Issued: ${now.toISOString()}`,
    "This signs you in for one hour. It does not approve tokens or submit a transaction.",
  ].join("\n");
  await db.delete(stockflowChallengesTable).where(lt(stockflowChallengesTable.expiresAt, now));
  await db.insert(stockflowChallengesTable).values({ id, wallet, message, expiresAt: new Date(now.getTime() + 300_000) });
  return { id, message };
}
export async function authenticatePilot(address: string, challengeId: string, signature: string, res: Response) {
  if (!isAddress(address, { strict: false }) || !/^0x[0-9a-f]+$/i.test(signature) || signature.length > 32768) throw new PilotError(400, "Invalid wallet signature.");
  const wallet = address.toLowerCase();
  const [challenge] = await db.select().from(stockflowChallengesTable).where(and(
    eq(stockflowChallengesTable.id, challengeId), eq(stockflowChallengesTable.wallet, wallet), gt(stockflowChallengesTable.expiresAt, new Date()),
  ));
  if (!challenge) throw new PilotError(401, "Sign-in challenge expired or already used.");
  let valid = false;
  try { valid = await pilotChain.verifyMessage({ address: wallet as `0x${string}`, message: challenge.message, signature: signature as `0x${string}` }); }
  catch { throw new PilotError(503, "Wallet verification RPC unavailable. No session was issued."); }
  if (!valid) throw new PilotError(401, "Wallet signature does not match.");
  const token = await new SignJWT({}).setProtectedHeader({ alg: "HS256" })
    .setSubject(wallet).setIssuer("basepay-stockflow").setAudience("stockflow-pilot")
    .setIssuedAt().setExpirationTime("1h").sign(secret());
  const consumed = await db.delete(stockflowChallengesTable).where(and(
    eq(stockflowChallengesTable.id, challenge.id), gt(stockflowChallengesTable.expiresAt, new Date()),
  )).returning({ id: stockflowChallengesTable.id });
  if (!consumed.length) throw new PilotError(401, "Sign-in challenge already used.");
  res.cookie(PILOT_COOKIE, token, { httpOnly: true, secure: true, sameSite: "strict", path: PILOT_COOKIE_PATH, maxAge: 3_600_000 });
  return pilotSession(wallet);
}
