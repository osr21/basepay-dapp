/**
 * BasePay V2 — ethers.js v6 integration examples
 * Contracts verified on Base Mainnet (chainId 8453)
 * https://github.com/osr21/basepay-dapp
 */

import { ethers } from "ethers";

// ── Addresses ─────────────────────────────────────────────────────────────────

export const ADDRESSES = {
  router:     "0x756f516cdf5eb98e140eba44119b22fc0f0bb63f",
  batchPay:   "0xe40d2292c050566d16cecda74627b70778806c68",
  escrow:     "0x1eb2b1e8dda64fc4ccb0537574f2a2ca9f307499",
  subManager: "0x101918a252b3852ac4b50b7bbf2525d3084d5421",
  usdc:       "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
} as const;

// ── Provider & signer setup ──────────────────────────────────────────────────

/** For read-only queries */
export const provider = new ethers.JsonRpcProvider("https://mainnet.base.org", 8453);

/** For browser (MetaMask / injected wallet) */
export function getBrowserSigner() {
  if (!window.ethereum) throw new Error("No injected wallet found");
  return new ethers.BrowserProvider(window.ethereum).getSigner();
}

/** For backend / server-side (private key) */
export function getPrivateKeySigner(privateKey: string) {
  return new ethers.Wallet(privateKey, provider);
}

// ── Minimal ABIs ──────────────────────────────────────────────────────────────

const ROUTER_ABI = [
  "function send(address token, address recipient, uint256 amount, string memo)",
  "function sendWithPermit(address token, address recipient, uint256 amount, string memo, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
  "function quote(uint256 amount) view returns (uint256 feeAmount, uint256 netAmount)",
  "event Payment(address indexed sender, address indexed recipient, address indexed token, uint256 grossAmount, uint256 feeAmount, uint256 netAmount, string memo)",
];

const BATCH_ABI = [
  "function batchSend(address token, address[] recipients, uint256[] amounts, string memo)",
  "function batchSendWithPermit(address token, address[] recipients, uint256[] amounts, string memo, uint256 permitAmount, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
  "function quoteBatch(uint256[] amounts) view returns (uint256 totalGross, uint256 totalFee, uint256 totalNet)",
];

const ESCROW_ABI = [
  "function create(address token, address payee, uint256 amount, uint256 ttl, string memo) returns (uint256 id)",
  "function createWithPermit(address token, address payee, uint256 amount, uint256 ttl, string memo, uint256 deadline, uint8 v, bytes32 r, bytes32 s) returns (uint256 id)",
  "function release(uint256 id)",
  "function refund(uint256 id)",
  "event EscrowCreated(uint256 indexed id, address indexed payer, address indexed payee, address token, uint256 amount, uint256 expiry, string memo)",
];

const SUB_ABI = [
  "function subscribe(address token, address payee, uint256 amount, uint256 interval, string memo) returns (uint256 id)",
  "function subscribeWithPermit(address token, address payee, uint256 amount, uint256 interval, string memo, uint256 permitAmount, uint256 deadline, uint8 v, bytes32 r, bytes32 s) returns (uint256 id)",
  "function charge(uint256 id)",
  "function cancel(uint256 id)",
  "function nextChargeAt(uint256 id) view returns (uint256 timestamp)",
  "event Subscribed(uint256 indexed id, address indexed payer, address indexed payee, address token, uint256 amount, uint256 interval, string memo)",
];

const USDC_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function nonces(address owner) view returns (uint256)",
];

// ── USDC permit helper ────────────────────────────────────────────────────────

