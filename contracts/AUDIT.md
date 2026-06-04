# BasePay V2 Smart Contract Audit

**Date:** 2026-06-04  
**Tool:** Slither v0.11.5 (static analysis)  
**Compiler:** solc v0.8.35+commit.47b9dedd  
**Network:** Base Mainnet (chainId 8453)

---

## Deployed & Verified Contracts

| Contract | Address | BaseScan |
|---|---|---|
| BasePayRouterV2 | `0x756f516cdf5eb98e140eba44119b22fc0f0bb63f` | ✅ Verified |
| BatchPayV2 | `0xe40d2292c050566d16cecda74627b70778806c68` | ✅ Verified |
| EscrowV2 | `0x1eb2b1e8dda64fc4ccb0537574f2a2ca9f307499` | ✅ Verified |
| SubscriptionManagerV2 | `0x101918a252b3852ac4b50b7bbf2525d3084d5421` | ✅ Verified |

Compiler settings: optimizer enabled, 200 runs.

---

## Findings

### MEDIUM — SubscriptionManagerV2: Unrestricted `charge()` caller

**Detector:** `arbitrary-send-erc20`  
**File:** `SubscriptionManagerV2.sol#139-158`

```solidity
function charge(uint256 id) external {
    // anyone can call this — no msg.sender restriction
    IERC20(s.token).transferFrom(s.payer, s.payee, net);
}
```

**Impact:** Any address (not just the payee) can trigger a subscription charge as soon as `block.timestamp >= due`. This is partly intentional (allows automation services to trigger charges), but a malicious actor could:
- Front-run the payee and trigger the exact-boundary charge first (no financial loss, just MEV-style timing manipulation)
- Spam `charge()` calls exactly at each interval (the interval check prevents double-charging, so no fund loss)

**Actual exploitability:** Low — the payer explicitly consented to recurring charges when subscribing, and the interval guard prevents over-charging. No funds can be stolen beyond what the subscription agreement authorises.

**Recommendation for future deployment:** Add `require(msg.sender == s.payee || msg.sender == owner, "SubMgrV2: not authorised")` to `charge()`. This restricts who can trigger the charge while still allowing the owner to run an automation service.

---

### LOW — EscrowV2 / SubscriptionManagerV2: Checks-Effects-Interactions violation

**Detector:** `reentrancy-benign`  
**Files:** `EscrowV2.sol#104-133`, `SubscriptionManagerV2.sol#92-106`

State variables (`escrowCount`, `escrows[id]`, `subCount`, `subscriptions[id]`) are written **after** an external `transferFrom` call.

**Impact with USDC:** USDC (`0x833589...`) is not ERC-777 and has no receive hooks, so reentrancy via USDC's `transferFrom` is not possible in practice. Risk is **informational** for the current USDC-only deployment.

**Impact if other tokens added:** If the contracts are ever used with ERC-777 tokens or tokens with transfer hooks, an attacker could reenter `_doCreate` before `escrowCount` increments and overwrite the same storage slot.

**Recommendation:** Reorder to follow checks-effects-interactions: increment `id` and write storage *before* calling `transferFrom`.

---

### LOW — BasePayRouterV2 / BatchPayV2 / SubscriptionManagerV2: Event after external call

**Detector:** `reentrancy-events`

Events are emitted after `transferFrom` calls. Not exploitable with USDC but technically violates CEI pattern. Same root cause as finding above.

---

### INFO — Solidity version constraint `^0.8.20`

**Detector:** `solc-version`

`^0.8.20` is a range constraint. The contracts were compiled with `0.8.35` (latest stable). The known bugs listed by Slither for `^0.8.20` — `VerbatimInvalidDeduplication`, `FullInlinerNonExpressionSplitArgumentEvaluationOrder`, `MissingSideEffectsOnSelectorAccess` — **do not affect these contracts** (none use verbatim assembly, inline assembly expression splitting, or selector access side effects).

**Recommendation:** Pin to `pragma solidity 0.8.35;` in future versions.

---

### INFO — Naming convention: `_new` parameters

**Detector:** `naming-convention`

Parameters named `_new` in admin functions (`setFeeCollector`, `setFeeBps`, `transferOwnership`) are not in mixedCase. No functional impact.

---

### INFO — Unindexed event parameters (BasePayRouterV2)

**Detector:** `unindexed-event-address`

`Paused(address)` and `Unpaused(address)` events have no indexed fields. Makes off-chain filtering slightly harder but has no security impact.

---

## Summary Table

| Severity | Count | Status |
|---|---|---|
| High | 0 | — |
| Medium | 1 | Accepted (by design, not exploitable for fund loss) |
| Low | 2 | Accepted (USDC-only, not exploitable) |
| Informational | 3 | Noted |

---

## Notes

- All contracts are **immutable** (no upgradeable proxy) — the owner can only update `feeCollector`, `feeBps`, and `owner` itself.
- The fee cap is hardcoded at `<= 10%` in all constructors and setter guards.
- Escrow and Subscription contracts hold user funds; BatchPay and Router are stateless (funds flow through in a single transaction).
- No ETH handling — contracts are USDC-only and have no `receive()` or `fallback()`.
