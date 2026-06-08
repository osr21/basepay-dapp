/**
 * @basepay/contracts
 *
 * BasePay V2 — open-source USDC/EURC payment infrastructure on Base Mainnet.
 * All contracts are source-verified on Basescan and callable permissionlessly.
 *
 * Chain: Base Mainnet (chainId 8453)
 * Docs: https://github.com/osr21/basepay-dapp
 */

// ── Chain + network ──────────────────────────────────────────────────────────

/** Base Mainnet chain ID */
export const CHAIN_ID = 8453 as const;

// ── Token addresses ───────────────────────────────────────────────────────────

/** Circle USDC on Base Mainnet */
export const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
/** Circle EURC on Base Mainnet */
export const EURC_ADDRESS = "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42" as const;

export const TOKENS = {
  USDC: USDC_ADDRESS,
  EURC: EURC_ADDRESS,
} as const;

// ── Contract addresses ────────────────────────────────────────────────────────

/**
 * BasePayRouterV2 — routes a single ERC-20 payment with a 0.30% protocol fee.
 * Supports EIP-2612 `permit` for gasless one-tx approve+send.
 * Basescan: https://basescan.org/address/0x756f516cdf5eb98e140eba44119b22fc0f0bb63f#code
 */
export const ROUTER_ADDRESS          = "0x756f516cdf5eb98e140eba44119b22fc0f0bb63f" as const;

/**
 * BatchPayV2 — pays up to 200 recipients in a single transaction.
 * Supports EIP-2612 `permit` for gasless approve+batchSend.
 * Basescan: https://basescan.org/address/0xe40d2292c050566d16cecda74627b70778806c68#code
 */
export const BATCH_PAY_ADDRESS       = "0xe40d2292c050566d16cecda74627b70778806c68" as const;

/**
 * EscrowV2 — time-locked escrow. Payer can release early or reclaim after TTL.
 * Supports EIP-2612 `permit` via createWithPermit.
 * Basescan: https://basescan.org/address/0x1eb2b1e8dda64fc4ccb0537574f2a2ca9f307499#code
 */
export const ESCROW_ADDRESS          = "0x1eb2b1e8dda64fc4ccb0537574f2a2ca9f307499" as const;

/**
 * SubscriptionManagerV2 — on-chain recurring ERC-20 payments.
 * `charge(id)` is permissionless — callable by anyone once per interval.
 * Perfect for Gelato/Chainlink Automation keeper tasks.
 * Basescan: https://basescan.org/address/0x101918a252b3852ac4b50b7bbf2525d3084d5421#code
 */
export const SUBSCRIPTION_ADDRESS    = "0x101918a252b3852ac4b50b7bbf2525d3084d5421" as const;

export const CONTRACT_ADDRESSES = {
  BasePayRouterV2:        ROUTER_ADDRESS,
  BatchPayV2:             BATCH_PAY_ADDRESS,
  EscrowV2:               ESCROW_ADDRESS,
  SubscriptionManagerV2:  SUBSCRIPTION_ADDRESS,
} as const;

// ── Protocol constants ────────────────────────────────────────────────────────

/** Protocol fee in basis points (30 = 0.30%) */
export const FEE_BPS = 30 as const;

// ── ABIs ──────────────────────────────────────────────────────────────────────

