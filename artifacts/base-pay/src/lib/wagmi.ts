import { createConfig, http, createConnector } from "wagmi";
import { base } from "viem/chains";
import { injected } from "wagmi/connectors";
import { concat, type Hex } from "viem";
import { Attribution } from "ox/erc8021";

// ── Coinbase Verifications (EAS) ──────────────────────────────────────────────
export const EAS_ADDRESS         = "0x4200000000000000000000000000000000000021" as const;
export const COINBASE_ATTESTER   = "0x357458739F90461b99789350868CD7CF330Dd7EE" as const;
export const COINBASE_INDEXER    = "0x2c7eE1E5f416dfF40054c27A62f7B357C4E8619C" as const;
export const VERIFIED_ACCOUNT_SCHEMA_UID =
  "0xf8b05c79f090979bf4a80270aba232dff11a10d9ca55c4f88de95317970f0de9" as const;

// ── Base Builder Code (ERC-8021) ─────────────────────────────────────────────
// Register at base.dev → Settings → Builder Code, then set VITE_BASE_BUILDER_CODE
const _builderCode = import.meta.env.VITE_BASE_BUILDER_CODE as string | undefined;
export const DATA_SUFFIX = _builderCode
  ? (Attribution.toDataSuffix({ codes: [_builderCode] }) as Hex)
  : undefined;

// ── Custom connector: intercepts eth_sendTransaction to append ERC-8021 suffix ─
// wagmi v3 does not forward dataSuffix at the config level; we proxy the
// injected provider's request() so the suffix is appended to calldata before
// MetaMask signs — covering every contract write automatically.
function attributedInjected() {
  const base_ = injected();
  if (!DATA_SUFFIX) return base_;

  return createConnector((config_) => {
    const conn = (base_ as unknown as (cfg: typeof config_) => ReturnType<ReturnType<typeof createConnector>>)(config_);

    return {
      ...conn,
      async getProvider(params?: { chainId?: number }) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const provider = await (conn as any).getProvider(params);
        if (!provider) return provider;

        return new Proxy(provider as object, {
          get(target, prop) {
            if (prop !== "request") {
              const v = (target as Record<string | symbol, unknown>)[prop];
              return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
            }
            return async ({ method, params: rpcParams }: { method: string; params?: unknown[] }) => {
              if (method === "eth_sendTransaction" && DATA_SUFFIX && Array.isArray(rpcParams) && rpcParams[0]) {
                const tx = { ...(rpcParams[0] as Record<string, unknown>) };
                const existing = ((tx["data"] as Hex | undefined) ?? "0x") as Hex;
                tx["data"] = existing === "0x"
                  ? DATA_SUFFIX
                  : concat([existing, DATA_SUFFIX]);
                return (target as { request(a: unknown): Promise<unknown> }).request({ method, params: [tx] });
              }
              return (target as { request(a: unknown): Promise<unknown> }).request({ method, params: rpcParams });
            };
          },
        });
      },
    };
  });
}

export const config = createConfig({
  chains: [base],
  connectors: [
    attributedInjected(),
  ],
  transports: {
    [base.id]: http(),
  },
});

// ── EIP-3009–compatible gasless tokens on Base ───────────────────────────────
// Only Circle FiatToken V2.2 contracts are listed — they share the same
// transferWithAuthorization + authorizationState ABI and EIP-712 signing format.
export type GaslessToken = {
  address:    `0x${string}`;
  symbol:     string;
  /** EIP-712 domain `name` field — must match what the contract returns */
  domainName: string;
  /** EIP-712 domain `version` field */
  domainVersion: string;
  decimals:   number;
  flag:       string;  // currency flag emoji for display
};

export const GASLESS_TOKENS: GaslessToken[] = [
  {
    address:       "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    symbol:        "USDC",
    domainName:    "USD Coin",
    domainVersion: "2",
    decimals:      6,
    flag:          "🇺🇸",
  },
  {
    address:       "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42",
    symbol:        "EURC",
    domainName:    "EURC",
    domainVersion: "2",
    decimals:      6,
    flag:          "🇪🇺",
  },
];

export const GASLESS_TOKEN_MAP = new Map<string, GaslessToken>(
  GASLESS_TOKENS.map(t => [t.address.toLowerCase(), t]),
);

// ── USDC on Base (kept for non-gasless usage: Send, Batch, Escrow, etc.) ────
export const USDC_ADDRESS = GASLESS_TOKENS[0].address;
export const USDC_DECIMALS = 6;

