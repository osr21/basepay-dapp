import { useState } from "react";
import { useAccount, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { isAddress } from "viem";
import { useListContacts, useGetAppConfig } from "@workspace/api-client-react";
import {
  USDC_ADDRESS, USDC_ABI, ROUTER_ABI,
  FEE_COLLECTOR_ADDRESS, HAS_ROUTER, ROUTER_ADDRESS,
  parseUSDC, truncateAddress, calcFee,
} from "@/lib/wagmi";
import { useUsdcPermit } from "@/lib/useUsdcPermit";
import { useBasenameResolve } from "@/lib/useBasename";
import { useUniswapEthPrice } from "@/lib/useUniswapEthPrice";
import { WalletButton } from "@/components/Layout";
import WalletName from "@/components/WalletName";
import BlockaidNotice from "@/components/BlockaidNotice";

type SendStep = "idle" | "signing" | "fee" | "payment" | "done";

export default function SendPage() {
  const { address, isConnected } = useAccount();
  const [to, setTo]               = useState("");
  const [amount, setAmount]       = useState("");
  const [memo, setMemo]           = useState("");
  const [showContacts, setShowContacts] = useState(false);
  const [step, setStep]           = useState<SendStep>("idle");
  const [isSigning, setIsSigning] = useState(false);
  const [feeTxHash, setFeeTxHash] = useState<`0x${string}` | undefined>();
  const [mainTxHash, setMainTxHash] = useState<`0x${string}` | undefined>();
  const [signError, setSignError] = useState<string | undefined>();
  const [routerEnabled, setRouterEnabled] = useState(false);

  const { data: contacts } = useListContacts(
    { ownerAddress: address },
    { query: { enabled: !!address, queryKey: ["listContacts", address] } }
  );
  const { data: appConfig } = useGetAppConfig();

  const feeBps        = appConfig?.feeBps ?? 30;
  const feeCollector  = (appConfig?.feeCollectorAddress ?? FEE_COLLECTOR_ADDRESS) as `0x${string}`;
  const routerAddr    = (appConfig?.routerAddress ?? (HAS_ROUTER ? ROUTER_ADDRESS : "")) as `0x${string}` | "";
  const useRouter     = routerEnabled && routerAddr.startsWith("0x") && routerAddr.length === 42;

  const { fee, net } = calcFee(amount);
  const feePercent   = (feeBps / 100).toFixed(2);

  const { signPermit } = useUsdcPermit(address);

  // ── Basenames forward resolution ────────────────────────────────────────────
  const {
    isName: toIsBasename,
    data:   toResolved,
    isFetching: isResolvingName,
  } = useBasenameResolve(to);

  // The address actually used for the transaction
  const effectiveTo: string = (toIsBasename && toResolved) ? toResolved : to;

  // ── Uniswap price feed (ETH/USDC spot price, read-only) ─────────────────────
  const { usdcPerEth, ethForUsdc, uniswapSwapUrl } = useUniswapEthPrice();

  // ── Write hooks ────────────────────────────────────────────────────────────
  const {
    writeContract: writeMain,
    data: mainHash,
    isPending: isMainPending,
    error: mainError,
    reset: resetMain,
  } = useWriteContract();
  const { isLoading: isMainConfirming, isSuccess: mainConfirmed } =
    useWaitForTransactionReceipt({ hash: mainHash });

  const {
    writeContract: writeFee,
    data: feeHash,
    isPending: isFeePending,
    error: feeError,
    reset: resetFee,
  } = useWriteContract();
  const { isLoading: isFeeConfirming, isSuccess: feeConfirmed } =
    useWaitForTransactionReceipt({ hash: feeHash });

  // ── When fee tx confirmed → send main (non-router flow) ───────────────────
  if (feeConfirmed && step === "fee" && !mainHash) {
    setFeeTxHash(feeHash);
    setStep("payment");
    writeMain({
      address: USDC_ADDRESS,
      abi: USDC_ABI,
      functionName: "transfer",
      args: [to as `0x${string}`, parseUSDC(net)],
    });
  }

  if (mainConfirmed && step === "payment" && mainHash && !mainTxHash) {
    setMainTxHash(mainHash);
    setStep("done");
  }

  const isValidAddress = isAddress(effectiveTo);
  const isValidAmount  = parseFloat(amount) > 0;
  const isBusy         = isSigning || isFeePending || isFeeConfirming || isMainPending || isMainConfirming;
  const canSend        = isValidAddress && isValidAmount && !isBusy && step === "idle" && !isResolvingName;

  async function handleSend() {
    if (!canSend) return;

    if (useRouter) {
      setIsSigning(true);
      setSignError(undefined);
      try {
        const { v, r, s, deadline } = await signPermit(
          routerAddr as `0x${string}`,
          parseUSDC(amount),
        );
        setIsSigning(false);
        setStep("payment");
        writeMain({
          address: routerAddr as `0x${string}`,
          abi: ROUTER_ABI,
          functionName: "sendWithPermit",
          args: [USDC_ADDRESS, effectiveTo as `0x${string}`, parseUSDC(amount), memo, deadline, v, r, s],
        });
      } catch (err: unknown) {
        setIsSigning(false);
        setStep("idle");
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.toLowerCase().includes("rejected") && !msg.toLowerCase().includes("denied")) {
          setSignError(msg.slice(0, 120));
        }
      }
      return;
    }

    // Two-step: fee transfer first (no router)
    setStep("fee" as SendStep);
    const feeAmount = parseUSDC(fee);
    if (feeAmount > 0n) {
      writeFee({
        address: USDC_ADDRESS,
        abi: USDC_ABI,
        functionName: "transfer",
        args: [feeCollector, feeAmount],
      });
    } else {
      setStep("payment");
      writeMain({
        address: USDC_ADDRESS,
        abi: USDC_ABI,
        functionName: "transfer",
        args: [effectiveTo as `0x${string}`, parseUSDC(amount)],
      });
    }
  }

  function handleReset() {
    resetMain(); resetFee();
    setTo(""); setAmount(""); setMemo("");
    setStep("idle"); setFeeTxHash(undefined); setMainTxHash(undefined); setSignError(undefined);
  }

  // ── Not connected ──────────────────────────────────────────────────────────
  if (!isConnected) {
    return (
      <div className="max-w-md mx-auto flex flex-col items-center justify-center min-h-[50vh] text-center">
        <p className="text-muted-foreground mb-4">Connect your wallet to send USDC</p>
        <WalletButton />
      </div>
    );
  }

  // ── Signing in progress ────────────────────────────────────────────────────
  if (isSigning) {
    return (
      <div className="max-w-md mx-auto">
        <div className="rounded-2xl border border-primary/20 bg-card p-8 text-center space-y-4">
          <div className="w-14 h-14 rounded-full border border-primary/30 bg-primary/10 flex items-center justify-center mx-auto glow-pulse">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="hsl(221,83%,63%)" strokeWidth="2">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
          </div>
          <h2 className="text-lg font-bold">Sign message in wallet</h2>
          <p className="text-sm text-muted-foreground">
            This is an off-chain signature — <span className="text-green-400 font-medium">not a transaction</span>. No gas, no approval step. MetaMask may show a Blockaid alert — click <span className="text-yellow-300 font-medium">"Proceed anyway"</span> to continue.
          </p>
          <p className="text-xs text-muted-foreground font-mono">Waiting for signature...</p>
        </div>
      </div>
    );
  }

  // ── Success ────────────────────────────────────────────────────────────────
  if (step === "done") {
    return (
      <div className="max-w-md mx-auto space-y-4">
        <div className="rounded-2xl border border-green-500/20 bg-green-500/5 p-8 text-center">
          <div className="w-16 h-16 rounded-full bg-green-500/10 border border-green-500/30 flex items-center justify-center mx-auto mb-4">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="rgb(74 222 128)" strokeWidth="2.5">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </div>
          <h2 className="text-xl font-bold mb-1">Payment Sent</h2>
          <p className="text-muted-foreground text-sm mb-1">{net} USDC to</p>
          <WalletName address={to} showAvatar={true} avatarSize={20} className="text-sm mb-4 justify-center" />

          <div className="text-xs text-muted-foreground bg-secondary rounded-lg px-3 py-2 mb-4 space-y-1 text-left">
            <div className="flex justify-between">
              <span>Gross amount</span>
              <span>{amount} USDC</span>
            </div>
            <div className="flex justify-between text-primary">
              <span>Protocol fee ({feePercent}%)</span>
              <span>−{fee} USDC</span>
            </div>
            <div className="flex justify-between font-semibold text-foreground border-t border-border pt-1 mt-1">
              <span>Recipient received</span>
              <span>{net} USDC</span>
            </div>
          </div>

          {mainTxHash && (
            <a
              href={`https://basescan.org/tx/${mainTxHash}`}
              target="_blank" rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-primary text-sm hover:underline"
            >
              View on BaseScan
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" x2="21" y1="14" y2="3"/></svg>
            </a>
          )}
          <div className="mt-5">
            <button onClick={handleReset} className="px-5 py-2 rounded-lg bg-secondary text-sm hover:bg-secondary/80 transition-all">
              Send Another
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── In-progress steps ──────────────────────────────────────────────────────
  const stepLabel = () => {
    if ((step as string) === "fee" && isFeePending)    return "Step 1/2: Confirm fee in wallet...";
    if ((step as string) === "fee" && isFeeConfirming) return "Step 1/2: Confirming fee...";
    if (step === "payment" && isMainPending)    return useRouter ? "Confirm payment in wallet..." : "Step 2/2: Confirm payment in wallet...";
    if (step === "payment" && isMainConfirming) return useRouter ? "Confirming payment..." : "Step 2/2: Confirming payment...";
    return null;
  };
  const inProgressLabel = stepLabel();

  const error = signError ?? (feeError?.message ?? mainError?.message);

  // ── Form ───────────────────────────────────────────────────────────────────
  return (
    <div className="max-w-md mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-bold">Send USDC</h1>
        <p className="text-sm text-muted-foreground">Transfer instantly on Base</p>
      </div>

      <div className="rounded-2xl border border-border bg-card p-6 space-y-5">
        {/* Recipient */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-sm font-medium">Recipient</label>
            {contacts && contacts.length > 0 && (
              <button onClick={() => setShowContacts(!showContacts)} className="text-xs text-primary hover:underline">
                {showContacts ? "Hide contacts" : "From contacts"}
              </button>
            )}
          </div>
          {showContacts && contacts && (
            <div className="mb-2 rounded-lg border border-border bg-secondary overflow-hidden max-h-40 overflow-y-auto">
              {contacts.map((c) => (
                <button
                  key={c.id}
                  className="w-full flex items-center justify-between px-3 py-2.5 hover:bg-card transition-colors text-left"
                  onClick={() => { setTo(c.walletAddress); setShowContacts(false); }}
                >
                  <span className="text-sm font-medium">{c.name}</span>
                  <WalletName address={c.walletAddress} className="text-xs text-muted-foreground" />
                </button>
              ))}
            </div>
          )}
          <input
            type="text"
            placeholder="0x... address or name.base.eth"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className={`w-full px-3.5 py-2.5 rounded-lg border bg-secondary text-sm font-mono placeholder:text-muted-foreground focus:outline-none focus:ring-1 transition-all ${
              to && !isValidAddress && !isResolvingName ? "border-destructive/60 focus:ring-destructive/40" : "border-border focus:ring-primary/40 focus:border-primary/40"
            }`}
          />
          {/* Basename resolution status */}
          {toIsBasename && isResolvingName && (
            <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded-full border-2 border-primary border-t-transparent animate-spin" />
              Resolving Basename…
            </p>
          )}
          {toIsBasename && !isResolvingName && toResolved && (
            <p className="text-xs text-green-400 mt-1 font-mono flex items-center gap-1">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
              {truncateAddress(toResolved)}
              <span className="text-muted-foreground font-sans">via Basenames</span>
            </p>
          )}
          {toIsBasename && !isResolvingName && !toResolved && (
            <p className="text-xs text-destructive mt-1">Basename not found on Base</p>
          )}
          {to && !toIsBasename && !isValidAddress && (
            <p className="text-xs text-destructive mt-1">Invalid address or Basename</p>
          )}
        </div>

        {/* Amount */}
        <div>
          <label className="text-sm font-medium block mb-1.5">Amount</label>
          <div className="relative">
            <input
              type="number"
              placeholder="0.00"
              value={amount}
              min="0"
              step="0.01"
              onChange={(e) => setAmount(e.target.value)}
              className="w-full px-3.5 py-2.5 pr-16 rounded-lg border border-border bg-secondary text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/40 focus:border-primary/40 transition-all"
            />
            <span className="absolute right-3.5 top-1/2 -translate-y-1/2 text-xs font-semibold text-primary bg-primary/10 px-2 py-0.5 rounded">USDC</span>
          </div>
        </div>

        {/* Fee breakdown */}
        {isValidAmount && (
          <div className="rounded-lg bg-secondary border border-border px-3.5 py-3 text-xs space-y-1.5">
            <div className="flex justify-between text-muted-foreground">
              <span>Gross amount</span>
              <span>{amount} USDC</span>
            </div>
            <div className="flex justify-between text-primary">
              <span>
                Protocol fee ({feePercent}%)
                {useRouter && <span className="ml-1 text-green-400 text-[10px]">— via router</span>}
              </span>
              <span>−{fee} USDC</span>
            </div>
            <div className="flex justify-between font-semibold text-foreground border-t border-border pt-1.5">
              <span>Recipient gets</span>
              <span>{net} USDC</span>
            </div>
            {!useRouter && fee !== "0.00" && (
              <p className="text-[10px] text-yellow-500/70 pt-0.5">
                ⚠ 2 confirmations required. If you reject the second, the fee is non-refundable. Enable the Router above for one atomic transaction.
              </p>
            )}
            {!useRouter && fee === "0.00" && (
              <p className="text-[10px] text-muted-foreground/60 pt-0.5">
                2 wallet confirmations required (fee + payment)
              </p>
            )}
          </div>
        )}

        {/* Uniswap price hint */}
        {isValidAmount && usdcPerEth && (
          <div className="flex items-center justify-between text-xs text-muted-foreground px-0.5">
            <span>
              ≈ <span className="text-foreground font-medium">{ethForUsdc(parseFloat(amount))?.toFixed(5)}</span> ETH needed
              <span className="ml-1 text-muted-foreground/60">@ ${usdcPerEth.toLocaleString()} USDC/ETH</span>
            </span>
            <a
              href={uniswapSwapUrl(amount)}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 text-primary hover:underline"
            >
              Swap on Uniswap
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" x2="21" y1="14" y2="3"/></svg>
            </a>
          </div>
        )}

        {/* Memo */}
        <div>
          <label className="text-sm font-medium block mb-1.5">Memo <span className="text-muted-foreground font-normal">(optional)</span></label>
          <input
            type="text"
            placeholder="What's this for?"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            className="w-full px-3.5 py-2.5 rounded-lg border border-border bg-secondary text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/40 focus:border-primary/40 transition-all"
          />
        </div>

        {/* Error */}
        {error && (
          <div className="text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
            {error.slice(0, 150)}
          </div>
        )}

        {/* Router toggle */}
        {HAS_ROUTER && (
          <div className={`flex items-start gap-3 rounded-lg border px-3.5 py-3 transition-colors cursor-pointer ${
            routerEnabled ? "border-green-500/30 bg-green-500/5" : "border-border bg-secondary/50"
          }`} onClick={() => setRouterEnabled(r => !r)}>
            <div className={`w-4 h-4 mt-0.5 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${
              routerEnabled ? "bg-green-500 border-green-500" : "border-muted-foreground/40"
            }`}>
              {routerEnabled && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>}
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-foreground">⚡ Single-transaction via Router <span className="text-blue-400 font-normal text-[10px]">verified on Basescan</span></p>
              <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
                {routerEnabled
                  ? "Sign a message (off-chain, no gas) → confirm 1 transaction. Fee + payment in one atomic tx. No approval step."
                  : "Default: 2 txs (fee + payment). Enable router for a single atomic transaction — uses a signed message instead of approve."}
              </p>
            </div>
          </div>
        )}

        {/* Blockaid notice — only shown for the permit (router) path */}
        {useRouter && (
          <BlockaidNotice
            contractAddress={routerAddr}
            contractName="BasePayRouterV2"
          />
        )}

        {/* CTA */}
        <button
          onClick={handleSend}
          disabled={!canSend}
          className={`w-full py-3 rounded-lg font-semibold text-sm transition-all ${
            canSend
              ? "bg-primary text-primary-foreground hover:bg-primary/90 shadow-[0_0_20px_hsl(221_83%_53%/0.3)] glow-pulse"
              : "bg-secondary text-muted-foreground cursor-not-allowed"
          }`}
        >
          {inProgressLabel ?? (useRouter ? "Sign & Send via Router" : "Send USDC")}
        </button>
      </div>
    </div>
  );
}
