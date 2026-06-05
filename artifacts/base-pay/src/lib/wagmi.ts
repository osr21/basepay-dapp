import { createConfig, http } from "wagmi";
import { base } from "viem/chains";
import { injected } from "wagmi/connectors";
import { Attribution } from "ox/erc8021";

// ── Base Builder Code (ERC-8021) ─────────────────────────────────────────────
// Register at base.dev → Settings → Builder Code, then set VITE_BASE_BUILDER_CODE
const _builderCode = import.meta.env.VITE_BASE_BUILDER_CODE as string | undefined;
export const DATA_SUFFIX = _builderCode
  ? Attribution.toDataSuffix({ codes: [_builderCode] })
  : undefined;

export const config = createConfig({
  chains: [base],
  connectors: [injected()],
  transports: {
    [base.id]: http(),
  },
  ...(DATA_SUFFIX ? { dataSuffix: DATA_SUFFIX } : {}),
});

// ── USDC on Base ────────────────────────────────────────────────────────────
export const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
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
