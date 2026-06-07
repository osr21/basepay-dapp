import { useState, useEffect } from "react";
import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import { isAddress, parseUnits, formatUnits, parseAbi } from "viem";
import { useGetSwapQuote, useExecuteGaslessSwap, useExecuteApprovedSwap, getGetSwapQuoteQueryKey } from "@workspace/api-client-react";
import { GASLESS_TOKENS, type GaslessToken } from "@/lib/wagmi";
import { useTokenPermit } from "@/lib/useTokenPermit";
import { WalletButton } from "@/components/Layout";

type Step = "idle" | "approving" | "signing" | "swapping" | "done";

const APPROVE_ABI = parseAbi(["function approve(address spender, uint256 amount) external returns (bool)"]);

const BALANCE_ABI = [
  { type: "function", name: "balanceOf", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
] as const;

function TokenBadge({ token }: { token: GaslessToken }) {
  return (
    <span className="flex items-center gap-1.5 font-semibold">
      <span className="text-base leading-none">{token.flag}</span>
      {token.symbol}
    </span>
  );
}

export default function SwapPage() {
  const { address, isConnected, connector } = useAccount();
  const publicClient = usePublicClient();

  // Detect smart wallets — EIP-2612 permit requires an EOA ECDSA signature.
  // Smart wallets that use passkey (WebAuthn/p256) signing produce signatures
  // that USDC's permit function cannot verify, causing the permit TX to revert.
  // Always run the bytecode check — do NOT shortcut for injected connectors.
  // Coinbase Smart Wallet (extension mode) injects itself as window.ethereum so
  // wagmi labels it connector.id === "injected", but its addresses still carry
  // EIP-7702 / smart-contract bytecode and use passkey signing that is
  // incompatible with EIP-2612.  The eth_getCode call is cheap and cached for
  // 60 s, so the extra RPC round-trip is negligible.
  const { data: walletBytecode, isFetching: isBytecodeFetching } = useQuery({
    queryKey:  ["walletBytecode", address],
    queryFn:   () => publicClient!.getBytecode({ address: address! }),
    enabled:   !!address && !!publicClient,
    staleTime: 60_000,
  });
  // Block interaction until the check resolves — if we treated an in-flight
  // check as "not a smart wallet", users could click through before the result
  // arrives, the permit would land on-chain but grant no allowance, and TX2
  // would fail after gas is already spent by the relayer.
  const isSmartWalletPending = !!address && isBytecodeFetching;
  const isSmartWallet = !!walletBytecode && walletBytecode !== "0x";

  // Token direction: index 0 = USDC, index 1 = EURC
  const [fromIdx, setFromIdx] = useState(0);
  const fromToken: GaslessToken = GASLESS_TOKENS[fromIdx];
  const toToken:   GaslessToken = GASLESS_TOKENS[1 - fromIdx];

  const [amount, setAmount] = useState("");
  const [step,           setStep]           = useState<Step>("idle");
  const [txHash,         setTxHash]         = useState<string | undefined>();
  const [receivedAmount, setReceivedAmount] = useState<string | undefined>();
  const [error,          setError]          = useState<string | undefined>();

  // ── Balances ────────────────────────────────────────────────────────────────
  const { data: fromBalRaw, refetch: refetchFromBal } = useReadContract({
    address:      fromToken.address,
    abi:          BALANCE_ABI,
    functionName: "balanceOf",
    args:         address ? [address] : undefined,
    query:        { enabled: !!address, refetchInterval: 15_000 },
  });
  const { data: toBalRaw, refetch: refetchToBal } = useReadContract({
    address:      toToken.address,
    abi:          BALANCE_ABI,
    functionName: "balanceOf",
    args:         address ? [address] : undefined,
    query:        { enabled: !!address, refetchInterval: 15_000 },
  });

  const fromBal = fromBalRaw !== undefined ? (fromBalRaw as bigint) : undefined;
  const toBal   = toBalRaw   !== undefined ? (toBalRaw   as bigint) : undefined;

  function fmtBal(raw: bigint | undefined, decimals: number) {
    if (raw === undefined) return "—";
    return parseFloat(formatUnits(raw, decimals)).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  // ── Quote (debounced by React Query staleTime) ─────────────────────────────
  const amountBig = (() => {
    try { return amount ? parseUnits(amount, fromToken.decimals) : undefined; } catch { return undefined; }
  })();

  const quoteParams = {
    tokenIn:  fromToken.address,
    tokenOut: toToken.address,
    amountIn: amountBig ? amountBig.toString() : "",
  };
  const { data: quote, isFetching: isQuoting, error: quoteError } = useGetSwapQuote(
    quoteParams,
    {
      query: {
        queryKey:        getGetSwapQuoteQueryKey(quoteParams),
        enabled:         !!amountBig && amountBig > 0n,
        staleTime:       10_000,
        refetchInterval: 15_000,
      },
    },
  );

  // Clear errors when amount or direction changes
  useEffect(() => {
    setError(undefined);
  }, [amount, fromIdx]);

  // ── EOA flow: permit + swap ────────────────────────────────────────────────
  const { signPermit }              = useTokenPermit(address, fromToken);
  const { mutateAsync: execSwap }   = useExecuteGaslessSwap();

  const canSwap = !isSmartWallet && !isSmartWalletPending && !!amountBig && amountBig > 0n && !!quote && !!quote.relayerAddress && step === "idle" && isConnected;

  async function handleSwap() {
    if (!canSwap || !address || !quote?.relayerAddress) return;
    setError(undefined);

    if (fromBal !== undefined && amountBig! > fromBal) {
      setError(`Insufficient ${fromToken.symbol} balance`);
      return;
    }

    try {
      setStep("signing");
      const permitter = quote.relayerAddress as `0x${string}`;
      const { v, r, s, deadline } = await signPermit(permitter, amountBig!, 1_800);

      setStep("swapping");
      const result = await execSwap({
        data: {
          tokenIn:  fromToken.address,
          tokenOut: toToken.address,
          amountIn: amountBig!.toString(),
          owner:    address,
          deadline: deadline.toString(),
          permitV:  v,
          permitR:  r,
          permitS:  s,
          slippageBps: 50,
        },
      });

      setTxHash(result.txHash);
      setReceivedAmount(result.amountOutAfterFee);
      setStep("done");
      void refetchFromBal();
      void refetchToBal();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.toLowerCase().includes("rejected") && !msg.toLowerCase().includes("denied")) {
        setError(msg.slice(0, 400));
      }
      setStep("idle");
    }
  }

  // ── Smart wallet flow: approve + swap ──────────────────────────────────────
  // Smart wallets (Coinbase Smart Wallet, Safe) can execute regular on-chain txs
  // with passkeys but cannot produce off-chain EIP-2612 permit signatures.
  // The user sends a regular approve() tx (possibly gas-sponsored by Coinbase
  // paymaster), then the relayer calls transferFrom → swap → pay back.
  const { writeContractAsync }         = useWriteContract();
  const { mutateAsync: execApprovedSwap } = useExecuteApprovedSwap();

  const canSmartWalletSwap = isSmartWallet && !isSmartWalletPending && !!amountBig && amountBig > 0n && !!quote && !!quote.relayerAddress && step === "idle" && isConnected;

  async function handleSmartWalletSwap() {
    if (!canSmartWalletSwap || !address || !quote?.relayerAddress || !publicClient) return;
    setError(undefined);

    if (fromBal !== undefined && amountBig! > fromBal) {
      setError(`Insufficient ${fromToken.symbol} balance`);
      return;
    }

    try {
      // Step 1: on-chain approve (user signs with passkey — this works)
      setStep("approving");
      const relayerAddr = quote.relayerAddress as `0x${string}`;
      const approveTxHash = await writeContractAsync({
        address:      fromToken.address,
        abi:          APPROVE_ABI,
        functionName: "approve",
        args:         [relayerAddr, amountBig!],
      });
      await publicClient.waitForTransactionReceipt({ hash: approveTxHash, confirmations: 1 });

      // Step 2: relayer pulls + swaps + delivers output
      setStep("swapping");
      const result = await execApprovedSwap({
        data: {
          tokenIn:     fromToken.address,
          tokenOut:    toToken.address,
          amountIn:    amountBig!.toString(),
          owner:       address,
          slippageBps: 50,
        },
      });

      setTxHash(result.txHash);
      setReceivedAmount(result.amountOutAfterFee);
      setStep("done");
      void refetchFromBal();
      void refetchToBal();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.toLowerCase().includes("rejected") && !msg.toLowerCase().includes("denied")) {
        setError(msg.slice(0, 400));
      }
      setStep("idle");
    }
  }

  function handleReset() {
    setAmount(""); setStep("idle"); setTxHash(undefined); setReceivedAmount(undefined); setError(undefined);
  }

  function handleFlip() {
    setFromIdx(i => 1 - i);
    setAmount("");
  }

  // Aerodrome pool label
  const poolLabel = quote?.stable ? "Aerodrome (stable)" : "Aerodrome (volatile)";

  // ── Not connected ──────────────────────────────────────────────────────────
  if (!isConnected) {
    return (
      <div className="max-w-md mx-auto flex flex-col items-center justify-center min-h-[50vh] text-center">
        <p className="text-muted-foreground mb-4">Connect your wallet to swap USDC ↔ EURC</p>
        <WalletButton />
      </div>
    );
  }

  // ── Approving (smart wallet step 1) ───────────────────────────────────────
  if (step === "approving") {
    return (
      <div className="max-w-md mx-auto">
        <div className="rounded-2xl border border-yellow-500/20 bg-card p-8 text-center space-y-4">
          <div className="w-14 h-14 rounded-full border border-yellow-500/30 bg-yellow-500/10 flex items-center justify-center mx-auto glow-pulse">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="rgb(234 179 8)" strokeWidth="2">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </div>
          <h2 className="text-lg font-bold">Approve in wallet</h2>
          <p className="text-sm text-muted-foreground">
            Confirm the <span className="text-yellow-400 font-medium">approve</span> transaction in your wallet.
            This lets the relayer pull your {fromToken.symbol} once — then it handles the rest for free.
          </p>
          <p className="text-xs text-muted-foreground font-mono">Waiting for on-chain confirmation...</p>
        </div>
      </div>
    );
  }

  // ── Signing ────────────────────────────────────────────────────────────────
  if (step === "signing") {
    return (
      <div className="max-w-md mx-auto">
        <div className="rounded-2xl border border-primary/20 bg-card p-8 text-center space-y-4">
          <div className="w-14 h-14 rounded-full border border-primary/30 bg-primary/10 flex items-center justify-center mx-auto glow-pulse">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="hsl(221,83%,63%)" strokeWidth="2">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
          </div>
          <h2 className="text-lg font-bold">Sign permit in wallet</h2>
          <p className="text-sm text-muted-foreground">
            This is an off-chain signature — <span className="text-green-400 font-medium">not a transaction</span>.
            Authorises the relayer to pull your {fromToken.symbol}. Zero gas from you.
          </p>
          <p className="text-xs text-muted-foreground font-mono">Waiting for signature...</p>
        </div>
      </div>
    );
  }

  // ── Swapping ───────────────────────────────────────────────────────────────
  if (step === "swapping") {
    return (
      <div className="max-w-md mx-auto">
        <div className="rounded-2xl border border-blue-500/20 bg-card p-8 text-center space-y-4">
          <div className="w-14 h-14 rounded-full border border-blue-500/30 bg-blue-500/10 flex items-center justify-center mx-auto glow-pulse">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="hsl(217,91%,60%)" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
            </svg>
          </div>
          <h2 className="text-lg font-bold">Executing swap...</h2>
          <p className="text-sm text-muted-foreground">
            The BasePay relayer is executing your swap on Aerodrome Finance. This takes a moment.
          </p>
        </div>
      </div>
    );
  }

  // ── Success ────────────────────────────────────────────────────────────────
  if (step === "done") {
    const receivedFormatted = receivedAmount
      ? parseFloat(formatUnits(BigInt(receivedAmount), toToken.decimals)).toFixed(4)
      : "—";
    return (
      <div className="max-w-md mx-auto">
        <div className="rounded-2xl border border-green-500/20 bg-green-500/5 p-8 text-center">
          <div className="w-16 h-16 rounded-full bg-green-500/10 border border-green-500/30 flex items-center justify-center mx-auto mb-4">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="rgb(74 222 128)" strokeWidth="2.5">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </div>
          <h2 className="text-xl font-bold mb-1">Swap Complete</h2>
          <p className="text-muted-foreground text-sm mb-1">
            {amount} {fromToken.symbol} → {receivedFormatted} {toToken.symbol}
          </p>
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-green-500/10 border border-green-500/20 text-xs text-green-400 font-medium mb-4">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
            Zero gas paid — relayed by BasePay
          </div>
          {txHash && (
            <a
              href={`https://basescan.org/tx/${txHash}`}
              target="_blank" rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-primary text-sm hover:underline mb-5 block"
            >
              View on BaseScan
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                <polyline points="15 3 21 3 21 9"/><line x1="10" x2="21" y1="14" y2="3"/>
              </svg>
            </a>
          )}
          <div>
            <button onClick={handleReset} className="px-5 py-2 rounded-lg bg-secondary text-sm hover:bg-secondary/80 transition-all">
              Swap Again
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Swap form ──────────────────────────────────────────────────────────────
  const outFormatted = quote
    ? parseFloat(formatUnits(BigInt(quote.amountOutAfterFee), toToken.decimals)).toFixed(4)
    : null;

  return (
    <div className="max-w-md mx-auto space-y-6">
      <div>
        <div className="flex items-center gap-2 mb-0.5">
          <h1 className="text-xl font-bold">Swap</h1>
          <span className="px-2 py-0.5 rounded-full bg-green-500/10 border border-green-500/20 text-xs text-green-400 font-semibold">Zero ETH</span>
        </div>
        <p className="text-sm text-muted-foreground">
          Swap USDC ↔ EURC via Aerodrome Finance on Base — gasless, one signature
        </p>
      </div>

      <div className="rounded-2xl border border-border bg-card p-6 space-y-3">

        {/* From */}
        <div className="rounded-xl border border-border bg-secondary p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">You pay</span>
            <span className="text-xs text-muted-foreground">
              Balance:{" "}
              <span className="text-foreground font-semibold tabular-nums">
                {fmtBal(fromBal, fromToken.decimals)}
              </span>{" "}
              {fromToken.symbol}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-card border border-border min-w-[90px]">
              <TokenBadge token={fromToken} />
            </div>
            <div className="flex-1 relative">
              <input
                type="number"
                placeholder="0.00"
                value={amount}
                min="0"
                step="0.01"
                onChange={(e) => setAmount(e.target.value)}
                className="w-full bg-transparent text-right text-lg font-semibold placeholder:text-muted-foreground/40 focus:outline-none"
              />
            </div>
          </div>
          {fromBal !== undefined && fromBal > 0n && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setAmount(formatUnits(fromBal, fromToken.decimals))}
                className="text-[10px] font-bold text-primary bg-primary/10 hover:bg-primary/20 px-1.5 py-0.5 rounded transition-colors"
              >
                MAX
              </button>
            </div>
          )}
        </div>

        {/* Flip button */}
        <div className="flex justify-center">
          <button
            onClick={handleFlip}
            className="w-9 h-9 rounded-full border border-border bg-secondary hover:bg-card hover:border-primary/40 flex items-center justify-center transition-all group"
            title="Flip direction"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="group-hover:stroke-primary transition-colors">
              <polyline points="17 1 21 5 17 9"/>
              <path d="M3 11V9a4 4 0 0 1 4-4h14"/>
              <polyline points="7 23 3 19 7 15"/>
              <path d="M21 13v2a4 4 0 0 1-4 4H3"/>
            </svg>
          </button>
        </div>

        {/* To */}
        <div className="rounded-xl border border-border bg-secondary p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">You receive</span>
            <span className="text-xs text-muted-foreground">
              Balance:{" "}
              <span className="text-foreground font-semibold tabular-nums">
                {fmtBal(toBal, toToken.decimals)}
              </span>{" "}
              {toToken.symbol}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-card border border-border min-w-[90px]">
              <TokenBadge token={toToken} />
            </div>
            <div className="flex-1 text-right">
              {isQuoting ? (
                <span className="inline-flex items-center justify-end gap-1.5 text-muted-foreground text-lg">
                  <span className="w-4 h-4 rounded-full border-2 border-primary border-t-transparent animate-spin" />
                </span>
              ) : outFormatted ? (
                <span className="text-lg font-semibold text-green-400">{outFormatted}</span>
              ) : (
                <span className="text-lg font-semibold text-muted-foreground/30">0.00</span>
              )}
            </div>
          </div>
        </div>

        {/* Quote details */}
        {quote && amountBig && (
          <div className="rounded-lg bg-secondary border border-border px-3.5 py-3 text-xs space-y-1.5">
            <div className="flex justify-between text-muted-foreground">
              <span>Rate (gross)</span>
              <span>
                1 {fromToken.symbol} ≈{" "}
                {(parseFloat(formatUnits(BigInt(quote.amountOut), toToken.decimals)) /
                  parseFloat(formatUnits(amountBig, fromToken.decimals))).toFixed(4)}{" "}
                {toToken.symbol}
              </span>
            </div>
            <div className="flex justify-between text-muted-foreground">
              <span>Pool</span>
              <span>{poolLabel}</span>
            </div>
            <div className="flex justify-between text-muted-foreground">
              <span>Slippage tolerance</span>
              <span>0.5%</span>
            </div>
            <div className="flex justify-between text-muted-foreground">
              <span>Protocol fee</span>
              <span>
                0.30% (−{parseFloat(formatUnits(BigInt(quote.protocolFeeAmount), toToken.decimals)).toFixed(4)} {toToken.symbol})
              </span>
            </div>
            <div className="flex justify-between font-semibold text-foreground border-t border-border pt-1.5 mt-0.5">
              <span>You receive</span>
              <span className="text-green-400">{outFormatted} {toToken.symbol}</span>
            </div>
            <div className="flex justify-between text-muted-foreground/60">
              <span>Gas cost to you</span>
              <span className="text-green-400">$0.00</span>
            </div>
          </div>
        )}

        {quoteError && amount && (
          <p className="text-xs text-yellow-400 text-center">
            Quote unavailable — pool may have insufficient liquidity for this amount
          </p>
        )}

        {isSmartWalletPending && (
          <div className="flex items-center gap-2.5 rounded-lg bg-secondary border border-border px-3 py-2.5 text-xs text-muted-foreground">
            <span className="w-3.5 h-3.5 rounded-full border-2 border-primary border-t-transparent animate-spin shrink-0" />
            Checking wallet compatibility…
          </div>
        )}

        {isSmartWallet && (
          <div className="flex items-start gap-2.5 rounded-lg bg-blue-500/10 border border-blue-500/20 px-3 py-2.5">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="hsl(217,91%,60%)" strokeWidth="2" className="shrink-0 mt-0.5">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <p className="text-xs text-blue-400 leading-relaxed">
              <span className="font-semibold">Smart wallet detected.</span> Instead of a permit signature,
              you'll approve once on-chain (may be gas-free via Coinbase paymaster), then the relayer
              handles the swap — no ETH needed beyond the approve.
            </p>
          </div>
        )}

        {error && (
          <div className="text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
            {error}
          </div>
        )}

        <button
          onClick={isSmartWallet ? handleSmartWalletSwap : handleSwap}
          disabled={isSmartWallet ? !canSmartWalletSwap : !canSwap}
          className={`w-full py-3 rounded-lg font-semibold text-sm transition-all ${
            (isSmartWallet ? canSmartWalletSwap : canSwap)
              ? "bg-primary text-primary-foreground hover:bg-primary/90 shadow-[0_0_20px_hsl(221_83%_53%/0.3)] glow-pulse"
              : "bg-secondary text-muted-foreground cursor-not-allowed"
          }`}
        >
          {isSmartWalletPending
            ? "Checking wallet…"
            : !amount || !amountBig
            ? "Enter an amount"
            : !quote
            ? isQuoting ? "Getting quote…" : "Enter an amount"
            : isSmartWallet
            ? `Approve & Swap ${fromToken.symbol} → ${toToken.symbol}`
            : `Swap ${fromToken.symbol} → ${toToken.symbol}`}
        </button>

        <p className="text-center text-xs text-muted-foreground">
          {isSmartWallet
            ? "1 approve tx · relayer pays swap gas · powered by Aerodrome Finance"
            : "1 signature · 0 ETH · powered by Aerodrome Finance"}
        </p>
      </div>

      {/* Info box */}
      <div className="rounded-xl border border-primary/15 bg-primary/5 px-4 py-3 text-xs space-y-1.5 text-muted-foreground">
        <p className="text-foreground font-semibold text-sm mb-1">How gasless swap works</p>
        {isSmartWallet ? (
          <>
            <div className="flex items-start gap-2">
              <span className="text-primary font-bold mt-px">1.</span>
              <span>You send an <strong>approve</strong> transaction — may be sponsored by Coinbase paymaster (free for eligible wallets)</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-primary font-bold mt-px">2.</span>
              <span>BasePay's relayer pulls your {fromToken.symbol}, swaps via Aerodrome Finance, and sends {toToken.symbol} to you — paying all swap gas</span>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-start gap-2">
              <span className="text-primary font-bold mt-px">1.</span>
              <span>You sign an EIP-2612 permit — authorises the relayer off-chain (no gas, no approval tx)</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-primary font-bold mt-px">2.</span>
              <span>BasePay's relayer pulls your tokens, swaps via Aerodrome Finance, and delivers the output — paying all gas</span>
            </div>
          </>
        )}
        <div className="flex items-start gap-2">
          <span className="text-green-400 font-bold mt-px">✓</span>
          <span className="text-green-400">You receive {toToken.symbol} directly in your wallet. Protocol fee: <strong>0.30%</strong></span>
        </div>
      </div>
    </div>
  );
}
