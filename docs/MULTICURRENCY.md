# Multi-Currency B20 Stablecoins

  > Added: July 2026 · Route: `/b20` (stablecoin grid) · Files: `wagmi.ts` (B20_MULTICURRENCY_TOKENS), `B20Tokens.tsx`

  ## Overview

  The Base Beryl upgrade (July 8, 2026) introduced the **B20 STABLECOIN variant** — a factory-deployed token type with a built-in ISO 4217 currency code, 6 fixed decimals, role-based compliance controls, and supply caps. It enables any issuer to launch a high-quality stablecoin for any currency in the world without writing or auditing a single line of Solidity.

  BasePay tracks the global rollout of B20 stablecoins on the `/b20` page with a live status grid.

  ---

  ## Tracked Currencies

  | Flag | Currency | Symbol | ISO Code | Status | Notes |
  |---|---|---|---|---|---|
  | 🇺🇸 | US Dollar | USDC | USD | **Live** | Circle ERC-20 (`0x8335...`) — predates B20, used natively |
  | 🇪🇺 | Euro | EURC | EUR | **Live** | Circle ERC-20 (`0x60a3...`) — predates B20, used natively |
  | 🇧🇷 | Brazilian Real | BRLC | BRL | Coming soon | STABLECOIN variant — deployment expected post-Beryl |
  | 🇲🇽 | Mexican Peso | MXNc | MXN | Coming soon | STABLECOIN variant |
  | 🇳🇬 | Nigerian Naira | NGNC | NGN | Planned | STABLECOIN variant |
  | 🇮🇳 | Indian Rupee | INRC | INR | Planned | STABLECOIN variant |
  | 🇬🇧 | British Pound | GBPC | GBP | Planned | STABLECOIN variant |
  | 🇯🇵 | Japanese Yen | JPYC | JPY | Planned | STABLECOIN variant — note: JPY uses 0 decimals in fiat; B20 uses 6 |
  | 🇵🇭 | Philippine Peso | PHPC | PHP | Planned | STABLECOIN variant |

  ---

  ## What Makes B20 STABLECOIN Different from ERC-20

  | Feature | Plain ERC-20 | B20 STABLECOIN |
  |---|---|---|
  | Deployment | Deploy EVM bytecode | One `createB20()` factory call |
  | Audit required | Yes (custom bytecode) | No — Rust precompile is audited at the chain level |
  | Decimals | Configurable | Fixed 6 (enforced by precompile) |
  | Currency code | No native concept | ISO 4217 string stored in precompile state |
  | Compliance | DIY via custom logic | Built-in: roles, freeze, seize, supply cap, pause |
  | Transfer memo | No | `transferWithMemo(to, amount, memo)` — on-chain event |
  | Address pattern | Arbitrary | Deterministic `0xB200...` — derived from variant + deployer + salt |
  | Gas cost | EVM execution | Rust precompile — lower and more predictable |

  ---

  ## Launching a B20 Stablecoin

  ```typescript
  import { encodeAbiParameters, keccak256, toBytes } from "viem";

  const B20_FACTORY      = "0xB20f000000000000000000000000000000000000";
  const VARIANT_STABLECOIN = 1n; // 0 = ASSET, 1 = STABLECOIN

  const salt = keccak256(toBytes("my-stablecoin-v1")); // any unique string

  // Pack the creation params
  const params = encodeAbiParameters(
    [
      { name: "name",         type: "string"  },
      { name: "symbol",       type: "string"  },
      { name: "initialAdmin", type: "address" }, // admin can mint, freeze, etc.
      { name: "currencyCode", type: "string"  }, // ISO 4217, e.g. "BRL", "MXN"
    ],
    ["Brazilian Real Coin", "BRLC", "0xYOUR_ADMIN_ADDRESS", "BRL"],
  );

  // Preview address before deploying
  const predicted = await publicClient.readContract({
    address: B20_FACTORY,
    abi: [{ name: "getB20Address", type: "function",
      inputs: [
        { name: "variant",  type: "uint8" },
        { name: "deployer", type: "address" },
        { name: "salt",     type: "bytes32" },
      ],
      outputs: [{ type: "address" }], stateMutability: "view",
    }],
    functionName: "getB20Address",
    args: [VARIANT_STABLECOIN, yourAddress, salt],
  });

  // Deploy
  await walletClient.writeContract({
    address: B20_FACTORY,
    abi: [{ name: "createB20", type: "function",
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
    args: [VARIANT_STABLECOIN, salt, params, [
      // Optional initCalls: e.g. mint initial supply
      // encodeInitCall("mint", [adminAddress, initialSupply])
    ]],
  });
  ```

  ---

  ## Error Handling

  The factory reverts with specific error types — catch them on the client for clean UX:

  | Error | Cause | UI action |
  |---|---|---|
  | `TokenAlreadyExists` | The salt + deployer address is already deployed | Show "Already deployed at 0x…" with a link |
  | `UnsupportedVersion` | Variant is not 0 (ASSET) or 1 (STABLECOIN) | Validate variant before submit |
  | `InvalidDecimals` | ASSET variant with out-of-range decimals | Validate decimal input (6–18 for ASSET) |

  ---

  ## Using B20 Stablecoins with BasePay

  Once a B20 stablecoin is deployed, it works with most BasePay features immediately:

  ```
  B20 token address → /send     → Send page (ERC-20 compatible)
                    → /batch-pay → BatchPay contract (works with any ERC-20)
                    → /escrow   → Escrow contract (works with any ERC-20)
                    → /b20      → Token lookup, balance, transferWithMemo
  ```

  The **Gasless Transfer** page (`/gasless`) currently only supports USDC and EURC because gasless flows require **EIP-3009** (`transferWithAuthorization`). B20 stablecoins will be added to the gasless token selector once they implement EIP-3009-compatible authorization.

  ---

  ## Detecting B20 Tokens

  B20 tokens follow a deterministic address pattern: the first 4 bytes are always `0xB200`. BasePay uses this to show a "B20" badge in the token lookup UI:

  ```typescript
  const isB20 = isAddress(tokenAddr) && tokenAddr.toLowerCase().startsWith("0xb200");
  ```

  ---

  ## Transfer With Memo

  B20's `transferWithMemo` emits the memo as an on-chain event — visible on BaseScan in the transaction logs and indexable by any event listener:

  ```typescript
  await walletClient.writeContract({
    address: b20TokenAddress,
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
    args: ["0xRECIPIENT", parseUnits("50.00", 6), "Payroll - July 2026"],
  });
  ```

  > **Memo vs calldata**: `transferWithMemo` stores the memo in an EVM log, not calldata. It is gas-efficient, easily filterable by event topic, and survives archival node pruning.

  ---

  ## References

  - [B20 Spec — docs.base.org](https://docs.base.org/base-chain/specs/upgrades/beryl/b20)
  - [Launch a B20 Token](https://docs.base.org/get-started/launch-b20-token)
  - [Base Beryl Blog](https://blog.base.dev/introducing-base-beryl)
  - [B20 factory golden tests — base/base#4015](https://github.com/base/base/pull/4015)
  - [B20 policy registry golden tests — base/base#4016](https://github.com/base/base/pull/4016)
  