export const USDC_ABI = [
  {
    type: "function",
    name: "transfer",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "transferFrom",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "allowance",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "nonces",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

// ── BasePayRouter ABI ────────────────────────────────────────────────────────
export const ROUTER_ABI = [
  {
    type: "function",
    name: "send",
    inputs: [
      { name: "token",     type: "address" },
      { name: "recipient", type: "address" },
      { name: "amount",    type: "uint256" },
      { name: "memo",      type: "string"  },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "quote",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [
      { name: "feeAmount", type: "uint256" },
      { name: "netAmount", type: "uint256" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "feeBps",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "feeCollector",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "appInfo",
    inputs: [],
    outputs: [
      { name: "name",    type: "string" },
      { name: "version", type: "string" },
      { name: "network", type: "string" },
    ],
    stateMutability: "pure",
  },
  {
    type: "function",
    name: "sendWithPermit",
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
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "event",
    name: "Payment",
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

// ── BatchPay ABI ─────────────────────────────────────────────────────────────
export const BATCH_PAY_ABI = [
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
    type: "function", name: "quoteBatch",
    inputs: [{ name: "amounts", type: "uint256[]" }],
    outputs: [
      { name: "totalGross", type: "uint256" },
      { name: "totalFee",   type: "uint256" },
      { name: "totalNet",   type: "uint256" },
    ],
    stateMutability: "view",
  },
  { type: "function", name: "feeBps", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  {
    type: "function",
    name: "batchSendWithPermit",
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
] as const;

// ── Escrow ABI ────────────────────────────────────────────────────────────────
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
    outputs: [{ name: "id", type: "uint256" }], stateMutability: "nonpayable",
  },
  {
    type: "function", name: "release",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [], stateMutability: "nonpayable",
  },
  {
    type: "function", name: "refund",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [], stateMutability: "nonpayable",
  },
  {
    type: "function", name: "quote",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [
      { name: "fee", type: "uint256" },
      { name: "net", type: "uint256" },
    ],
    stateMutability: "view",
  },
  {
    type: "function", name: "escrowCount",
    inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view",
  },
  {
    type: "function",
    name: "createWithPermit",
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
    outputs: [{ name: "id", type: "uint256" }], stateMutability: "nonpayable",
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
] as const;

// ── SubscriptionManager ABI ───────────────────────────────────────────────────
export const SUBSCRIPTION_MANAGER_ABI = [
  {
    type: "function", name: "subscribe",
    inputs: [
      { name: "token",    type: "address" },
      { name: "payee",    type: "address" },
      { name: "amount",   type: "uint256" },
      { name: "interval", type: "uint256" },
      { name: "memo",     type: "string"  },
    ],
    outputs: [{ name: "id", type: "uint256" }], stateMutability: "nonpayable",
  },
  {
    type: "function", name: "charge",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [], stateMutability: "nonpayable",
  },
  {
    type: "function", name: "cancel",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [], stateMutability: "nonpayable",
  },
  {
    type: "function", name: "nextChargeAt",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ name: "timestamp", type: "uint256" }], stateMutability: "view",
  },
  {
    type: "function", name: "subCount",
    inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view",
  },
  {
    type: "function",
    name: "subscribeWithPermit",
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
    outputs: [{ name: "id", type: "uint256" }], stateMutability: "nonpayable",
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
] as const;

// ── Fee / deployer config ────────────────────────────────────────────────────
export const FEE_COLLECTOR_ADDRESS = (
  import.meta.env.VITE_FEE_COLLECTOR_ADDRESS ?? ""
) as `0x${string}`;

export const FEE_BPS = parseInt(import.meta.env.VITE_FEE_BPS ?? "30", 10);

export const ROUTER_ADDRESS = (
  import.meta.env.VITE_ROUTER_ADDRESS ?? ""
) as `0x${string}` | "";

/** Whether the on-chain router is deployed and configured */
export const HAS_ROUTER = ROUTER_ADDRESS.startsWith("0x") && ROUTER_ADDRESS.length === 42;

// ── Fee math helpers ─────────────────────────────────────────────────────────
export function calcFee(grossUsdc: string): { fee: string; net: string } {
  if (!grossUsdc || parseFloat(grossUsdc) <= 0) return { fee: "0", net: grossUsdc };
  const gross = parseFloat(grossUsdc);
  const fee   = (gross * FEE_BPS) / 10_000;
  const net   = gross - fee;
  return {
    fee: fee.toFixed(6).replace(/\.?0+$/, "") || "0",
    net: net.toFixed(6).replace(/\.?0+$/, "") || "0",
  };
}

// ── Format helpers ───────────────────────────────────────────────────────────
export function truncateAddress(address: string): string {
  if (!address) return "";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function parseUSDC(amount: string): bigint {
  const [whole = "0", frac = ""] = amount.split(".");
  const padded = frac.padEnd(USDC_DECIMALS, "0").slice(0, USDC_DECIMALS);
  return BigInt(whole) * BigInt(10 ** USDC_DECIMALS) + BigInt(padded);
}

export function formatUSDC(raw: bigint): string {
  const divisor  = BigInt(10 ** USDC_DECIMALS);
  const whole    = raw / divisor;
  const frac     = raw % divisor;
  const fracStr  = frac.toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : `${whole}`;
}