async function signUsdcPermit(
  signer: ethers.Signer,
  spender: string,
  value: bigint,
  deadlineSecs = 3_600,
) {
  const owner    = await signer.getAddress();
  const usdc     = new ethers.Contract(ADDRESSES.usdc, USDC_ABI, provider);
  const nonce    = await usdc.nonces(owner);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSecs);

  const domain = {
    name: "USD Coin",
    version: "2",
    chainId: 8453,
    verifyingContract: ADDRESSES.usdc,
  };

  const types = {
    Permit: [
      { name: "owner",    type: "address" },
      { name: "spender",  type: "address" },
      { name: "value",    type: "uint256" },
      { name: "nonce",    type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };

  const message = { owner, spender, value, nonce, deadline };
  const sig = await signer.signTypedData(domain, types, message);
  const { v, r, s } = ethers.Signature.from(sig);
  return { v, r, s, deadline };
}

// ── 1. Single payment via Router ──────────────────────────────────────────────

export async function sendPayment(
  signer: ethers.Signer,
  recipient: string,
  amountUsdc: string,
  memo = "",
) {
  const router = new ethers.Contract(ADDRESSES.router, ROUTER_ABI, signer);
  const amount = ethers.parseUnits(amountUsdc, 6);

  const [feeAmount, netAmount] = await router.quote(amount);
  console.log(`Fee: ${ethers.formatUnits(feeAmount, 6)} USDC → Recipient gets: ${ethers.formatUnits(netAmount, 6)} USDC`);

  const { v, r, s, deadline } = await signUsdcPermit(signer, ADDRESSES.router, amount);
  const tx = await router.sendWithPermit(ADDRESSES.usdc, recipient, amount, memo, deadline, v, r, s);
  return tx.wait();
}

// ── 2. Batch payment ──────────────────────────────────────────────────────────

export async function batchPay(
  signer: ethers.Signer,
  payments: Array<{ recipient: string; amountUsdc: string }>,
  memo = "",
) {
  const batch      = new ethers.Contract(ADDRESSES.batchPay, BATCH_ABI, signer);
  const recipients = payments.map(p => p.recipient);
  const amounts    = payments.map(p => ethers.parseUnits(p.amountUsdc, 6));

  const { totalGross } = await batch.quoteBatch(amounts);
  const { v, r, s, deadline } = await signUsdcPermit(signer, ADDRESSES.batchPay, totalGross);

  const tx = await batch.batchSendWithPermit(
    ADDRESSES.usdc, recipients, amounts, memo, totalGross, deadline, v, r, s,
  );
  return tx.wait();
}

// ── 3. Create escrow ──────────────────────────────────────────────────────────

export async function createEscrow(
  signer: ethers.Signer,
  payee: string,
  amountUsdc: string,
  ttlSeconds: number,
  memo = "",
) {
  const escrowContract = new ethers.Contract(ADDRESSES.escrow, ESCROW_ABI, signer);
  const amount = ethers.parseUnits(amountUsdc, 6);

  const { v, r, s, deadline } = await signUsdcPermit(signer, ADDRESSES.escrow, amount);
  const tx = await escrowContract.createWithPermit(
    ADDRESSES.usdc, payee, amount, ttlSeconds, memo, deadline, v, r, s,
  );
  const receipt = await tx.wait();

  // Parse escrow ID from logs
  const iface     = new ethers.Interface(ESCROW_ABI);
  const escrowLog = receipt.logs
    .map((l: ethers.Log) => { try { return iface.parseLog(l); } catch { return null; } })
    .find((l: ethers.LogDescription | null) => l?.name === "EscrowCreated");

  return { receipt, escrowId: escrowLog?.args.id as bigint | undefined };
}

// ── 4. Recurring subscription ─────────────────────────────────────────────────

const INTERVAL_SECS = {
  daily:   86_400,
  weekly:  604_800,
  monthly: 2_592_000,
} as const;

export async function subscribe(
  signer: ethers.Signer,
  payee: string,
  amountUsdc: string,
  interval: keyof typeof INTERVAL_SECS,
  memo = "",
) {
  const sub    = new ethers.Contract(ADDRESSES.subManager, SUB_ABI, signer);
  const amount = ethers.parseUnits(amountUsdc, 6);

  // Cap permit at 1,000 charges + 3-year deadline (not maxUint256)
  const permitAmount = amount * 1_000n;
  const threeYears   = 3 * 365 * 24 * 3600;
  const { v, r, s, deadline } = await signUsdcPermit(signer, ADDRESSES.subManager, permitAmount, threeYears);

  const tx = await sub.subscribeWithPermit(
    ADDRESSES.usdc, payee, amount, INTERVAL_SECS[interval], memo,
    permitAmount, deadline, v, r, s,
  );
  const receipt = await tx.wait();

  const iface  = new ethers.Interface(SUB_ABI);
  const subLog = receipt.logs
    .map((l: ethers.Log) => { try { return iface.parseLog(l); } catch { return null; } })
    .find((l: ethers.LogDescription | null) => l?.name === "Subscribed");

  return { receipt, subscriptionId: subLog?.args.id as bigint | undefined };
}

// ── 5. Charge a subscription (callable by anyone) ────────────────────────────

export async function chargeSubscription(signer: ethers.Signer, subscriptionId: bigint) {
  const sub        = new ethers.Contract(ADDRESSES.subManager, SUB_ABI, signer);
  const nextCharge = await sub.nextChargeAt(subscriptionId);
  const now        = BigInt(Math.floor(Date.now() / 1000));

  if (now < nextCharge) {
    const dueAt = new Date(Number(nextCharge) * 1000).toISOString();
    throw new Error(`Not due yet. Next charge: ${dueAt}`);
  }

  const tx = await sub.charge(subscriptionId);
  return tx.wait();
}

// ── 6. Read-only helpers ──────────────────────────────────────────────────────

export async function getUsdcBalance(address: string): Promise<string> {
  const usdc    = new ethers.Contract(ADDRESSES.usdc, USDC_ABI, provider);
  const balance = await usdc.balanceOf(address);
  return ethers.formatUnits(balance, 6);
}

export async function quotePayment(amountUsdc: string) {
  const router = new ethers.Contract(ADDRESSES.router, ROUTER_ABI, provider);
  const amount = ethers.parseUnits(amountUsdc, 6);
  const [feeAmount, netAmount] = await router.quote(amount);
  return {
    gross: amountUsdc,
    fee:   ethers.formatUnits(feeAmount, 6),
    net:   ethers.formatUnits(netAmount, 6),
  };
}

// ── 7. Event listener ────────────────────────────────────────────────────────

export function onPayment(
  callback: (event: {
    sender: string;
    recipient: string;
    grossAmount: bigint;
    netAmount: bigint;
    memo: string;
  }) => void,
) {
  const router = new ethers.Contract(ADDRESSES.router, ROUTER_ABI, provider);
  router.on("Payment", (sender, recipient, _token, grossAmount, _fee, netAmount, memo) => {
    callback({ sender, recipient, grossAmount, netAmount, memo });
  });
  return () => router.removeAllListeners("Payment");
}