export const ROUTER_ABI = [
  {
    type: "function", name: "send",
    inputs: [
      { name: "token",     type: "address" },
      { name: "recipient", type: "address" },
      { name: "amount",    type: "uint256" },
      { name: "memo",      type: "string"  },
    ],
    outputs: [], stateMutability: "nonpayable",
  },
  {
    type: "function", name: "sendWithPermit",
    inputs: [
      { name: "token",     type: "address" },
      { name: "recipient", type: "address" },
      { name: "amount",    type: "uint256" },
      { name: "memo",      type: "string"  },
      { name: "deadline",  type: "uint256" },
      { name: "v",         type: "uint8"   },
      { name: "r",         type: "bytes32" },
      { name: "s",         type: "bytes32" },
    ],
    outputs: [], stateMutability: "nonpayable",
  },
  {
    type: "function", name: "quote",
    inputs:  [{ name: "amount", type: "uint256" }],
    outputs: [
      { name: "feeAmount", type: "uint256" },
      { name: "netAmount", type: "uint256" },
    ],
    stateMutability: "view",
  },
  {
    type: "event", name: "Payment",
    inputs: [
      { name: "sender",      type: "address", indexed: true  },
      { name: "recipient",   type: "address", indexed: true  },
      { name: "token",       type: "address", indexed: true  },
      { name: "grossAmount", type: "uint256", indexed: false },
      { name: "feeAmount",   type: "uint256", indexed: false },
      { name: "netAmount",   type: "uint256", indexed: false },
      { name: "memo",        type: "string",  indexed: false },
    ],
  },
] as const;

export const BATCH_ABI = [
  {
    type: "function", name: "batchSend",
    inputs: [
      { name: "token",      type: "address"   },
      { name: "recipients", type: "address[]" },
      { name: "amounts",    type: "uint256[]" },
      { name: "memo",       type: "string"    },
    ],
    outputs: [], stateMutability: "nonpayable",
  },
  {
    type: "function", name: "batchSendWithPermit",
    inputs: [
      { name: "token",        type: "address"   },
      { name: "recipients",   type: "address[]" },
      { name: "amounts",      type: "uint256[]" },
      { name: "memo",         type: "string"    },
      { name: "permitAmount", type: "uint256"   },
      { name: "deadline",     type: "uint256"   },
      { name: "v",            type: "uint8"     },
      { name: "r",            type: "bytes32"   },
      { name: "s",            type: "bytes32"   },
    ],
    outputs: [], stateMutability: "nonpayable",
  },
  {
    type: "function", name: "quoteBatch",
    inputs:  [{ name: "amounts", type: "uint256[]" }],
    outputs: [
      { name: "totalGross", type: "uint256" },
      { name: "totalFee",   type: "uint256" },
      { name: "totalNet",   type: "uint256" },
    ],
    stateMutability: "view",
  },
] as const;

