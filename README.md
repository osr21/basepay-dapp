# BasePay — USDC Payments on Base

    Open-source USDC payment infrastructure on **Base Mainnet**. Four verified smart contracts, a gasless transfer relayer, and a full React dApp — all permissionless and free to fork or integrate.

    **Live:** [basepay.replit.app](https://basepay.replit.app) &nbsp;·&nbsp; **Chain:** Base Mainnet (chainId 8453) &nbsp;·&nbsp; **Tokens:** USDC · EURC · USDT

    ---

    ## Features

  | Feature | Description |
  |---|---|
  | **Send** | USDC transfer via approve→transfer or EIP-2612 permit (one tx) |
  | **Gasless Transfer** | User signs off-chain (EIP-3009); relayer pays the ETH gas — user pays zero |
  | **Gasless Swap** | Swap USDC ↔ EURC via Aerodrome Finance — one signature, zero ETH, delivered to your wallet |
  | **Cross-Asset Gasless Transfer** | Pay a recipient in a different token — sign once (EIP-3009), relayer swaps via Aerodrome and delivers EURC or USDT to the recipient, zero ETH required |
  | **Cross-Chain Transfer** | Bridge USDC from Base to Ethereum, Optimism, Arbitrum, or Polygon via Circle CCTP v1 — arrives as native USDC, no wrapped tokens |
  | **Batch Pay** | Up to 200 recipients in a single transaction |
  | **Escrow** | Time-locked USDC with release / refund |
  | **Subscriptions** | On-chain recurring charges at fixed intervals |
  | **Payment Requests** | Shareable links that pre-fill recipient and amount |
  | **Basenames** | Forward-resolves `.base.eth` names throughout the dApp |
  | **Coinbase Smart Wallet** | First-class ERC-4337 smart wallet support with identity badge |
  | **EAS Verification** | Coinbase attestation badge on verified accounts via EAS |
  | **x402 Relay API** | Micro-payment–gated developer relay endpoint (x402 protocol) |
  | **Developer API Keys** | Issue scoped API keys with EIP-191 wallet auth and HttpOnly JWT session |
  | **OnchainKit** | Buy USDC button and identity components via Coinbase OnchainKit |

    ---

    ## Cross-Asset Gasless Transfer

    Send USDC to a recipient who receives **EURC or USDT** — with **one EIP-3009 signature and zero ETH**. The sender authorises a transfer of their USDC; the relay wallet collects it, swaps it via [Aerodrome Finance](https://aerodrome.finance), deducts a 0.30% protocol fee, and forwards the output token directly to the intended recipient.

    > This is distinct from the Gasless Swap (which swaps for yourself). Cross-Asset Transfer sends a *different* token to a *different person*, all gaslessly.

    ### Supported token pairs

    | Sender pays | Recipient gets | Pool type |
    |---|---|---|
    | USDC | EURC | Volatile (Aerodrome) |
    | EURC | USDC | Volatile (Aerodrome) |
    | USDC | USDT | Stable (Aerodrome) |

    > **USDT note:** USDT on Base does not implement EIP-3009, so it cannot be used as the *input* token in a gasless flow. It is supported as an *output* token only.

    ### How it works

    ```
    Sender                   BasePay API                       Base Mainnet
     |                            |                                 |
     |-- sign EIP-3009 ---------->| (off-chain, zero gas)           |
     |   (USDC -> relay wallet)   |                                 |
     |                            |                                 |
     |-- POST /api/pay/cross-asset|                                 |
     |                            |-- TX1: transferWithAuthorization>| USDC contract
     |                            |   (sender -> relay, confirmed)  |
     |                            |                                 |
     |                            |-- TX2: swapExactTokensForTokens>| Aerodrome Router
     |                            |   (relay -> pool -> relay)      | (swap lands at relay
     |                            |                                 |  so fee can be split)
     |                            |                                 |
     |                            |-- TX3: transfer(feeCollector) ->| tokenOut contract
     |                            |   (0.30% protocol fee)          |
     |                            |                                 |
     |                            |-- TX4: transfer(recipient) ---->| tokenOut contract
     |<-- { twaHash, swapHash,    |   (net amount to recipient)     |
     |      payHash, amounts } ---|                                 |
    ```

    **Step-by-step:**

    1. **Sender signs** an [EIP-3009](https://eips.ethereum.org/EIPS/eip-3009) `TransferWithAuthorization` message authorising the relay to pull their `tokenIn` — off-chain, no ETH, no wallet transaction.
    2. **TX1 — authorised pull:** Relay calls `transferWithAuthorization(sender -> relay, tokenIn)`. Confirmed on-chain before proceeding.
    3. **TX2 — Aerodrome swap:** Relay calls `swapExactTokensForTokens` on the Aerodrome Router. Output lands at the relay wallet (not the recipient) so the fee can be measured against the *actual* post-slippage output.
    4. **TX3 — protocol fee:** 30 bps of the actual output is sent to the fee collector. TX3 is confirmed before TX4 fires to prevent nonce collision.
    5. **TX4 — delivery:** Net amount forwarded to the recipient in `tokenOut`.

    ### Automatic refund on failure

    If TX2 (swap) or later fails after TX1 succeeds, the relay immediately calls `tokenIn.transfer(sender, amountIn)` to return the original tokens. The sender never loses funds due to a partial failure.

    ```
    TX1 ok -> TX2 fail  ->  refund(tokenIn -> sender)      <- tokens returned
    TX1 ok -> TX2 ok -> TX3 fail  ->  TX4 proceeds with full amount (fee skipped, logged)
    TX1 ok -> TX2 ok -> TX3 ok -> TX4 fail  ->  tokens held at relay (logged for support)
    ```

    ### API reference

    **Get a quote:**
    ```
    GET /api/pay/cross-asset/quote
      ?tokenIn=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913   // USDC
      &tokenOut=0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42  // EURC
      &amountIn=5000000                                       // 5 USDC (6 decimals)
      &recipient=0xRecipientAddress

    -> {
        "amountOut":       "5298741",   // gross output before fee
        "feeAmount":       "15896",     // 30 bps fee
        "feeBps":          30,
        "recipientAmount": "5282845",   // what recipient actually receives
        "amountOutMin":    "5256480",   // slippage floor (50 bps default)
        "poolAddress":     "0xFDF5...",
        "stable":          false,
        "relayerAddress":  "0xdb50..."
      }
    ```

    **Execute the cross-asset payment:**
    ```
    POST /api/pay/cross-asset
    Content-Type: application/json

    {
      "tokenIn":     "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "tokenOut":    "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42",
      "amountIn":    "5000000",
      "owner":       "0xSenderAddress",
      "recipient":   "0xRecipientAddress",
      "stable":      false,
      "validAfter":  "0",
      "validBefore": "1750000000",
      "nonce":       "0xrandom32bytes",
      "v": 27,
      "r": "0x...",
      "s": "0x...",
      "slippageBps": 50
    }

    -> {
        "twaHash":         "0x...",   // TX1 — EIP-3009 pull
        "swapHash":        "0x...",   // TX2 — Aerodrome swap
        "payHash":         "0x...",   // TX4 — delivery to recipient
        "tokenIn":         "0x833...",
        "tokenOut":        "0x60a...",
        "amountIn":        "5000000",
        "grossAmountOut":  "5298741",
        "feeAmount":       "15896",
        "recipientAmount": "5282845",
        "recipient":       "0x..."
      }
    ```

    ### Key design decisions

    | Decision | Reason |
    |---|---|
    | Swap output lands at relay, not recipient | Allows fee split on *actual* post-slippage output, not estimated |
    | TX3 confirmed before TX4 fires | Relay uses the same EOA nonce for both ERC-20 transfers; parallel submission causes a nonce collision and drops TX4 |
    | `gas: 350_000n` override on TX2 | `eth_estimateGas` false-reverts on Aerodrome calls because pending state does not yet reflect TX1's confirmed balance |
    | In-memory nonce guard (`pendingNonces`) | Prevents a duplicate request from firing two TX1s for the same EIP-3009 nonce |
    | Slippage applied to gross output | The swap min-out is computed on the gross amount; fee is taken from whatever actually lands, keeping the math consistent |
    | Aerodrome, not Uniswap V3 | Uniswap V3 has zero USDC/EURC and USDC/USDT liquidity on Base Mainnet |

    ### Token addresses (Base Mainnet)

    | Token | Address | Decimals | EIP-3009 (input) |
    |---|---|---|---|
    | USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | 6 | yes |
    | EURC | `0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42` | 6 | yes |
    | USDT | `0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2` | 6 | no (output only) |

    ---

    ## Gasless Transfer

    The gasless flow lets a user send USDC **without holding any ETH**. The user signs a message in their wallet; a server-side relayer pays the gas and submits the transaction on their behalf.

    ### How it works

    ```
    User                        BasePay API                  Base Mainnet
     |                               |                            |
     |-- sign EIP-3009 message ----->|                            |
     |   (off-chain, zero gas)       |                            |
     |                               |-- validate sig & balance ->|
     |                               |                            |
     |                               |-- transferWithAuthorization>| USDC contract
     |                               |   (relayer pays ETH gas)   |
     |                               |                            |
     |<-------------- txHash --------|<---------- receipt --------|
    ```

    1. **User signs** an [EIP-3009](https://eips.ethereum.org/EIPS/eip-3009) `TransferWithAuthorization` typed message — off-chain, no ETH, no wallet transaction.
    2. **Client posts** the signature + parameters to `POST /api/gasless/transfer`.
    3. **API validates** the request: timing window, USDC balance, and replay protection (in-memory nonce guard -> DB check -> on-chain `authorizationState`).
    4. **Relayer submits** `USDC.transferWithAuthorization(from, to, value, ...)` — paying the Base gas fee from its own ETH balance.
    5. **USDC moves** directly from the user's wallet to the recipient. The relayer never holds the funds.

    ### Smart wallet compatibility

    > **Note:** EIP-3009 gasless transfers require an **EOA (externally owned account)** signature. Smart contract wallets (Coinbase Smart Wallet with Passkeys, Safe, etc.) return signature formats incompatible with USDC's on-chain `ecrecover` check. The dApp detects smart wallets via `eth_getCode` and shows a clear warning before users attempt to sign.

    ### Relay fee

    **Free — 0 USDC.** The relayer covers gas out of the protocol's ETH balance. Gas on Base is typically < $0.01 per transfer.

    ### Limits

    | Parameter | Value |
    |---|---|
    | Maximum relay amount | 1,000,000 USDC |
    | Authorization window | Up to 30 minutes (configurable) |
    | Replay protection | DB nonce cache + on-chain `authorizationState` |

    ### EIP-3009 signature (client-side)

    ```ts
    const sig = await walletClient.signTypedData({
      domain: {
        name: "USD Coin",
        version: "2",
        chainId: 8453,
        verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      },
      types: {
        TransferWithAuthorization: [
          { name: "from",        type: "address" },
          { name: "to",          type: "address" },
          { name: "value",       type: "uint256" },
          { name: "validAfter",  type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce",       type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: { from, to, value, validAfter: 0n, validBefore, nonce },
    });
    ```

    ### Relayer API

    ```
    POST /api/gasless/transfer
    Content-Type: application/json

    {
      "from":        "0xSenderAddress",
      "to":          "0xRecipientAddress",
      "value":       "10000000",
      "validAfter":  "0",
      "validBefore": "1749232000",
      "nonce":       "0xrandom32bytes",
      "v": 27, "r": "0x...", "s": "0x..."
    }

    -> 200 { "txHash": "0x...", "from": "0x...", "to": "0x...", "value": "10000000" }
    -> 400 { "error": "Nonce already used" }
    -> 400 { "error": "Insufficient USDC balance" }
    -> 500 { "error": "Relayer not configured" }
    ```

    Check relayer status:
    ```
    GET /api/gasless/fee
    -> { "relayFeeUsdc": "0.00", "relayerReady": true, "relayerEthBalance": "0.05", "networkName": "Base Mainnet" }
    ```

    ### Running your own relayer

    ```bash
    DEPLOYER_PRIVATE_KEY=0xYourPrivateKey   # must hold ETH on Base for gas
    DATABASE_URL=postgres://...
    ```

    ### Why EIP-3009 and not EIP-2612?

    | | EIP-2612 (Permit) | EIP-3009 (TransferWithAuthorization) |
    |---|---|---|
    | **What it authorises** | A spender to pull funds later | A specific transfer of a specific amount |
    | **Used for** | Gasless approve -> contract pulls | Gasless send -> relayer pushes |
    | **Replay risk** | Spender can pull at any time within deadline | One-time: nonce + `authorizationState` |
    | **Best for** | Contracts needing allowance | Direct user-to-user transfers |

    BasePay uses **both**: EIP-2612 permit for Router/Escrow/Batch/Subscription contracts, EIP-3009 for the gasless peer-to-peer relayer.

    ---

    ## Gasless USDC ↔ EURC Swap

    Swap between USDC and EURC on Base with **one off-chain signature and zero ETH**. Routed through [Aerodrome Finance](https://aerodrome.finance).

    > **Full technical documentation:** [docs/GASLESS_SWAP.md](./docs/GASLESS_SWAP.md)

    ```
    User                     BasePay API                    Base Mainnet
     |                            |                               |
     |-- GET /api/swap/quote ---->|-- getAmountsOut (best pool) ->| Aerodrome
     |<-- { amountOut, relayer } -|                               |
     |                            |                               |
     |-- sign EIP-3009 -----------| (off-chain, no gas)           |
     |   (user -> relay wallet)   |                               |
     |                            |                               |
     |-- POST /api/swap/execute ->|                               |
     |                            |-- TX1: transferWithAuthorization>| token contract
     |                            |   (user -> relay, confirmed)  |
     |                            |-- TX2: swapExactTokensForTokens>| Aerodrome Router
     |                            |   (relay -> pool -> user)     |
     |<-- { txHash } -------------|                               |
    ```

    ```
    GET /api/swap/quote?tokenIn=0x833...&tokenOut=0x60a...&amountIn=2000000
    -> { "amountOut": "2298969", "amountOutMin": "2275979", "fee": 30, "stable": false, ... }

    POST /api/swap/execute
    { "tokenIn": "...", "tokenOut": "...", "amountIn": "2000000", "owner": "0x...",
      "stable": false, "validAfter": "0", "validBefore": "...",
      "nonce": "0x...", "v": 27, "r": "0x...", "s": "0x...", "slippageBps": 50 }
    -> { "txHash": "0x...", "amountOutAfterFee": "2298969" }
    ```

    ### Confirmed live transactions

    | Direction | Amount | TX |
    |---|---|---|
    | EURC -> USDC | 2 EURC -> 2.2989 USDC | [`0x7b4c9bcc`](https://basescan.org/tx/0x7b4c9bcc2c8443c7c69b9fc21a96847bcbdf161283a5a5aa8c60fc8161c807cb) |
    | USDC -> EURC | 2 USDC -> 1.7300 EURC | [`0xc19b0154`](https://basescan.org/tx/0xc19b01544385ac3e933ae4506f2a420e4f714f63636636b8f5830f995f1b43fc) |

    ---

    ## Cross-Chain Transfer (CCTP)

    Send USDC from Base to **Ethereum, Optimism, Arbitrum, or Polygon** using [Circle CCTP v1](https://developers.circle.com/stablecoins/cctp-getting-started). Arrives as **native USDC** — no wrapped tokens, no bridge liquidity risk.

    ```
    User (Base)         Base Mainnet        Circle Attestation   Destination Chain
     |                       |                     |                    |
     |-- 1. approve -------->| USDC.approve        |                    |
     |-- 2. depositForBurn ->| TokenMessenger      |                    |
     |<-- burnTxHash --------|                     |                    |
     |                                             |                    |
     |-- 3. poll GET /api/cctp/attestation/{hash}->|                    |
     |<-- { status: "complete", attestation } -----|                    |
     |                                                                   |
     |-- 4. receiveMessage --------------------------------------------->| MessageTransmitter
     |<-- USDC minted ---------------------------------------------------|
    ```

    ### CCTP v1 Addresses (Base Mainnet)

    | Contract | Address |
    |---|---|
    | USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
    | TokenMessenger | `0x1682Ae6375C4E4A97e4B583BC394c861A46D8962` |
    | MessageTransmitter | `0xAD09780d193884d503182aD4588450C416D6F9D4` |

    | Destination | CCTP Domain | MessageTransmitter |
    |---|---|---|
    | Ethereum | `0` | `0x0a992d191DEeC32aFe36203Ad87D7d289a738F81` |
    | Optimism | `2` | `0x4D41f22c5a0e5c74090899E5a8Fb597a8842b3e8` |
    | Arbitrum | `3` | `0xC30362313FBBA5cf9163F0bb16a0e01f01A896ca` |
    | Polygon  | `7` | `0xF3be9355363857F3e001be68856A2f96b4C39Ba9` |

    Attestation on Base Mainnet typically takes **10–20 minutes**. The burn is final and irreversible once confirmed.

    ---

    ## Developer API Keys

    Operators can issue scoped API keys for programmatic relay access. Auth uses EIP-191 wallet signatures to issue an HttpOnly JWT session — key material never touches JS heap.

    ```
    POST /api/developer/auth    <- { address, timestamp, signature }  -> sets HttpOnly JWT cookie
    POST /api/developer/keys    <- { name }                           -> { key: "bpk_...", id }
    GET  /api/developer/keys                                          -> [{ id, name, keyPrefix, ... }]
    POST /api/developer/keys/:id/revoke
    POST /api/developer/logout
    ```

    Keys are stored as SHA-256 hashes; only the `keyPrefix` (first 12 chars) is stored in plaintext for display. Full key is shown once at creation.

    ---

    ## Coinbase Smart Wallet & EAS Identity

    BasePay adds the Coinbase Smart Wallet as a first-class connector (`preference: { options: "all" }`) and shows an EAS attestation badge for Coinbase-verified wallets.

    | EAS Contract | Address |
    |---|---|
    | EAS (Base Mainnet) | `0x4200000000000000000000000000000000000021` |
    | Coinbase Attester | `0x357458739F90461b99789350868CD7CF330Dd7EE` |

    Schemas: Coinbase Verified Account (`0xf8b05c...`) and Coinbase One (`0x180190...`).

    ---

    ## x402 Premium Relay API

    Micro-payment–gated relay using the [x402 protocol](https://www.x402.org).

    ```
    GET  /api/v2/relay/info    -> { version, protocol, price, network, payTo, ... }
    POST /api/v2/relay         <- X-Payment: <x402-header>   -> { txHash }
    ```

    Set `FEE_COLLECTOR_ADDRESS` to enable. The public facilitator at `https://x402.org/facilitator` supports Base Sepolia only — use a CDP or self-hosted facilitator for Base Mainnet.

    ---

    ## OnchainKit

    [`FundButton`](https://onchainkit.xyz) on the Dashboard opens Coinbase Pay for onramp. `OnchainKitProvider` wraps the app with `VITE_CDP_API_KEY`.

    > OnchainKit 1.x imports `wagmi/experimental` (removed in wagmi v3). A `wagmi-experimental-shim.ts` stub + Vite alias keeps it functional.

    ---

    ## Smart Contracts

    All four contracts source-verified on Basescan.

    | Contract | Address | Basescan |
    |---|---|---|
    | BasePayRouterV2 | `0x756f516cdf5eb98e140eba44119b22fc0f0bb63f` | [↗](https://basescan.org/address/0x756f516cdf5eb98e140eba44119b22fc0f0bb63f#code) |
    | BatchPayV2 | `0xe40d2292c050566d16cecda74627b70778806c68` | [↗](https://basescan.org/address/0xe40d2292c050566d16cecda74627b70778806c68#code) |
    | EscrowV2 | `0x1eb2b1e8dda64fc4ccb0537574f2a2ca9f307499` | [↗](https://basescan.org/address/0x1eb2b1e8dda64fc4ccb0537574f2a2ca9f307499#code) |
    | SubscriptionManagerV2 | `0x101918a252b3852ac4b50b7bbf2525d3084d5421` | [↗](https://basescan.org/address/0x101918a252b3852ac4b50b7bbf2525d3084d5421#code) |

    Fee: **0.30%** on all contract payments. Relay fee: **free**.

    ---

    ## Security

    | Area | Change |
    |---|---|
    | Dependency CVEs | 7 CVEs patched via pnpm overrides (esbuild, brace-expansion, path-to-regexp, etc.) |
    | Rate limiting | Relay endpoints: 20 req/min per IP; general API: 120 req/min |
    | JWT storage | Auth token stored in HttpOnly cookie — not accessible from JS |
    | Input validation | All endpoints validated with Zod schemas before any chain call |
    | CORS | Public relay endpoints open (rate-limited); all other routes restricted to Replit domains |

    ---

    ## Tech Stack

    - **Frontend:** React 19, Vite, wagmi v3, viem v2, TailwindCSS, Wouter
    - **Wallet:** wagmi `coinbaseWallet` connector (ERC-4337 smart wallet + EOA)
    - **Identity:** EAS on Base, Basenames (ENS L2)
    - **Onramp:** Coinbase OnchainKit `FundButton`
    - **Swap / Cross-Asset:** Aerodrome Finance (USDC/EURC/USDT, EIP-3009 gasless relay)
    - **Backend:** Express 5, Node.js 24, TypeScript 5.9
    - **Database:** PostgreSQL + Drizzle ORM
    - **Chain:** Base Mainnet (chainId 8453)
    - **Contracts:** Solidity 0.8.35, verified via Foundry
    - **Payment protocol:** [x402](https://www.x402.org)
    - **Builder attribution:** ERC-8021 appended to every relayed tx
    - **Monorepo:** pnpm workspaces, OpenAPI-first codegen (Orval)

    ---

    ## Repository Layout

    ```
    artifacts/
      api-server/src/routes/
        gasless.ts          EIP-3009 relay
        swap.ts             Aerodrome gasless swap
        crossasset.ts       Cross-asset gasless pay (USDC->EURC/USDT)
        cctp.ts             Circle CCTP bridge
        x402relay.ts        x402 payment-gated relay
        developer.ts        API key management + EIP-191 auth
        paymentRequests.ts  Shareable payment links
        contacts.ts         Address book
      base-pay/src/
        lib/
          wagmi.ts                   wagmi config, connectors, addresses
          wagmi-experimental-shim.ts OnchainKit v1 compat shim
          useCoinbaseAttestation.ts  EAS attestation hook
          useUsdcAuthorization.ts    EIP-3009 signing hook
          useBasename.ts             .base.eth resolution
        pages/
          Dashboard.tsx         Balance + Buy USDC
          GaslessTransfer.tsx   EIP-3009 + smart wallet detection
          Swap.tsx              Aerodrome USDC<->EURC swap
          CrossAsset.tsx        Cross-asset gasless payment
          CrossChain.tsx        CCTP bridge UI
          BatchPay.tsx / Escrow.tsx / Subscriptions.tsx
          Developer.tsx         API key management
    contracts/
      *.sol / *.json / addresses.json
      README.md              Integration guide (viem, ethers, wagmi examples)
    docs/
      GASLESS_SWAP.md / ARCHITECTURE.md / GETTING_STARTED.md
    lib/
      api-spec/              OpenAPI spec + Orval-generated hooks
      db/                    Drizzle schema + migrations
    ```

    ---

    ## Integrating into your own dApp

    ```bash
    curl https://raw.githubusercontent.com/osr21/basepay-dapp/main/contracts/addresses.json

    git clone --depth=1 --filter=blob:none --sparse https://github.com/osr21/basepay-dapp.git
    cd basepay-dapp && git sparse-checkout set contracts
    ```

    See [`contracts/README.md`](./contracts/README.md) for viem, ethers.js, and wagmi examples.

    ---

    ## Known Limitations

    | Limitation | Detail |
    |---|---|
    | EIP-3009 requires EOA | Smart contract wallets cannot produce signatures compatible with USDC's `ecrecover`. Detected and warned in-app. |
    | USDT input not supported | USDT on Base has no EIP-3009 support; it can only be a *received* token in cross-asset flows. |
    | x402 facilitator testnet-only | Public facilitator supports Base Sepolia only. Use CDP or self-hosted for mainnet. |
    | Relayer ETH balance | Relay must hold ETH on Base. UI warns when balance drops below 0.001 ETH. |
    | CCTP attestation latency | Circle attestation on mainnet takes 10–20 minutes. Burn is irreversible. |
    | Cross-asset TX3/TX4 ordering | TX3 (fee) must confirm before TX4 (payout) — same EOA, sequential nonces required. |
    | Swap server clock drift | Swap deadline set 2 hours out to compensate for server clock skew vs Base block.timestamp. |

    ---

    ## License

    MIT
  