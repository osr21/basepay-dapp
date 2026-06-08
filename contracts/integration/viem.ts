/**
 * BasePay V2 — viem integration examples
 * Contracts verified on Base Mainnet (chainId 8453)
 * https://github.com/osr21/basepay-dapp
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  parseSignature,
  custom,
} from "viem";
import { base } from "viem/chains";

// ── Addresses ────────────────────────────────────────────────────────────────

export const ADDRESSES = {
  router:      "0x756f516cdf5eb98e140eba44119b22fc0f0bb63f" as const,
  batchPay:    "0xe40d2292c050566d16cecda74627b70778806c68" as const,
  escrow:      "0x1eb2b1e8dda64fc4ccb0537574f2a2ca9f307499" as const,
  subManager:  "0x101918a252b3852ac4b50b7bbf2525d3084d5421" as const,
  usdc:        "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const,
} as const;

// ── ABIs (minimal — import full JSON from ../BasePayRouterV2.json etc.) ──────

const ROUTER_ABI = [
  { type: "function", name: "send",           inputs: [{ name: "token", type: "address" }, { name: "recipient", type: "address" }, { name: "amount", type: "uint256" }, { name: "memo", type: "string" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "sendWithPermit", inputs: [{ name: "token", type: "address" }, { name: "recipient", type: "address" }, { name: "amount", type: "uint256" }, { name: "memo", type: "string" }, { name: "deadline", type: "uint256" }, { name: "v", type: "uint8" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "quote",          inputs: [{ name: "amount", type: "uint256" }], outputs: [{ name: "feeAmount", type: "uint256" }, { name: "netAmount", type: "uint256" }], stateMutability: "view" },
  { type: "event",   name: "Payment",         inputs: [{ name: "sender", type: "address", indexed: true }, { name: "recipient", type: "address", indexed: true }, { name: "token", type: "address", indexed: true }, { name: "grossAmount", type: "uint256", indexed: false }, { name: "feeAmount", type: "uint256", indexed: false }, { name: "netAmount", type: "uint256", indexed: false }, { name: "memo", type: "string", indexed: false }] },
] as const;

const BATCH_ABI = [
  { type: "function", name: "batchSend",           inputs: [{ name: "token", type: "address" }, { name: "recipients", type: "address[]" }, { name: "amounts", type: "uint256[]" }, { name: "memo", type: "string" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "batchSendWithPermit", inputs: [{ name: "token", type: "address" }, { name: "recipients", type: "address[]" }, { name: "amounts", type: "uint256[]" }, { name: "memo", type: "string" }, { name: "permitAmount", type: "uint256" }, { name: "deadline", type: "uint256" }, { name: "v", type: "uint8" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "quoteBatch",          inputs: [{ name: "amounts", type: "uint256[]" }], outputs: [{ name: "totalGross", type: "uint256" }, { name: "totalFee", type: "uint256" }, { name: "totalNet", type: "uint256" }], stateMutability: "view" },
] as const;

const ESCROW_ABI = [
  { type: "function", name: "create",           inputs: [{ name: "token", type: "address" }, { name: "payee", type: "address" }, { name: "amount", type: "uint256" }, { name: "ttl", type: "uint256" }, { name: "memo", type: "string" }], outputs: [{ name: "id", type: "uint256" }], stateMutability: "nonpayable" },
  { type: "function", name: "createWithPermit", inputs: [{ name: "token", type: "address" }, { name: "payee", type: "address" }, { name: "amount", type: "uint256" }, { name: "ttl", type: "uint256" }, { name: "memo", type: "string" }, { name: "deadline", type: "uint256" }, { name: "v", type: "uint8" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" }], outputs: [{ name: "id", type: "uint256" }], stateMutability: "nonpayable" },
  { type: "function", name: "release",          inputs: [{ name: "id", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "refund",           inputs: [{ name: "id", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "event",   name: "EscrowCreated",     inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "payer", type: "address", indexed: true }, { name: "payee", type: "address", indexed: true }, { name: "token", type: "address", indexed: false }, { name: "amount", type: "uint256", indexed: false }, { name: "expiry", type: "uint256", indexed: false }, { name: "memo", type: "string", indexed: false }] },
] as const;

const SUB_ABI = [
  { type: "function", name: "subscribe",           inputs: [{ name: "token", type: "address" }, { name: "payee", type: "address" }, { name: "amount", type: "uint256" }, { name: "interval", type: "uint256" }, { name: "memo", type: "string" }], outputs: [{ name: "id", type: "uint256" }], stateMutability: "nonpayable" },
  { type: "function", name: "subscribeWithPermit", inputs: [{ name: "token", type: "address" }, { name: "payee", type: "address" }, { name: "amount", type: "uint256" }, { name: "interval", type: "uint256" }, { name: "memo", type: "string" }, { name: "permitAmount", type: "uint256" }, { name: "deadline", type: "uint256" }, { name: "v", type: "uint8" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" }], outputs: [{ name: "id", type: "uint256" }], stateMutability: "nonpayable" },
  { type: "function", name: "charge",              inputs: [{ name: "id", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "cancel",              inputs: [{ name: "id", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "nextChargeAt",        inputs: [{ name: "id", type: "uint256" }], outputs: [{ name: "timestamp", type: "uint256" }], stateMutability: "view" },
  { type: "event",   name: "Subscribed",           inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "payer", type: "address", indexed: true }, { name: "payee", type: "address", indexed: true }, { name: "token", type: "address", indexed: false }, { name: "amount", type: "uint256", indexed: false }, { name: "interval", type: "uint256", indexed: false }, { name: "memo", type: "string", indexed: false }] },
] as const;

const USDC_ABI = [
  { type: "function", name: "balanceOf",  inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "allowance",  inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "approve",    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }], stateMutability: "nonpayable" },
  { type: "function", name: "nonces",     inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
] as const;

// ── Clients ───────────────────────────────────────────────────────────────────

export const publicClient = createPublicClient({
  chain: base,
  transport: http("https://mainnet.base.org"),
});

// For browser usage (MetaMask / injected):
export function getWalletClient() {
  return createWalletClient({
    chain: base,
    transport: custom((window as Window & { ethereum?: import("viem").EIP1193Provider }).ethereum!),
  });
}

// ── USDC permit helper ────────────────────────────────────────────────────────

const USDC_DOMAIN = {
  name: "USD Coin",
  version: "2",
  chainId: 8453,
  verifyingContract: ADDRESSES.usdc,
} as const;

const PERMIT_TYPES = {
  Permit: [
    { name: "owner",    type: "address" },
    { name: "spender",  type: "address" },
    { name: "value",    type: "uint256" },
    { name: "nonce",    type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

async function signUsdcPermit(
  walletClient: ReturnType<typeof getWalletClient>,
  owner: `0x${string}`,
  spender: `0x${string}`,
  value: bigint,
  deadlineSecs = 3_600,
) {
  const nonce = await publicClient.readContract({
    address: ADDRESSES.usdc,
    abi: USDC_ABI,
    functionName: "nonces",
    args: [owner],
  });
  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSecs);
  const sig = await walletClient.signTypedData({
    account: owner,
    domain: USDC_DOMAIN,
    types: PERMIT_TYPES,
    primaryType: "Permit",
    message: { owner, spender, value, nonce, deadline },
  });
  const { v, r, s } = parseSignature(sig);
  return { v: Number(v), r, s, deadline };
}

// ── 1. Single payment via Router (atomic, one tx) ────────────────────────────

export async function sendWithPermit(
  owner: `0x${string}`,
  recipient: `0x${string}`,
  amountUsdc: string,
  memo = "",
) {
  const walletClient = getWalletClient();
  const amount = parseUnits(amountUsdc, 6);

  // Quote fee before sending
  const [feeAmount, netAmount] = await publicClient.readContract({
    address: ADDRESSES.router,
    abi: ROUTER_ABI,
    functionName: "quote",
    args: [amount],
  });
  console.log(`Fee: ${feeAmount}, Net to recipient: ${netAmount}`);

  // Sign EIP-2612 permit (off-chain, no gas)
  const { v, r, s, deadline } = await signUsdcPermit(
    walletClient, owner, ADDRESSES.router, amount,
  );

  // Single on-chain transaction
  const hash = await walletClient.writeContract({
    account: owner,
    address: ADDRESSES.router,
    abi: ROUTER_ABI,
    functionName: "sendWithPermit",
    args: [ADDRESSES.usdc, recipient, amount, memo, deadline, v, r, s],
  });

  return hash;
}

// ── 2. Batch payment (up to 200 recipients, one tx) ──────────────────────────

export async function batchPayWithPermit(
  owner: `0x${string}`,
  payments: Array<{ recipient: `0x${string}`; amountUsdc: string }>,
  memo = "",
) {
  const walletClient = getWalletClient();
  const recipients = payments.map(p => p.recipient);
  const amounts    = payments.map(p => parseUnits(p.amountUsdc, 6));
  const totalAmount = amounts.reduce((a, b) => a + b, 0n);

  // Quote
  const batchQuote = await publicClient.readContract({
    address: ADDRESSES.batchPay,
    abi: BATCH_ABI,
    functionName: "quoteBatch",
    args: [amounts],
  });
  const [totalGross, totalFee, totalNet] = batchQuote;
  console.log(`Batch: gross=${totalGross}, fee=${totalFee}, net=${totalNet}`);

  // Permit for total gross amount
  const { v, r, s, deadline } = await signUsdcPermit(
    walletClient, owner, ADDRESSES.batchPay, totalGross,
  );

  const hash = await walletClient.writeContract({
    account: owner,
    address: ADDRESSES.batchPay,
    abi: BATCH_ABI,
    functionName: "batchSendWithPermit",
    args: [ADDRESSES.usdc, recipients, amounts, memo, totalGross, deadline, v, r, s],
  });

  return hash;
}

// ── 3. Create escrow (time-locked payment) ────────────────────────────────────

export async function createEscrow(
  owner: `0x${string}`,
  payee: `0x${string}`,
  amountUsdc: string,
  ttlSeconds: number,
  memo = "",
) {
  const walletClient = getWalletClient();
  const amount  = parseUnits(amountUsdc, 6);
  const ttl     = BigInt(ttlSeconds);

  // Permit for the escrow amount
  const { v, r, s, deadline } = await signUsdcPermit(
    walletClient, owner, ADDRESSES.escrow, amount,
  );

  const hash = await walletClient.writeContract({
    account: owner,
    address: ADDRESSES.escrow,
    abi: ESCROW_ABI,
    functionName: "createWithPermit",
    args: [ADDRESSES.usdc, payee, amount, ttl, memo, deadline, v, r, s],
  });

  return hash;
}

// ── 4. Recurring subscription ─────────────────────────────────────────────────

const INTERVAL = {
  daily:   86_400n,
  weekly:  604_800n,
  monthly: 2_592_000n,
} as const;

export async function subscribe(
  owner: `0x${string}`,
  payee: `0x${string}`,
  amountUsdc: string,
  interval: keyof typeof INTERVAL,
  memo = "",
) {
  const walletClient = getWalletClient();
  const amount       = parseUnits(amountUsdc, 6);

  // Permit for 1,000 charges — bounded (not maxUint256) for security
  const permitAmount  = amount * 1_000n;
  const threeYears    = 3 * 365 * 24 * 3600;
  const { v, r, s, deadline } = await signUsdcPermit(
    walletClient, owner, ADDRESSES.subManager, permitAmount, threeYears,
  );

  const hash = await walletClient.writeContract({
    account: owner,
    address: ADDRESSES.subManager,
    abi: SUB_ABI,
    functionName: "subscribeWithPermit",
    args: [ADDRESSES.usdc, payee, amount, INTERVAL[interval], memo, permitAmount, deadline, v, r, s],
  });

  return hash;
}

// ── 5. Trigger a subscription charge (callable by anyone once per interval) ───

export async function chargeSubscription(caller: `0x${string}`, subscriptionId: bigint) {
  const walletClient = getWalletClient();
  const nextCharge   = await publicClient.readContract({
    address: ADDRESSES.subManager,
    abi: SUB_ABI,
    functionName: "nextChargeAt",
    args: [subscriptionId],
  });

  if (BigInt(Math.floor(Date.now() / 1000)) < nextCharge) {
    throw new Error(`Next charge not due until ${new Date(Number(nextCharge) * 1000).toISOString()}`);
  }

  return walletClient.writeContract({
    account: caller,
    address: ADDRESSES.subManager,
    abi: SUB_ABI,
    functionName: "charge",
    args: [subscriptionId],
  });
}

// ── 6. Listen for Payment events ──────────────────────────────────────────────

export function watchPayments(
  onPayment: (event: {
    sender: `0x${string}`;
    recipient: `0x${string}`;
    grossAmount: bigint;
    feeAmount: bigint;
    netAmount: bigint;
    memo: string;
  }) => void,
) {
  return publicClient.watchContractEvent({
    address: ADDRESSES.router,
    abi: ROUTER_ABI,
    eventName: "Payment",
    onLogs: (logs) => {
      for (const log of logs) {
        const { sender, recipient, grossAmount, feeAmount, netAmount, memo } = log.args;
        if (sender && recipient && grossAmount !== undefined && feeAmount !== undefined && netAmount !== undefined && memo !== undefined) {
          onPayment({ sender, recipient, grossAmount, feeAmount, netAmount, memo });
        }
      }
    },
  });
}
