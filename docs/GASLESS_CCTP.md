# Gasless CCTP Cross-Chain Transfers

BasePay implements a fully gasless USDC cross-chain bridge using Circle's **Cross-Chain Transfer Protocol (CCTP v1)**. Users burn USDC on a source chain; a server-side relayer pays the gas to mint on the destination chain. The user only ever needs USDC — no ETH on either chain.

Relevant Base ecosystem repos explored while building this feature:

| Repo | Notes |
|------|-------|
| [base/docs](https://github.com/base/docs) | Official Base documentation, CCTP integration guide |
| [base/paymaster](https://github.com/base/paymaster) | ERC-4337 VerifyingPaymaster — gas sponsorship for UserOps |
| [base/op-viem](https://github.com/base/op-viem) | Viem extensions for OP Stack chains |
| [coinbase/onchainkit](https://github.com/coinbase/onchainkit) | UI components used across the dApp |
| [osr21/arc-relay-bridge](https://github.com/osr21/arc-relay-bridge) | Prior CCTP V2 reference implementation; issues document several hard-won quirks |

---

## Protocol Overview

CCTP uses a **burn-and-mint** model. USDC is not locked in a bridge contract; it is cryptographically destroyed on the source chain and freshly minted on the destination chain by Circle's authorised `MessageTransmitter`. Circle's Attestation API signs the burn event before the mint is permitted.

```
User  ──┬──→  approve(TokenMessenger, amount)          ← ERC-20 allowance
        └──→  depositForBurn(amount, destDomain,       ← burns USDC on src
                             mintRecipient, burnToken)
                   │
                   │  Circle confirms ~20 blocks (~20s on Base)
                   ▼
        circle.com/attestations/{messageHash}  ── status: "complete", attestation: "0x…"
                   │
                   ▼
        ┌─────────────────────────────┐
        │  Self-relay (user)          │  switch chain → receiveMessage(message, attestation)
        │  Gasless relay (BasePay)    │  POST /api/cctp/relay-receive → server calls receiveMessage
        └─────────────────────────────┘
```

---

## Supported Chains (CCTP v1 Mainnet)

| Chain | CCTP Domain | TokenMessenger | MessageTransmitter |
|-------|-------------|----------------|--------------------|
| Base | 6 | `0x1682Ae6375C4E4A97e4B583BC394c861A46D8962` | `0xAD09780d193884d503182aD4588450C416D6F9D4` |
| Ethereum | 0 | `0xBd3fa81B58Ba92a82136038B25aDec7066af3155` | `0x0a992d191DEeC32aFe36203Ad87D7d289a738F81` |
| Optimism | 2 | `0x2B4069517957735bE00ceE0fadAE88a26365528f` | `0x4d41f22c5a0e5c74090899e5a8fb597a8842b3e8` |
| Arbitrum | 3 | `0x19330d10D9Cc8751218eaf51E8885D058642E08A` | `0xC30362313FBBA5cf9163F0bb16a0e01f01A896ca` |
| Polygon | 7 | `0x9daF8c91AEFAE50b9c0E69629D3F6Ca40cA3B3FE` | `0xF3be9355363857F3e001be68856A2f96b4C39Ba9` |

Contracts: https://developers.circle.com/stablecoins/docs/evm-smart-contracts

---

## Key Files

| File | Purpose |
|------|---------|
| `artifacts/base-pay/src/pages/CrossChain.tsx` | Frontend state machine — burn, attest, receive/relay |
| `artifacts/api-server/src/routes/cctp.ts` | Server routes: attestation proxy, gasless relay, relay status |
| `lib/api-spec/openapi.yaml` | OpenAPI definitions for all CCTP endpoints |

---

## Implementation Details

### Phase 1 — Burn (`depositForBurn`)

1. Wallet must be on the **source chain** — `switchChainAsync` if needed.
2. Approve the `TokenMessenger` to spend USDC (standard ERC-20 `approve`).
3. Call `depositForBurn(amount, destinationDomain, mintRecipient, burnToken)`.
   - `mintRecipient` is the destination address padded to 32 bytes: `0x` + addr.slice(2).padStart(64, '0')
   - `burnToken` is the USDC address **on the source chain**
4. Parse the `MessageSent(bytes)` log from the `MessageTransmitter` to get `messageBytes`.
5. Compute `messageHash = keccak256(messageBytes)` — this is the attestation polling key.

### Phase 2 — Attestation

Poll `GET /api/cctp/attestation/{messageHash}` every 5 seconds. The endpoint proxies Circle's Iris API to avoid CORS. Typical wait: **20–90 seconds** on Base (20 block confirmations). The server caches results:

- `pending_confirmations` → 10-second TTL
- `complete` → 5-minute TTL (result is idempotent)

Hard stop at 720 polls (~1 hour) with a user-facing error showing the burn tx link and Circle's status page.

### Phase 3A — Gasless Relay (recommended)

```
POST /api/cctp/relay-receive
Body: { messageBytes: "0x…" }
Response: { txHash: "0x…" }  |  409 (already received)  |  503 + selfRelay:true (low ETH)
```

Server-side flow:
1. Parse `destinationDomain` from `messageBytes` bytes 8–11 (big-endian uint32) — **never trusts** client-supplied `destDomain`.
2. Checks relayer ETH balance on destination chain (minimum 0.0005 ETH).
3. Fetches attestation from Circle directly — **never trusts** client-supplied `attestation`. A crafted attestation would revert on-chain and waste gas.
4. Calls `receiveMessage(messageBytes, attestation)` on the destination `MessageTransmitter`.
5. In-flight dedup (`pendingRelays` Set) prevents concurrent double-submission.
6. Completed relay cache (`completedRelays` Map) returns existing `txHash` on retries.

**Security note:** Because the `mintRecipient` is encoded in `messageBytes` and verified by the CCTP contract, the relay can never redirect funds — only the originally specified address receives the minted USDC.

### Phase 3B — Self-relay (fallback)

When the gasless relay returns 503 with `selfRelay: true` (relayer underfunded), the UI falls back to the self-relay path:

1. `switchChainAsync({ chainId: dest.chain.id })`
2. **400ms stabilisation delay** (see "MetaMask RPC Race" below)
3. `writeContractAsync({ functionName: "receiveMessage", chain: dest.chain, gas: 400_000n })`

---

## Common Errors & Solutions

### 1. `"Invalid destination domain"` — on-chain revert during self-relay

**Root cause:** MetaMask's `wallet_switchEthereumChain` (and `wallet_addEthereumChain`) resolves its Promise before MetaMask's internal JSON-RPC router has fully switched to the new endpoint. Submitting a transaction in the window immediately after the promise resolves can route it to the *source* chain rather than the destination chain. The CCTP `MessageTransmitter` on the source chain rejects it because `destinationDomain` in the message bytes names a different chain.

**On-chain evidence from osr21/arc-relay-bridge#6:**
```
Tx 0x1008a1d8...  →  Base Sepolia  →  REVERTED  (dest domain=26, but tx on chain 84532)
Tx 0x0fc42da8...  →  Arc Testnet  →  SUCCESS   (same attestation, correct chain)
```

**Fix applied in `CrossChain.tsx`:**
```ts
await switchChainAsync({ chainId: dest.chain.id });
// 400ms stabilisation — lets MetaMask's RPC router fully switch
// before wagmi dispatches the transaction.
await new Promise(r => setTimeout(r, 400));
await writeContractAsync({ ..., chain: dest.chain });
```

For a stricter fix (6-retry with transport-level chain verification), see the `getSignerOnChain()` helper implemented in [osr21/arc-relay-bridge](https://github.com/osr21/arc-relay-bridge) commit `22e37a79`.

**References:** [osr21/arc-relay-bridge#6](https://github.com/osr21/arc-relay-bridge/issues/6) · [osr21/arc-relay-bridge#1](https://github.com/osr21/arc-relay-bridge/issues/1)

---

### 2. `"Attestation not yet complete"`

Circle requires ~20 block confirmations on the source chain before signing. On Base (2-second blocks) this is typically 40–90 seconds. On Ethereum (12-second blocks) it can be 4–6 minutes.

If the dApp shows this error immediately after the burn, it simply means the poll hasn't completed yet — continue waiting. The UI polls every 5 seconds and will automatically proceed when Circle responds with `status: "complete"`.

If the wait exceeds 10 minutes, check [status.circle.com](https://status.circle.com). The burn is safe on-chain; the `Resume transfer` feature lets you re-enter the flow from any confirmed burn tx hash.

---

### 3. `503 selfRelay: true` — relayer underfunded

The BasePay relayer wallet (derived from `DEPLOYER_PRIVATE_KEY`) must hold ETH on every destination chain it supports. The relay-status endpoint at `GET /api/cctp/relay-status` shows which chains are currently funded.

Minimum per chain: **0.0005 ETH** (enough for several `receiveMessage` calls at ~150k gas each).

`receiveMessage` gas on each chain (measured):

| Chain | Typical gas | Cost at 1 gwei base fee |
|-------|-------------|------------------------|
| Base | 120–150k | ~0.00015 ETH |
| Ethereum | 120–150k | varies widely |
| Optimism | 120–150k | ~0.00015 ETH |
| Arbitrum | 800k–1.2M (L1 data) | ~0.001 ETH |
| Polygon | 120–150k | ~0.00015 MATIC |

When the relayer is underfunded the UI shows an amber "Relayer unavailable" notice and switches to the self-relay flow.

---

### 4. `409` — message already received

`receiveMessage` is idempotent on the contract side — once a nonce is consumed the call reverts with `"nonce already used"`. The relay endpoint maps this to `409`. From the UI perspective this is a success state: the USDC was already minted.

**Cause:** The user may have clicked the gasless relay button twice, or retried after a tx confirmation timeout. The UI treats 409 as `phase = "done"`.

---

### 5. `"MessageSent event not found"` after `depositForBurn`

The burn tx succeeded but the receipt parser found no `MessageSent(bytes)` log. Possible causes:

- **Wrong `messageTransmitter` address** — check `CHAINS` registry against [Circle's docs](https://developers.circle.com/stablecoins/docs/evm-smart-contracts).
- **Chain mismatch** — the burn tx was fetched from the wrong chain (common in the Resume flow). Select the correct source chain before pasting the burn tx hash.
- **Very old tx** — some RPC providers prune event logs for old transactions. Try a different RPC or query via the block explorer.

---

### 6. `"sender not allowed"` on Base Paymaster (`eth_paymasterAndDataForEstimateGas`)

This error from `https://paymaster.base.org` means the `sender` (smart wallet) has not been allowlisted. Base's public paymaster is **not an open paymaster** — it only sponsors transactions for approved senders.

Observed at: [base/paymaster#30](https://github.com/base/paymaster/issues/30)

**Alternatives:**
- Use Coinbase's CDP Paymaster (requires CDP API key with paymaster scope)
- Use Pimlico, Alchemy, or Biconomy paymasters (open, subscription-based)
- For USDC transfers specifically, use CCTP's gasless relay path (this dApp) — no paymaster needed

---

### 7. Back-to-back transactions underpriced (`arc-relay-bridge#3`)

When submitting multiple transactions in rapid succession (e.g. approve → depositForBurn), the second tx can be underpriced because `eth_gasPrice` returns the chain's baseline without accounting for pending tx inflation.

**Observed on Arc Testnet.** On Base and mainnet this is less common due to EIP-1559, but can still occur during congestion.

**Mitigation in BasePay:** Each transaction is sent sequentially after the previous receipt is confirmed (`waitForTransactionReceipt` before the next `writeContractAsync`). This eliminates the back-to-back pricing race entirely.

For relayer transactions where speed matters, add a 30% gas price premium: `maxFeePerGas = estimatedMaxFee * 130n / 100n`.

---

## Deployment Checklist

- [ ] `DEPLOYER_PRIVATE_KEY` wallet holds ETH on every destination chain (min 0.0005 ETH each)
- [ ] Relayer address funded on Base, Ethereum, Optimism, Arbitrum, Polygon
- [ ] Check `GET /api/cctp/relay-status` — all chains should show `true`
- [ ] Verify `MessageTransmitter` addresses match Circle's published registry
- [ ] Circle Iris API rate limits: ~10 req/s; the attestation cache prevents hammering it

## Useful Links

- [Circle CCTP v1 docs](https://developers.circle.com/stablecoins/docs/cctp-getting-started)
- [Circle EVM smart contract addresses](https://developers.circle.com/stablecoins/docs/evm-smart-contracts)
- [Circle Attestation API reference](https://developers.circle.com/stablecoins/reference/getattestation)
- [Circle status page](https://status.circle.com)
- [Base CCTP integration guide](https://docs.base.org/tools/cross-chain/cctp)
- [osr21/arc-relay-bridge](https://github.com/osr21/arc-relay-bridge) — Reference CCTP V2 dApp with detailed issue log