export const ESCROW_ABI = [
  {
    type: "function", name: "create",
    inputs: [
      { name: "token",  type: "address" },
      { name: "payee",  type: "address" },
      { name: "amount", type: "uint256" },
      { name: "ttl",    type: "uint256" },
      { name: "memo",   type: "string"  },
    ],
    outputs: [{ name: "id", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function", name: "createWithPermit",
    inputs: [
      { name: "token",    type: "address" },
      { name: "payee",    type: "address" },
      { name: "amount",   type: "uint256" },
      { name: "ttl",      type: "uint256" },
      { name: "memo",     type: "string"  },
      { name: "deadline", type: "uint256" },
      { name: "v",        type: "uint8"   },
      { name: "r",        type: "bytes32" },
      { name: "s",        type: "bytes32" },
    ],
    outputs: [{ name: "id", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function", name: "release",
    inputs:  [{ name: "id", type: "uint256" }],
    outputs: [], stateMutability: "nonpayable",
  },
  {
    type: "function", name: "refund",
    inputs:  [{ name: "id", type: "uint256" }],
    outputs: [], stateMutability: "nonpayable",
  },
  {
    type: "function", name: "escrows",
    inputs:  [{ name: "id", type: "uint256" }],
    outputs: [
      { name: "payer",  type: "address" },
      { name: "payee",  type: "address" },
      { name: "token",  type: "address" },
      { name: "amount", type: "uint256" },
      { name: "expiry", type: "uint256" },
      { name: "state",  type: "uint8"   },
      { name: "memo",   type: "string"  },
    ],
    stateMutability: "view",
  },
  {
    type: "event", name: "EscrowCreated",
    inputs: [
      { name: "id",     type: "uint256", indexed: true  },
      { name: "payer",  type: "address", indexed: true  },
      { name: "payee",  type: "address", indexed: true  },
      { name: "token",  type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
      { name: "expiry", type: "uint256", indexed: false },
      { name: "memo",   type: "string",  indexed: false },
    ],
  },
  {
    type: "event", name: "Released",
    inputs: [
      { name: "id",        type: "uint256", indexed: true  },
      { name: "payee",     type: "address", indexed: true  },
      { name: "netAmount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event", name: "Refunded",
    inputs: [
      { name: "id",    type: "uint256", indexed: true  },
      { name: "payer", type: "address", indexed: true  },
      { name: "amount",type: "uint256", indexed: false },
    ],
  },
] as const;

export const SUBSCRIPTION_ABI = [
  {
    type: "function", name: "subscribe",
    inputs: [
      { name: "token",    type: "address" },
      { name: "payee",    type: "address" },
      { name: "amount",   type: "uint256" },
      { name: "interval", type: "uint256" },
      { name: "memo",     type: "string"  },
    ],
    outputs: [{ name: "id", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function", name: "subscribeWithPermit",
    inputs: [
      { name: "token",        type: "address" },
      { name: "payee",        type: "address" },
      { name: "amount",       type: "uint256" },
      { name: "interval",     type: "uint256" },
      { name: "memo",         type: "string"  },
      { name: "permitAmount", type: "uint256" },
      { name: "deadline",     type: "uint256" },
      { name: "v",            type: "uint8"   },
      { name: "r",            type: "bytes32" },
      { name: "s",            type: "bytes32" },
    ],
    outputs: [{ name: "id", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function", name: "charge",
    inputs:  [{ name: "id", type: "uint256" }],
    outputs: [], stateMutability: "nonpayable",
  },
  {
    type: "function", name: "cancel",
    inputs:  [{ name: "id", type: "uint256" }],
    outputs: [], stateMutability: "nonpayable",
  },
  {
    type: "function", name: "nextChargeAt",
    inputs:  [{ name: "id", type: "uint256" }],
    outputs: [{ name: "timestamp", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function", name: "subscriptions",
    inputs:  [{ name: "id", type: "uint256" }],
    outputs: [
      { name: "payer",       type: "address" },
      { name: "payee",       type: "address" },
      { name: "token",       type: "address" },
      { name: "amount",      type: "uint256" },
      { name: "interval",    type: "uint256" },
      { name: "lastCharged", type: "uint256" },
      { name: "startTime",   type: "uint256" },
      { name: "active",      type: "bool"    },
      { name: "memo",        type: "string"  },
    ],
    stateMutability: "view",
  },
  {
    type: "event", name: "Subscribed",
    inputs: [
      { name: "id",       type: "uint256", indexed: true  },
      { name: "payer",    type: "address", indexed: true  },
      { name: "payee",    type: "address", indexed: true  },
      { name: "token",    type: "address", indexed: false },
      { name: "amount",   type: "uint256", indexed: false },
      { name: "interval", type: "uint256", indexed: false },
      { name: "memo",     type: "string",  indexed: false },
    ],
  },
  {
    type: "event", name: "Charged",
    inputs: [
      { name: "id",          type: "uint256", indexed: true  },
      { name: "payer",       type: "address", indexed: true  },
      { name: "grossAmount", type: "uint256", indexed: false },
      { name: "feeAmount",   type: "uint256", indexed: false },
      { name: "netAmount",   type: "uint256", indexed: false },
    ],
  },
  {
    type: "event", name: "Cancelled",
    inputs: [
      { name: "id", type: "uint256", indexed: true  },
      { name: "by", type: "address", indexed: true  },
    ],
  },
] as const;

// ── Convenience re-exports ─────────────────────────────────────────────────────

export const abis = {
  router:       ROUTER_ABI,
  batchPay:     BATCH_ABI,
  escrow:       ESCROW_ABI,
  subscription: SUBSCRIPTION_ABI,
} as const;

export const addresses = CONTRACT_ADDRESSES;
