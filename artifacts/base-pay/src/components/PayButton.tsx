/**
 * <PayButton> — OnchainKit-compatible USDC/EURC payment button
 *
 * Wraps BasePayRouterV2.sendWithPermit for one-signature, zero-approval payments.
 * Drop-in for any React app on Base Mainnet.
 *
 * Contract: 0x756f516cdf5eb98e140eba44119b22fc0f0bb63f (BasePayRouterV2, Base Mainnet)
 * Protocol fee: 0.30% (recipient receives 99.70% of amount)
 *
 * Usage:
 *   <PayButton
 *     to="0xRecipient..."
 *     amount="10.00"
 *     memo="Invoice #42"
 *     onSuccess={(hash) => console.log("tx:", hash)}
 *   />
 */

import { useState } from "react";
import {
  useAccount,
  useReadContract,
  useWriteContract,
  useWaitForTransactionReceipt,
  useSignTypedData,
} from "wagmi";
import { parseUnits, parseSignature, type Hex } from "viem";
import { base } from "viem/chains";

// ── Contract constants ────────────────────────────────────────────────────────

const ROUTER_ADDRESS = "0x756f516cdf5eb98e140eba44119b22fc0f0bb63f" as const;
const USDC_ADDRESS   = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const EURC_ADDRESS   = "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42" as const;

const TOKEN_META = {
  [USDC_ADDRESS]: { symbol: "USDC", decimals: 6, domainName: "USD Coin",  domainVersion: "2" },
  [EURC_ADDRESS]: { symbol: "EURC", decimals: 6, domainName: "Euro Coin", domainVersion: "2" },
} as const;

const ROUTER_ABI = [
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
] as const;

