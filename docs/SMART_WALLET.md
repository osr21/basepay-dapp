# Smart Wallet Gas Sponsorship

BasePay's **Smart Wallet Pay** page lets users send USDC with **zero ETH** using Coinbase Smart Wallet and the **CDP Paymaster** — a fully on-chain account abstraction flow that sponsors gas costs at the protocol level.

**Live:** [basepay.replit.app/smart-wallet](https://basepay.replit.app/smart-wallet)

---

## Overview

| Parameter | Value |
|---|---|
| Wallet | Coinbase Smart Wallet (ERC-4337) |
| Gas sponsor | CDP Paymaster (Coinbase Developer Platform) |
| Standard | ERC-4337 Account Abstraction |
| ETH cost to user | **$0.00** |
| Seed phrase required | **No** — uses passkeys |
| Component | OnchainKit `<Transaction>` |
| Network | Base Mainnet |

---

## How It Works

```
User (Passkey)           Coinbase Smart Wallet      CDP Paymaster         Base Mainnet
 │                               │                       │                     │
 │─ click Send ─────────────────▶│                       │                     │
 │                               │── build UserOperation ▶                     │
 │                               │                       │                     │
 │◀─ passkey prompt ─────────────│                       │                     │
 │─ biometric sign ─────────────▶│                       │                     │
 │                               │── request sponsorship ─▶│                  │
 │                               │◀─ paymasterData ────────│                  │
 │                               │                       │                     │
 │                               │── submit UserOp ─────────────────────────▶ │
 │                               │   (Bundler → EntryPoint → USDC transfer)   │
 │◀─ txHash ─────────────────────│◀──────────────────────────────────────────  │
```

1. User connects **Coinbase Smart Wallet** (creates a passkey-secured smart contract wallet in one tap — no seed phrase).
2. User enters recipient and amount, then clicks **Send USDC**.
3. OnchainKit's `<Transaction>` component builds an ERC-4337 `UserOperation` and requests **gas sponsorship** from the CDP Paymaster.
4. The Paymaster authorises and attaches `paymasterData` to the UserOp.
5. The signed UserOp is submitted to the Base bundler. The `EntryPoint` contract calls the Smart Wallet, which executes the USDC transfer.
6. **Gas is deducted from the Paymaster's prepaid balance** — the user pays nothing in ETH.

---

## Architecture

### ERC-4337 Account Abstraction

Smart Wallet gas sponsorship uses the ERC-4337 standard:

- **Smart Wallet** — ERC-4337 smart contract deployed per user, secured by a passkey (WebAuthn P-256 credential). No private key, no seed phrase.
- **Bundler** — collects UserOperations and submits them on-chain as regular transactions.
- **EntryPoint** — singleton contract (`0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789`) that validates and executes UserOps.
- **Paymaster** — contract/service that pays the bundler fee on behalf of the user. BasePay uses Coinbase's CDP Paymaster.

### CDP Paymaster

The CDP Paymaster URL is:

```
https://api.developer.coinbase.com/rpc/v1/base/<CDP_API_KEY>
```

Where `CDP_API_KEY` is the Coinbase Developer Platform API key (set as `VITE_ONCHAINKIT_API_KEY`).

Sponsorship rules are configured in the CDP dashboard. By default, the Paymaster sponsors all UserOps from wallets that originate from your dApp.

---

## Frontend Integration

### OnchainKit `<Transaction>` Component

```tsx
import {
  Transaction,
  TransactionButton,
  TransactionStatus,
  TransactionStatusLabel,
  TransactionStatusAction,
} from "@coinbase/onchainkit/transaction";
import type { Call } from "@coinbase/onchainkit/transaction";

const CDP_PAYMASTER_URL =
  `https://api.developer.coinbase.com/rpc/v1/base/${import.meta.env.VITE_ONCHAINKIT_API_KEY}`;

const capabilities = {
  paymasterService: { url: CDP_PAYMASTER_URL },
};

const calls: Call[] = [
  {
    to:   USDC_ADDRESS,
    data: encodeFunctionData({
      abi:          ERC20_TRANSFER_ABI,
      functionName: "transfer",
      args:         [recipient, amount],
    }),
  },
];

<Transaction
  chainId={base.id}
  calls={calls}
  capabilities={capabilities}
  onSuccess={(response) => console.log("txHash:", response.transactionReceipts[0].transactionHash)}
  onError={(err) => console.error(err)}
>
  <TransactionButton text="Send USDC" />
  <TransactionStatus>
    <TransactionStatusLabel />
    <TransactionStatusAction />
  </TransactionStatus>
</Transaction>
```

### Connector: Smart Wallet Only

A dedicated `coinbaseWallet` connector is exported with `preference: { options: "smartWalletOnly" }` to ensure only smart wallet connections are made on this page:

```ts
// artifacts/base-pay/src/lib/wagmi.ts
import { coinbaseWallet } from "wagmi/connectors";

export function makeCoinbaseSmartWalletConnector() {
  return coinbaseWallet({
    appName:    "BasePay",
    appLogoUrl: "https://basepay.replit.app/favicon.svg",
    preference: { options: "smartWalletOnly" as const },
  });
}
```

The Smart Wallet page detects whether the connected wallet is a smart wallet via `connector.id === "coinbaseWalletSDK"`. If an EOA is connected, it shows a yellow warning and disables the gas-sponsored path (EOA wallets do not support ERC-4337 Paymasters in the standard wagmi flow — use the Gasless Transfer page instead).

### wagmi/experimental Shim

OnchainKit 1.x imports `useShowCallsStatus`, `useSendCalls`, `useCallsStatus`, `useWriteContracts`, and `useCapabilities` from `wagmi/experimental`, which was removed in wagmi v3. A Vite alias shim re-exports stubs:

```ts
// artifacts/base-pay/src/lib/wagmi-experimental-shim.ts
export function useSendCalls()       { return { sendCalls: undefined, isPending: false }; }
export function useCallsStatus()     { return { data: undefined, isLoading: false }; }
export function useWriteContracts()  { return { writeContracts: undefined, isPending: false }; }
export function useCapabilities()    { return { data: undefined, isLoading: false }; }
export function useShowCallsStatus() { return { showCallsStatus: undefined }; }
```

```ts
// artifacts/base-pay/vite.config.ts (resolve.alias)
"wagmi/experimental": path.resolve(import.meta.dirname, "src/lib/wagmi-experimental-shim.ts"),
```

---

## Configuration

| Env Var | Where | Purpose |
|---|---|---|
| `VITE_ONCHAINKIT_API_KEY` | `artifacts/base-pay/.env` | CDP API key — used for OnchainKit provider and Paymaster URL |

Set this to your [Coinbase Developer Platform](https://portal.cdp.coinbase.com) API key. The same key powers both the OnchainKit UI components and the Paymaster sponsorship.

---

## Comparison with EIP-3009 Gasless Relayer

| | EIP-3009 Gasless Relayer | Smart Wallet (ERC-4337) |
|---|---|---|
| **Wallet type** | EOA only | Smart Wallet only |
| **ETH cost** | $0 (relayer pays) | $0 (Paymaster pays) |
| **Seed phrase** | Required | **Not required** (passkey) |
| **Approval required** | No | No |
| **Miner bribe / priority fee** | Relayer pays | Paymaster pays |
| **Page** | `/gasless` | `/smart-wallet` |
| **Infrastructure** | BasePay relayer (self-hosted) | Coinbase CDP Paymaster |

---

## Base Cobalt Readiness

Base's **Cobalt** upgrade introduces native gas sponsorship at the protocol level. The Smart Wallet / Paymaster architecture is forward-compatible: once Cobalt activates, the Paymaster can leverage protocol-level gas credits rather than a prepaid balance, reducing operational overhead. No code changes are required.

---

## Known Limitations

| Limitation | Detail |
|---|---|
| Smart Wallet required | This page does not support EOA wallets. Use `/gasless` for EOAs. |
| Coinbase Wallet extension | Desktop users need the Coinbase Wallet browser extension or the Coinbase mobile app. |
| EIP-3009 incompatible | Smart wallets cannot sign EIP-3009 messages for the gasless relayer (USDC's `ecrecover` check fails for contract wallets). |
| Paymaster balance | The CDP Paymaster has a prepaid gas balance that needs periodic top-up in the CDP dashboard. |
