/**
 * BasePay V2 — wagmi v2/v3 + React integration examples
 * Contracts verified on Base Mainnet (chainId 8453)
 * https://github.com/osr21/basepay-dapp
 *
 * Install:
 *   pnpm add wagmi viem @tanstack/react-query
 */

import { useCallback } from "react";
import {
  useAccount,
  useReadContract,
  useWriteContract,
  useWaitForTransactionReceipt,
  useSignTypedData,
  useChainId,
  useSwitchChain,
} from "wagmi";
import { parseUnits, parseSignature } from "viem";
import { base } from "viem/chains";

// ── Addresses ─────────────────────────────────────────────────────────────────

export const ADDRESSES = {
  router:     "0x756f516cdf5eb98e140eba44119b22fc0f0bb63f" as const,
  batchPay:   "0xe40d2292c050566d16cecda74627b70778806c68" as const,
  escrow:     "0x1eb2b1e8dda64fc4ccb0537574f2a2ca9f307499" as const,
  subManager: "0x101918a252b3852ac4b50b7bbf2525d3084d5421" as const,
  usdc:       "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const,
} as const;

// ── ABIs (import full JSON from ../BasePayRouterV2.json for production) ───────

const USDC_ABI = [
  { type: "function", name: "balanceOf", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "nonces",    inputs: [{ name: "owner",   type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
] as const;

const ROUTER_ABI = [
  { type: "function", name: "sendWithPermit", inputs: [{ name: "token", type: "address" }, { name: "recipient", type: "address" }, { name: "amount", type: "uint256" }, { name: "memo", type: "string" }, { name: "deadline", type: "uint256" }, { name: "v", type: "uint8" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "quote",          inputs: [{ name: "amount", type: "uint256" }], outputs: [{ name: "feeAmount", type: "uint256" }, { name: "netAmount", type: "uint256" }], stateMutability: "view" },
] as const;

const BATCH_ABI = [
  { type: "function", name: "batchSendWithPermit", inputs: [{ name: "token", type: "address" }, { name: "recipients", type: "address[]" }, { name: "amounts", type: "uint256[]" }, { name: "memo", type: "string" }, { name: "permitAmount", type: "uint256" }, { name: "deadline", type: "uint256" }, { name: "v", type: "uint8" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "quoteBatch",          inputs: [{ name: "amounts", type: "uint256[]" }], outputs: [{ name: "totalGross", type: "uint256" }, { name: "totalFee", type: "uint256" }, { name: "totalNet", type: "uint256" }], stateMutability: "view" },
] as const;

const ESCROW_ABI = [
  { type: "function", name: "createWithPermit", inputs: [{ name: "token", type: "address" }, { name: "payee", type: "address" }, { name: "amount", type: "uint256" }, { name: "ttl", type: "uint256" }, { name: "memo", type: "string" }, { name: "deadline", type: "uint256" }, { name: "v", type: "uint8" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" }], outputs: [{ name: "id", type: "uint256" }], stateMutability: "nonpayable" },
  { type: "function", name: "release",          inputs: [{ name: "id", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "refund",           inputs: [{ name: "id", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
] as const;

const SUB_ABI = [
  { type: "function", name: "subscribeWithPermit", inputs: [{ name: "token", type: "address" }, { name: "payee", type: "address" }, { name: "amount", type: "uint256" }, { name: "interval", type: "uint256" }, { name: "memo", type: "string" }, { name: "permitAmount", type: "uint256" }, { name: "deadline", type: "uint256" }, { name: "v", type: "uint8" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" }], outputs: [{ name: "id", type: "uint256" }], stateMutability: "nonpayable" },
  { type: "function", name: "charge",              inputs: [{ name: "id", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "cancel",              inputs: [{ name: "id", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "nextChargeAt",        inputs: [{ name: "id", type: "uint256" }], outputs: [{ name: "timestamp", type: "uint256" }], stateMutability: "view" },
] as const;

// ── Guard: wrong network banner ───────────────────────────────────────────────
// Always add this to your layout to prevent EIP-712 domain mismatch errors

export function WrongNetworkGuard() {
  const chainId = useChainId();
  const { switchChain, isPending } = useSwitchChain();

  if (chainId === base.id) return null;

  return (
    <div style={{ padding: "12px 16px", background: "#fee2e2", color: "#b91c1c", display: "flex", gap: 12, alignItems: "center" }}>
      <span>Wrong network — BasePay contracts require <b>Base Mainnet</b></span>
      <button
        onClick={() => switchChain({ chainId: base.id })}
        disabled={isPending}
        style={{ marginLeft: "auto", padding: "4px 12px", border: "1px solid #b91c1c", borderRadius: 6, cursor: "pointer" }}
      >
        {isPending ? "Switching…" : "Switch to Base"}
      </button>
    </div>
  );
}

// ── Hook: USDC permit signer ──────────────────────────────────────────────────

function useUsdcPermit(owner: `0x${string}` | undefined) {
  const { refetch: fetchNonce } = useReadContract({
    address: ADDRESSES.usdc,
    abi: USDC_ABI,
    functionName: "nonces",
    args: owner ? [owner] : undefined,
    query: { enabled: !!owner },
  });
  const { signTypedDataAsync } = useSignTypedData();

  const signPermit = useCallback(async (
    spender: `0x${string}`,
    value: bigint,
    deadlineSecs = 3_600,
  ) => {
    if (!owner) throw new Error("Wallet not connected");

    const { data: nonce } = await fetchNonce();
    if (nonce === undefined) throw new Error("Could not fetch USDC nonce");

    const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSecs);
    const sig = await signTypedDataAsync({
      domain:      { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: ADDRESSES.usdc },
      types:       { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
      primaryType: "Permit",
      message:     { owner, spender, value, nonce, deadline },
    });

    const { v, r, s } = parseSignature(sig);
    return { v: Number(v), r, s, deadline };
  }, [owner, fetchNonce, signTypedDataAsync]);

  return { signPermit };
}

// ── Hook: USDC balance ────────────────────────────────────────────────────────

export function useUsdcBalance(address: `0x${string}` | undefined) {
  return useReadContract({
    address: ADDRESSES.usdc,
    abi: USDC_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 10_000 },
  });
}

// ── Hook: Single payment via Router ──────────────────────────────────────────

export function useSendPayment() {
  const { address } = useAccount();
  const { signPermit } = useUsdcPermit(address);
  const { writeContractAsync, data: txHash, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash });

  const send = useCallback(async (
    recipient: `0x${string}`,
    amountUsdc: string,
    memo = "",
  ) => {
    if (!address) throw new Error("Wallet not connected");
    const amount = parseUnits(amountUsdc, 6);
    const { v, r, s, deadline } = await signPermit(ADDRESSES.router, amount);
    return writeContractAsync({
      address: ADDRESSES.router,
      abi: ROUTER_ABI,
      functionName: "sendWithPermit",
      args: [ADDRESSES.usdc, recipient, amount, memo, deadline, v, r, s],
    });
  }, [address, signPermit, writeContractAsync]);

  return { send, txHash, isPending, isConfirming, isSuccess, error };
}

// ── Hook: Batch payment ───────────────────────────────────────────────────────

export function useBatchPay() {
  const { address } = useAccount();
  const { signPermit } = useUsdcPermit(address);
  const { writeContractAsync, data: txHash, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash });

  const batchPay = useCallback(async (
    payments: Array<{ recipient: `0x${string}`; amountUsdc: string }>,
    memo = "",
  ) => {
    if (!address) throw new Error("Wallet not connected");
    const recipients = payments.map(p => p.recipient);
    const amounts    = payments.map(p => parseUnits(p.amountUsdc, 6));
    const total      = amounts.reduce((a, b) => a + b, 0n);
    const { v, r, s, deadline } = await signPermit(ADDRESSES.batchPay, total);

    return writeContractAsync({
      address: ADDRESSES.batchPay,
      abi: BATCH_ABI,
      functionName: "batchSendWithPermit",
      args: [ADDRESSES.usdc, recipients, amounts, memo, total, deadline, v, r, s],
    });
  }, [address, signPermit, writeContractAsync]);

  return { batchPay, txHash, isPending, isConfirming, isSuccess, error };
}

// ── Hook: Create escrow ───────────────────────────────────────────────────────

export function useCreateEscrow() {
  const { address } = useAccount();
  const { signPermit } = useUsdcPermit(address);
  const { writeContractAsync, data: txHash, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash });

  const createEscrow = useCallback(async (
    payee: `0x${string}`,
    amountUsdc: string,
    ttlSeconds: number,
    memo = "",
  ) => {
    if (!address) throw new Error("Wallet not connected");
    const amount = parseUnits(amountUsdc, 6);
    const { v, r, s, deadline } = await signPermit(ADDRESSES.escrow, amount);

    return writeContractAsync({
      address: ADDRESSES.escrow,
      abi: ESCROW_ABI,
      functionName: "createWithPermit",
      args: [ADDRESSES.usdc, payee, amount, BigInt(ttlSeconds), memo, deadline, v, r, s],
    });
  }, [address, signPermit, writeContractAsync]);

  return { createEscrow, txHash, isPending, isConfirming, isSuccess, error };
}

// ── Hook: Subscribe ───────────────────────────────────────────────────────────

const INTERVALS = {
  daily:   86_400n,
  weekly:  604_800n,
  monthly: 2_592_000n,
} as const;

export function useSubscribe() {
  const { address } = useAccount();
  const { signPermit } = useUsdcPermit(address);
  const { writeContractAsync, data: txHash, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash });

  const subscribe = useCallback(async (
    payee: `0x${string}`,
    amountUsdc: string,
    interval: keyof typeof INTERVALS,
    memo = "",
  ) => {
    if (!address) throw new Error("Wallet not connected");
    const amount       = parseUnits(amountUsdc, 6);
    const permitAmount = amount * 1_000n;           // cap at 1,000 cycles (NOT maxUint256)
    const threeYears   = 3 * 365 * 24 * 3600;      // 3-year deadline (NOT year 2100)
    const { v, r, s, deadline } = await signPermit(ADDRESSES.subManager, permitAmount, threeYears);

    return writeContractAsync({
      address: ADDRESSES.subManager,
      abi: SUB_ABI,
      functionName: "subscribeWithPermit",
      args: [ADDRESSES.usdc, payee, amount, INTERVALS[interval], memo, permitAmount, deadline, v, r, s],
    });
  }, [address, signPermit, writeContractAsync]);

  return { subscribe, txHash, isPending, isConfirming, isSuccess, error };
}