const NONCES_ABI = [
  {
    type: "function", name: "nonces",
    inputs:  [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

const PERMIT_TYPES = {
  Permit: [
    { name: "owner",    type: "address" },
    { name: "spender",  type: "address" },
    { name: "value",    type: "uint256" },
    { name: "nonce",    type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

// ── Props ──────────────────────────────────────────────────────────────────────

export interface PayButtonProps {
  /** Recipient wallet address (0x-prefixed) */
  to: `0x${string}`;
  /** Amount in human-readable units — e.g. "10.00" for 10 USDC */
  amount: string;
  /** Token to pay with. Defaults to USDC. */
  token?: typeof USDC_ADDRESS | typeof EURC_ADDRESS;
  /** On-chain memo attached to the Payment event (max 64 chars) */
  memo?: string;
  /** Called with the transaction hash once the tx is submitted */
  onSuccess?: (txHash: `0x${string}`) => void;
  /** Called with an error message string if the payment fails */
  onError?: (error: string) => void;
  /** Button label. Defaults to "Pay {amount} {symbol}" */
  label?: string;
  /** Extra Tailwind classes applied to the button element */
  className?: string;
  /** Disable the button externally */
  disabled?: boolean;
}

// ── Component ──────────────────────────────────────────────────────────────────

type Step = "idle" | "signing" | "submitting" | "confirming" | "done" | "error";

export function PayButton({
  to,
  amount,
  token = USDC_ADDRESS,
  memo  = "",
  onSuccess,
  onError,
  label,
  className = "",
  disabled  = false,
}: PayButtonProps) {
  const { address, isConnected, chain } = useAccount();
  const [step,   setStep]   = useState<Step>("idle");
  const [txHash, setTxHash] = useState<Hex | undefined>();
  const [errMsg, setErrMsg] = useState<string | undefined>();

  const tokenMeta = TOKEN_META[token] ?? TOKEN_META[USDC_ADDRESS];
  const onBase    = chain?.id === base.id;

  // Parse amount safely
  let amountBig: bigint | undefined;
  try { amountBig = amount ? parseUnits(amount, tokenMeta.decimals) : undefined; } catch { amountBig = undefined; }

  // Read permit nonce
  const { refetch: refetchNonce } = useReadContract({
    address:      token,
    abi:          NONCES_ABI,
    functionName: "nonces",
    args:         address ? [address] : undefined,
    query:        { enabled: !!address },
  });

  // Read protocol fee quote
  const { data: quoteData } = useReadContract({
    address:      ROUTER_ADDRESS,
    abi:          ROUTER_ABI,
    functionName: "quote",
    args:         amountBig ? [amountBig] : undefined,
    query:        { enabled: !!amountBig },
  });

  const { signTypedDataAsync } = useSignTypedData();
  const { writeContractAsync  } = useWriteContract();
  const { isLoading: isConfirming } = useWaitForTransactionReceipt({
    hash:  txHash,
    query: { enabled: !!txHash },
  });

  const isBusy   = step === "signing" || step === "submitting" || step === "confirming";
  const canPay   = isConnected && onBase && !!amountBig && amountBig > 0n && !disabled && !isBusy && step !== "done";
  const netAmount = quoteData?.[1];

  async function handlePay() {
    if (!canPay || !address || !amountBig) return;
    setErrMsg(undefined);

    try {
      // 1. Sign EIP-2612 permit (off-chain — no gas, wallet shows "Sign" not "Send")
      setStep("signing");
      const { data: nonce } = await refetchNonce();
      if (nonce === undefined) throw new Error("Could not fetch token nonce");

      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3_600);
      const sig = await signTypedDataAsync({
        domain: {
          name:              tokenMeta.domainName,
          version:           tokenMeta.domainVersion,
          chainId:           8453,
          verifyingContract: token,
        },
        types:       PERMIT_TYPES,
        primaryType: "Permit",
        message:     { owner: address, spender: ROUTER_ADDRESS, value: amountBig, nonce, deadline },
      });

      const { v, r, s } = parseSignature(sig);

      // 2. Submit sendWithPermit (one transaction: permit + transfer atomically)
      setStep("submitting");
      const hash = await writeContractAsync({
        address:      ROUTER_ADDRESS,
        abi:          ROUTER_ABI,
        functionName: "sendWithPermit",
        args:         [token, to, amountBig, memo.slice(0, 64), deadline, Number(v), r as `0x${string}`, s as `0x${string}`],
      });

      setTxHash(hash);
      setStep("confirming");
      onSuccess?.(hash);
      setStep("done");

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.toLowerCase().includes("rejected") && !msg.toLowerCase().includes("denied")) {
        setErrMsg(msg.slice(0, 300));
        onError?.(msg);
      }
      setStep("error");
    }
  }

  function handleReset() {
    setStep("idle");
    setTxHash(undefined);
    setErrMsg(undefined);
  }

  // ── Resolved button label ──────────────────────────────────────────────────
  const resolvedLabel = label ?? `Pay ${amount} ${tokenMeta.symbol}`;

  const baseClass =
    "inline-flex items-center justify-center gap-2 rounded-lg px-5 py-2.5 font-semibold text-sm transition-all focus:outline-none focus:ring-2 focus:ring-offset-2";

  // ── Done state ─────────────────────────────────────────────────────────────
  if (step === "done") {
    return (
      <div className="flex flex-col items-center gap-2">
        <div className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-green-500/10 border border-green-500/20 text-green-400 text-sm font-semibold">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          Payment sent
        </div>
        {txHash && (
          <a
            href={`https://basescan.org/tx/${txHash}`}
            target="_blank" rel="noreferrer"
            className="text-xs text-blue-400 hover:underline flex items-center gap-1"
          >
            View on BaseScan
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
              <polyline points="15 3 21 3 21 9"/>
              <line x1="10" x2="21" y1="14" y2="3"/>
            </svg>
          </a>
        )}
        <button onClick={handleReset} className="text-xs text-muted-foreground hover:underline mt-0.5">
          Send another
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-start gap-1.5">
      <button
        onClick={handlePay}
        disabled={!canPay}
        className={`${baseClass} ${
          canPay
            ? "bg-blue-600 hover:bg-blue-500 text-white shadow-[0_0_16px_hsl(221_83%_53%/0.3)] focus:ring-blue-500"
            : "bg-muted text-muted-foreground cursor-not-allowed opacity-60"
        } ${className}`}
      >
        {step === "signing" && (
          <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" strokeOpacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10"/>
          </svg>
        )}
        {step === "submitting" && (
          <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" strokeOpacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10"/>
          </svg>
        )}
        {step === "confirming" && (
          <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" strokeOpacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10"/>
          </svg>
        )}

        {step === "idle" || step === "error" ? resolvedLabel : null}
        {step === "signing"    ? "Sign in wallet…"    : null}
        {step === "submitting" ? "Sending…"           : null}
        {step === "confirming" ? "Confirming…"        : null}
      </button>

      {/* Fee note */}
      {step === "idle" && netAmount !== undefined && amountBig && (
        <p className="text-[11px] text-muted-foreground/70 ml-1">
          Recipient receives{" "}
          <span className="font-medium text-foreground/60">
            {(Number(netAmount) / 10 ** tokenMeta.decimals).toFixed(2)} {tokenMeta.symbol}
          </span>
          {" "}(0.30% fee)
        </p>
      )}

      {/* Network warning */}
      {isConnected && !onBase && (
        <p className="text-[11px] text-yellow-400 ml-1">Switch to Base Mainnet</p>
      )}

      {/* Error message */}
      {errMsg && (
        <p className="text-[11px] text-red-400 ml-1 max-w-xs">{errMsg}</p>
      )}
    </div>
  );
}

export default PayButton;
