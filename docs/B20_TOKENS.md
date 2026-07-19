# B20 Token Standard

  > Added: July 2026 · Route: `/b20` · Files: `B20Tokens.tsx`, `wagmi.ts`

  ## Overview

  **B20** is Base's native token standard, launched with the [Beryl upgrade](https://blog.base.dev/introducing-base-beryl) on July 8, 2026. Unlike ERC-20 contracts deployed as EVM bytecode, B20 tokens are implemented as **Rust precompiles** inside the Base-Reth node — cheaper, faster, and with compliance primitives built into the chain itself.

  BasePay's `/b20` page lets users:
  - Look up any B20 token (or any ERC-20) by address — displays name, symbol, decimals, supply, balance
  - Transfer tokens with an optional **native on-chain memo** via `transferWithMemo()`
  - Create new B20 tokens via the factory precompile (code example + one-click deploy)
  - Browse the multi-currency stablecoin grid (all B20 STABLECOIN variants)

  ---

  ## Key Addresses

  | Contract | Address | Type |
  |---|---|---|
  | B20 Factory | `0xB20f000000000000000000000000000000000000` | Precompile |
  | USDC (Circle) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | ERC-20 (pre-B20, live) |
  | EURC (Circle) | `0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42` | ERC-20 (pre-B20, live) |

  B20 tokens created via the factory are deployed to deterministic addresses starting with `0xB200...` (derived from variant + deployer + salt).

  ---

  ## Factory API

  The B20 factory precompile exposes two functions:

  ### `createB20(variant, salt, params, initCalls)` → `tokenAddress`

  Creates a new B20 token. Reverts with:
  - `TokenAlreadyExists` if the deterministic address is already occupied
  - `UnsupportedVersion` if the variant is not `0` (ASSET) or `1` (STABLECOIN)
  - `InvalidDecimals` if the requested decimals are out of range

  | Argument | Type | Description |
  |---|---|---|
  | `variant` | `uint8` | `0` = ASSET, `1` = STABLECOIN |
  | `salt` | `bytes32` | Determines the final token address — use `keccak256(toBytes("your-project-name"))` |
  | `params` | `bytes` | ABI-encoded creation params (see below) |
  | `initCalls` | `bytes[]` | Optional post-creation calls (e.g. mint initial supply) |

  **ASSET params:** `abi.encode(name, symbol, initialAdmin, decimals, rebaseMultiplier)`

  **STABLECOIN params:** `abi.encode(name, symbol, initialAdmin, currencyCode)` — always 6 decimals, currency code is the ISO 4217 string (e.g. `"BRL"`)

  ### `getB20Address(variant, deployer, salt)` → `address`

  View function — predict the token address before deploying. Use this to show users "Your token will be at 0x..." before they confirm.

  ---

  ## Full Code Example

  ```typescript
  import { encodeAbiParameters, keccak256, toBytes } from "viem";

  const B20_FACTORY = "0xB20f000000000000000000000000000000000000";

  const VARIANT_STABLECOIN = 1n; // 0 = ASSET, 1 = STABLECOIN
  const salt = keccak256(toBytes("my-brl-stablecoin-v1"));

  // Encode STABLECOIN params
  const params = encodeAbiParameters(
    [
      { name: "name",         type: "string"  },
      { name: "symbol",       type: "string"  },
      { name: "initialAdmin", type: "address" },
      { name: "currencyCode", type: "string"  },
    ],
    ["Brazilian Real Coin", "BRLC", "0xYOUR_ADMIN_ADDRESS", "BRL"],
  );

  // 1. Preview the address before deploying (view call — free)
  const predicted = await publicClient.readContract({
    address: B20_FACTORY,
    abi: [{
      name: "getB20Address", type: "function",
      inputs: [
        { name: "variant",  type: "uint8"   },
        { name: "deployer", type: "address" },
        { name: "salt",     type: "bytes32" },
      ],
      outputs: [{ type: "address" }],
      stateMutability: "view",
    }],
    functionName: "getB20Address",
    args: [VARIANT_STABLECOIN, yourAddress, salt],
  });
  console.log("Token will be at:", predicted);

  // 2. Deploy (wallet tx)
  const txHash = await walletClient.writeContract({
    address: B20_FACTORY,
    abi: [{
      name: "createB20", type: "function",
      inputs: [
        { name: "variant",   type: "uint8"   },
        { name: "salt",      type: "bytes32" },
        { name: "params",    type: "bytes"   },
        { name: "initCalls", type: "bytes[]" },
      ],
      outputs: [{ name: "tokenAddress", type: "address" }],
      stateMutability: "nonpayable",
    }],
    functionName: "createB20",
    args: [VARIANT_STABLECOIN, salt, params, []],
  });
  ```

  ---

  ## B20 Token Interface

  Every B20 token is a full ERC-20 superset. Additional B20-native functions:

  ### `transferWithMemo(to, amount, memo)`

  Transfers tokens and emits the memo as an on-chain event — useful for payment references, invoice numbers, or any string annotation.

  ```typescript
  // B20 token — with native on-chain memo
  await walletClient.writeContract({
    address: tokenAddress,
    abi: [{
      name: "transferWithMemo", type: "function",
      inputs: [
        { name: "to",     type: "address" },
        { name: "amount", type: "uint256" },
        { name: "memo",   type: "string"  },
      ],
      stateMutability: "nonpayable",
    }],
    functionName: "transferWithMemo",
    args: [recipient, parseUnits("10.00", 6), "Invoice #42"],
  });
  ```

  > **Non-B20 tokens:** BasePay falls back to standard `transfer(to, amount)` when no memo is provided, or when the token doesn't implement `transferWithMemo`.

  ### Other B20-native capabilities (not yet exposed in BasePay UI)

  - Role-based access control (minter, burner, pauser roles)
  - Transfer policies via the Policy Registry (`0x8453000000000000000000000000000000000002`)
  - Freeze-and-seize (compliance)
  - Supply caps and max mint limits
  - Rebase multiplier (ASSET variant only)

  ---

  ## Multi-Currency Stablecoin Grid

  The `/b20` page shows a tracking grid for upcoming B20 STABLECOIN deployments:

  | Currency | Symbol | ISO Code | Status |
  |---|---|---|---|
  | US Dollar | USDC | USD | Live (Circle ERC-20, pre-B20) |
  | Euro | EURC | EUR | Live (Circle ERC-20, pre-B20) |
  | Brazilian Real | BRLC | BRL | Coming soon |
  | Mexican Peso | MXNc | MXN | Coming soon |
  | Nigerian Naira | NGNC | NGN | Planned |
  | Indian Rupee | INRC | INR | Planned |
  | British Pound | GBPC | GBP | Planned |
  | Japanese Yen | JPYC | JPY | Planned |
  | Philippine Peso | PHPC | PHP | Planned |

  Once a B20 stablecoin is deployed and its address is verified on BaseScan, the grid updates to "Live" with a copyable contract address.

  ---

  ## Using B20 Tokens with BasePay

  B20 tokens are fully ERC-20 compatible. Existing BasePay features work with any B20 token address today:

  | Feature | Compatible with B20? | Notes |
  |---|---|---|
  | **Send** | ✅ Yes | Use any B20 token address |
  | **Batch Pay** | ✅ Yes | BatchPay contract works with any ERC-20 |
  | **Escrow** | ✅ Yes | Escrow contract works with any ERC-20 |
  | **Gasless Transfer** | ⚠️ USDC/EURC only | Requires EIP-3009; B20 stablecoins will be added as they implement `transferWithAuthorization` |
  | **Subscriptions** | ✅ Yes | SubscriptionManager works with any ERC-20 |

  ---

  ## Open PRs in base/base (active development)

  These Rust PRs in the [base/base](https://github.com/base/base) repo cover the B20 precompile internals:

  | PR | Title | Status |
  |---|---|---|
  | [#4015](https://github.com/base/base/pull/4015) | Golden tests for B20 factory V1 | Open |
  | [#4016](https://github.com/base/base/pull/4016) | Golden tests for policy registry V1 | Open |
  | [#3996](https://github.com/base/base/pull/3996) | Compile-time hash freeze for stablecoin v1 logic | Open |
  | [#3987](https://github.com/base/base/pull/3987) | Clear stale precompile storage after Cobalt upgrade | Open |

  BasePay shared consumer-side ABI feedback on [PR #4015](https://github.com/base/base/pull/4015#issuecomment-5016199472).

  ---

  ## References

  - [B20 Native Token Standard — Base Docs](https://docs.base.org/base-chain/specs/upgrades/beryl/b20)
  - [Launch a B20 Token — Base Docs](https://docs.base.org/get-started/launch-b20-token)
  - [Base Beryl Upgrade Blog](https://blog.base.dev/introducing-base-beryl)
  - [Chainstack: What is B20?](https://chainstack.com/what-is-b20-base-token-standard/)
  