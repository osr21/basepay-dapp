import type { Hex } from "viem";
import { basePublicClient } from "./rpc";

// ── Shared EIP-191 "ownership proof" verifier ──────────────────────────────
// Used by routes that scope data to a wallet address (contacts, payment
// requests) but have no persistent login session. Instead
// of a full SIWE/session system, the caller signs a short-lived message
// binding the specific mutation to their address, which the server verifies
// on each request. This closes the "anyone who knows your address can
// mutate your data" gap without adding cookies, sessions, or DB migrations.
//
// basePublicClient.verifyMessage (not viem's standalone verifyMessage) is
// used deliberately: it supports ERC-6492/1271 contract-wallet signatures,
// so Coinbase Smart Wallet users are not locked out of these flows.

const MAX_AGE_SECONDS = 300; // 5 minutes

/** True if a unix-seconds timestamp is within the last 5 minutes (and not in the future). */
export function isTimestampFresh(timestampSeconds: number): boolean {
  const ageSeconds = Math.floor(Date.now() / 1000) - timestampSeconds;
  return ageSeconds >= 0 && ageSeconds <= MAX_AGE_SECONDS;
}

/**
 * Builds the canonical message a wallet signs to prove ownership of an
 * address for a specific action. Binding the action + fields into the
 * message means a signature can't be repointed at a different mutation.
 */
export function buildOwnershipMessage(
  action: string,
  fields: Record<string, string>,
  timestampSeconds: number,
): string {
  const lines = [`BasePay Ownership Proof`, `Action: ${action}`];
  for (const [key, value] of Object.entries(fields)) {
    lines.push(`${key}: ${value}`);
  }
  lines.push(`Timestamp: ${timestampSeconds}`);
  return lines.join("\n");
}

// ── Signature replay guard (shared with developer.ts) ──────────────────────
// Each signature can only be consumed once, even within its validity window.
const _usedSignatures = new Map<string, number>(); // signature → expiry epoch ms
const SIG_TTL_MS = 6 * 60 * 1000; // wider than MAX_AGE_SECONDS

/** Returns true and records the signature if unseen; false if already used. */
export function consumeSignature(signature: string): boolean {
  const now = Date.now();
  if (_usedSignatures.has(signature)) return false;
  _usedSignatures.set(signature, now + SIG_TTL_MS);
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [sig, expiry] of _usedSignatures) {
    if (expiry < now) _usedSignatures.delete(sig);
  }
}, 5 * 60 * 1000).unref();

// ── Reusable-proof verification cache (reads only) ──────────────────────────
// For `singleUse: false` callers (read endpoints), the same signature is
// legitimately presented on every poll/refetch within its validity window.
// Re-running the RPC-backed verifyMessage (an eth_call for ERC-6492 smart
// wallets) on every request would be wasteful and could hammer the RPC under
// React Query refetch storms. We cache a *positive* verification result
// keyed by the signature itself — the signature already cryptographically
// binds address + action + fields + timestamp, so caching the verified
// outcome introduces no new trust; it only skips redundant RPC calls. The
// timestamp freshness check below still runs unconditionally on every call.
type CachedProof = { address: string; message: string; expiresAt: number };
const _verifiedProofCache = new Map<string, CachedProof>(); // signature → proof

setInterval(() => {
  const now = Date.now();
  for (const [sig, proof] of _verifiedProofCache) {
    if (proof.expiresAt < now) _verifiedProofCache.delete(sig);
  }
}, 5 * 60 * 1000).unref();

export type OwnershipProofFailure = { ok: false; status: number; error: string };
export type OwnershipProofResult = { ok: true } | OwnershipProofFailure;

/**
 * Verifies that `signature` was produced by `address` signing the canonical
 * ownership message for `action` + `fields` + `timestamp`, and that the
 * timestamp is fresh.
 *
 * By default (`singleUse: true`, the historical behavior) the signature may
 * only be used once — appropriate for mutations (POST/DELETE/PATCH), where
 * replaying a captured signature could repeat a state change.
 *
 * Pass `singleUse: false` for read-only endpoints that need to present the
 * same proof across repeated requests within the freshness window (e.g.
 * React Query refetches). Reads have no side effects, so replay only lets
 * someone re-read data they (or whoever captured the signature) already had
 * one-time access to — a materially smaller risk than mutation replay, and
 * bounded by the same 5-minute window.
 */
export async function verifyOwnershipProof(opts: {
  address: string;
  action: string;
  fields: Record<string, string>;
  timestamp: number;
  signature: string;
  singleUse?: boolean;
}): Promise<OwnershipProofResult> {
  const singleUse = opts.singleUse ?? true;

  if (!Number.isFinite(opts.timestamp) || !isTimestampFresh(opts.timestamp)) {
    return { ok: false, status: 400, error: "Signature timestamp too old or in the future — re-sign" };
  }

  const addressLc = opts.address.toLowerCase();
  const cached = !singleUse ? _verifiedProofCache.get(opts.signature) : undefined;
  const message = buildOwnershipMessage(opts.action, opts.fields, opts.timestamp);

  let valid = false;
  if (cached && cached.address === addressLc && cached.message === message && cached.expiresAt >= Date.now()) {
    valid = true;
  } else {
    try {
      valid = await basePublicClient.verifyMessage({
        address: opts.address as `0x${string}`,
        message,
        signature: opts.signature as Hex,
      });
    } catch {
      valid = false;
    }
  }

  if (!valid) {
    return { ok: false, status: 401, error: "Signature verification failed" };
  }

  if (singleUse) {
    if (!consumeSignature(opts.signature)) {
      return { ok: false, status: 401, error: "Signature already used — sign again" };
    }
  } else {
    _verifiedProofCache.set(opts.signature, {
      address: addressLc,
      message,
      expiresAt: (opts.timestamp + MAX_AGE_SECONDS) * 1000,
    });
  }

  return { ok: true };
}
