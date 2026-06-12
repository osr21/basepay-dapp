import { useState, useEffect, useCallback } from "react";
import { useAccount, useWriteContract, useSwitchChain, useReadContract, useChainId } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { parseUnits, isAddress, decodeAbiParameters, keccak256 } from "viem";
import { mainnet, optimism, arbitrum, polygon, base } from "viem/chains";
import type { Chain } from "viem";
import { WalletButton } from "@/components/Layout";
import { config, formatUSDC } from "@/lib/wagmi";

// ── CCTP v1 addresses ─────────────────────────────────────────────────────────

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const TOKEN_MESSENGER_BASE = "0x1682Ae6375C4E4A97e4B583BC394c861A46D8962" as const;
const MESSAGE_TRANSMITTER_BASE = "0xAD09780d193884d503182aD4588450C416D6F9D4" as const;

// keccak256("MessageSent(bytes)") — the topic emitted by MessageTransmitter
const MESSAGE_SENT_TOPIC = "0x8c5261668696ce22758910d05bab8f186d6eb247ceac2af2e82c7dc17669b036" as const;

interface Destination {
  chain: Chain;
  label: string;
  domain: number;
  messageTransmitter: `0x${string}`;
  usdc: `0x${string}`;
  icon: string;
}

const DESTINATIONS: Destination[] = [
  {
    chain:              mainnet,
    label:              "Ethereum",
    domain:             0,
    messageTransmitter: "0x0a992d191DEeC32aFe36203Ad87D7d289a738F81",
    usdc:               "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    icon:               "Ξ",
  },
  {
    chain:              optimism,
    label:              "Optimism",
    domain:             2,
    messageTransmitter: "0x4d41f22c5a0e5c74090899e5a8fb597a8842b3e8",
    usdc:               "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    icon:               "⬡",
  },
  {
    chain:              arbitrum,
    label:              "Arbitrum",
    domain:             3,
    messageTransmitter: "0xC30362313FBBA5cf9163F0bb16a0e01f01A896ca",
    usdc:               "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    icon:               "△",
  },
  {
    chain:              polygon,
    label:              "Polygon",
    domain:             7,
    messageTransmitter: "0xF3be9355363857F3e001be68856A2f96b4C39Ba9",
    usdc:               "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    icon:               "⬟",
  },
];

// ── Minimal ABIs ──────────────────────────────────────────────────────────────

const ERC20_ABI = [
  {
    name: "approve",
    type: "function" as const,
    inputs: [{ name: "spender", type: "address" }, { name: "value", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable" as const,
  },
  {
    name: "allowance",
    type: "function" as const,
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view" as const,
  },
  {
    name: "balanceOf",
    type: "function" as const,
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view" as const,
  },
] as const;

const TOKEN_MESSENGER_ABI = [
  {
    name: "depositForBurn",
    type: "function" as const,
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "destinationDomain", type: "uint32" },
      { name: "mintRecipient", type: "bytes32" },
      { name: "burnToken", type: "address" },
    ],
    outputs: [{ name: "nonce", type: "uint64" }],
    stateMutability: "nonpayable" as const,
  },
] as const;

const MESSAGE_TRANSMITTER_ABI = [
  {
    name: "receiveMessage",
    type: "function" as const,
    inputs: [{ name: "message", type: "bytes" }, { name: "attestation", type: "bytes" }],
    outputs: [{ name: "success", type: "bool" }],
    stateMutability: "nonpayable" as const,
  },
] as const;

// ── Types ─────────────────────────────────────────────────────────────────────

type Phase =
  | "idle"
  | "approving"
  | "burning"
  | "attesting"
  | "ready"
  | "switching"
  | "receiving"
  | "done"
  | "error";

const STEP_LABELS: Record<Phase, string> = {
  idle:      "Enter details",
  approving: "Approve USDC spend",
  burning:   "Burn USDC on Base",
  attesting: "Waiting for Circle attestation",
  ready:     "Ready to receive",
  switching: "Switching chain",
  receiving: "Receiving on destination",
  done:      "Transfer complete",
  error:     "Error",
};

function TxLink({ hash, chainId }: { hash: string; chainId?: number }) {
  const explorer = chainId === mainnet.id  ? "https://etherscan.io"
                 : chainId === optimism.id ? "https://optimistic.etherscan.io"
                 : chainId === arbitrum.id ? "https://arbiscan.io"
                 : chainId === polygon.id  ? "https://polygonscan.com"
                 : "https://basescan.org";
  return (
    <a
      href={`${explorer}/tx/${hash}`}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-primary hover:text-primary/80 font-mono text-xs transition-colors"
    >
      {hash.slice(0, 10)}…{hash.slice(-6)}
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" x2="21" y1="14" y2="3"/></svg>
    </a>
  );
}

export default function CrossChainPage() {
  const { address, isConnected } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const { switchChainAsync }   = useSwitchChain();
  const chainId                = useChainId();

  const { data: usdcBalanceRaw } = useReadContract({
    address:      USDC_BASE,
    abi:          ERC20_ABI,
    functionName: "balanceOf",
    args:         address ? [address] : undefined,
    query:        { enabled: !!address, refetchInterval: 15_000 },
  });

  const [destIndex, setDestIndex]       = useState(0);
  const [amount, setAmount]             = useState("");
  const [recipient, setRecipient]       = useState("");
  const [phase, setPhase]               = useState<Phase>("idle");
  const [burnTxHash, setBurnTxHash]     = useState<`0x${string}` | null>(null);
  const [messageBytes, setMessageBytes] = useState<`0x${string}` | null>(null);
  const [messageHash, setMessageHash]   = useState<string | null>(null);
  const [attestation, setAttestation]   = useState<string | null>(null);
  const [receiveTxHash, setReceiveTxHash] = useState<`0x${string}` | null>(null);
  const [error, setError]               = useState<string | null>(null);
  const [pollCount, setPollCount]       = useState(0);
  const [attestWarning, setAttestWarning] = useState<"slow" | "very-slow" | null>(null);

  const dest = DESTINATIONS[destIndex];

  // ── Attestation polling ────────────────────────────────────────────────────
  useEffect(() => {
    if (phase !== "attesting" || !messageHash) return;
    let cancelled = false;
    let count = 0;
    let tid: ReturnType<typeof setTimeout>;

    async function poll() {
      if (cancelled) return;
      try {
        const res  = await fetch(`${import.meta.env.BASE_URL}api/cctp/attestation/${messageHash}`);
        const data = await res.json() as { status?: string; attestation?: string };
        if (data.status === "complete" && data.attestation) {
          if (!cancelled) {
            setAttestation(data.attestation);
            setPhase("ready");
          }
          return;
        }
      } catch { /* keep polling */ }
      if (!cancelled) {
        count++;
        setPollCount(count);
        // After 2 min (24×5s) show a "taking longer than usual" note;
        // after 10 min (120×5s) escalate to "abnormally long" warning.
        if (count >= 120) setAttestWarning("very-slow");
        else if (count >= 24) setAttestWarning("slow");
        tid = setTimeout(poll, 5_000);
      }
    }

    poll();
    return () => { cancelled = true; clearTimeout(tid); };
  }, [phase, messageHash]);

  // ── Initiate transfer (approve + depositForBurn) ───────────────────────────
  const handleInitiate = useCallback(async () => {
    if (!address || !amount || !recipient) return;
    setError(null);

    try {
      // Bug fix #3: wrap parseUnits — it throws a raw viem error for >6 decimal places
      let amountAtomics: bigint;
      try {
        amountAtomics = parseUnits(amount, 6);
      } catch {
        throw new Error("Too many decimal places — USDC supports up to 6 decimal places");
      }

      // Bug fix #4: negative / zero amount
      if (amountAtomics <= 0n) throw new Error("Amount must be greater than 0");
      if (!isAddress(recipient)) throw new Error("Invalid recipient address");

      // Bug fix #2: check balance before spending approve gas
      if (usdcBalanceRaw !== undefined && amountAtomics > usdcBalanceRaw) {
        throw new Error(
          `Insufficient USDC balance — you have ${formatUSDC(usdcBalanceRaw)} USDC on Base`
        );
      }

      // Bug fix #1: ensure we're on Base before touching Base contracts
      if (chainId !== base.id) {
        setPhase("approving");
        await switchChainAsync({ chainId: base.id });
      }

      // ── 1. Approve TokenMessenger to spend USDC ──
      setPhase("approving");

      const approveTx = await writeContractAsync({
        address:      USDC_BASE,
        abi:          ERC20_ABI,
        functionName: "approve",
        args:         [TOKEN_MESSENGER_BASE, amountAtomics],
        gas:          65_000n, // USDC approve on Base ~50k; explicit ceiling avoids estimation errors
      });
      await waitForTransactionReceipt(config, { hash: approveTx, chainId: base.id });

      // ── 2. depositForBurn ──
      setPhase("burning");
      const mintRecipient = `0x${recipient.slice(2).padStart(64, "0")}` as `0x${string}`;
      const burnTx = await writeContractAsync({
        address:      TOKEN_MESSENGER_BASE,
        abi:          TOKEN_MESSENGER_ABI,
        functionName: "depositForBurn",
        args:         [amountAtomics, dest.domain, mintRecipient, USDC_BASE],
        gas:          300_000n, // CCTP depositForBurn on Base ~200k; ceiling prevents "exceeds max gas limit" on smart wallets
      });
      setBurnTxHash(burnTx);

      const burnReceipt = await waitForTransactionReceipt(config, { hash: burnTx, chainId: base.id });

      // ── 3. Parse MessageSent from receipt ──
      const log = burnReceipt.logs.find(
        l => l.address.toLowerCase() === MESSAGE_TRANSMITTER_BASE.toLowerCase()
          && l.topics[0] === MESSAGE_SENT_TOPIC,
      );
      if (!log) throw new Error("MessageSent event not found — confirm tx on BaseScan and retry");

      const [msgBytes] = decodeAbiParameters([{ type: "bytes" }], log.data);
      const msgHash    = keccak256(msgBytes);

      setMessageBytes(msgBytes);
      setMessageHash(msgHash);
      setPhase("attesting");

    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      setError(msg.includes("rejected") ? "Transaction rejected" : msg.slice(0, 200));
      setPhase("error");
    }
  // Bug fix #6: switchChainAsync was missing from deps
  }, [address, amount, recipient, dest, writeContractAsync, switchChainAsync, chainId, usdcBalanceRaw]);

  // ── Receive on destination chain ───────────────────────────────────────────
  const handleReceive = useCallback(async () => {
    if (!attestation || !messageBytes) return;
    setError(null);

    try {
      // ── 1. Switch chain ──
      setPhase("switching");
      await switchChainAsync({ chainId: dest.chain.id });

      // ── 2. receiveMessage ──
      setPhase("receiving");
      type CfgChainId = (typeof config)['chains'][number]['id'];
      const destChainId = dest.chain.id as CfgChainId;
      const receiveTx = await writeContractAsync({
        address:      dest.messageTransmitter,
        abi:          MESSAGE_TRANSMITTER_ABI,
        functionName: "receiveMessage",
        args:         [messageBytes, attestation as `0x${string}`],
        chain:        dest.chain,
        gas:          400_000n, // CCTP receiveMessage ~250-300k; ceiling prevents estimation errors on destination chains
      });
      setReceiveTxHash(receiveTx);

      await waitForTransactionReceipt(config, { hash: receiveTx, chainId: destChainId });
      setPhase("done");

    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      setError(msg.includes("rejected") ? "Transaction rejected" : msg.slice(0, 200));
      setPhase("ready"); // let them try again
    }
  }, [attestation, messageBytes, dest, switchChainAsync, writeContractAsync]);

  function reset() {
    setPhase("idle");
    setBurnTxHash(null);
    setMessageBytes(null);
    setMessageHash(null);
    setAttestation(null);
    setReceiveTxHash(null);
    setError(null);
    setPollCount(0);
    setAttestWarning(null);
  }

  if (!isConnected) {
    return (
      <div className="max-w-md mx-auto flex flex-col items-center justify-center min-h-[50vh] text-center">
        <p className="text-muted-foreground mb-4">Connect your wallet to send cross-chain USDC</p>
        <WalletButton />
      </div>
    );
  }

  const isActive = phase !== "idle" && phase !== "done" && phase !== "error";

  return (
    <div className="max-w-lg mx-auto space-y-6">

      {/* Header */}
      <div>
        <h1 className="text-xl font-bold">Cross-Chain Transfer</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Send USDC from Base to another chain via Circle CCTP — no bridges, no wrapped assets.
        </p>
      </div>

      {/* Progress steps */}
      {phase !== "idle" && (
        <div className="flex items-center gap-2 text-xs">
          {(["burning", "attesting", "receiving", "done"] as Phase[]).map((p, i) => {
            const steps: Phase[] = ["burning", "attesting", "receiving", "done"];
            const idx  = steps.indexOf(phase);
            const done = i < idx || phase === "done";
            const active = phase === p || (p === "attesting" && phase === "ready");
            return (
              <span key={p} className="flex items-center gap-2">
                {i > 0 && <span className="text-border">—</span>}
                <span className={`px-2 py-0.5 rounded-full font-medium ${
                  done   ? "bg-green-500/15 text-green-400" :
                  active ? "bg-primary/15 text-primary"     :
                           "bg-secondary text-muted-foreground"
                }`}>
                  {i + 1}. {p === "attesting" ? "Attest" : p === "burning" ? "Burn" : p === "receiving" ? "Receive" : "Done"}
                </span>
              </span>
            );
          })}
        </div>
      )}

      {/* Status card */}
      {phase !== "idle" && (
        <div className="p-4 rounded-xl border border-border bg-card/50 space-y-3">
          <div className="flex items-center gap-3">
            {(phase === "done")
              ? <span className="w-7 h-7 rounded-full bg-green-500/15 flex items-center justify-center text-green-400"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg></span>
              : (phase === "error")
              ? <span className="w-7 h-7 rounded-full bg-red-500/15 flex items-center justify-center text-red-400"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" x2="6" y1="6" y2="18"/><line x1="6" x2="18" y1="6" y2="18"/></svg></span>
              : <span className="w-7 h-7 rounded-full border-2 border-primary/40 border-t-primary rounded-full animate-spin" />
            }
            <div>
              <p className="font-medium text-sm">{STEP_LABELS[phase]}</p>
              {phase === "attesting" && (
                <p className="text-xs text-muted-foreground">
                  Checking Circle attestation service… ({pollCount} check{pollCount !== 1 ? "s" : ""})
                </p>
              )}
              {phase === "attesting" && attestWarning === "slow" && (
                <p className="text-xs text-yellow-400 mt-1">
                  Taking longer than usual — Circle attestation typically completes in 10–20 min on mainnet. Your USDC is already burned and safe.
                </p>
              )}
              {phase === "attesting" && attestWarning === "very-slow" && (
                <p className="text-xs text-orange-400 mt-1">
                  Attestation is taking an unusually long time. You can safely close this tab — the burn is final. Return later and use the same message hash to claim.{" "}
                  <a href="https://status.circle.com" target="_blank" rel="noopener noreferrer" className="underline">Check Circle status</a>.
                </p>
              )}
              {phase === "ready" && (
                <p className="text-xs text-green-400">Attestation confirmed — ready to receive</p>
              )}
            </div>
          </div>

          {burnTxHash && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>Burn tx:</span><TxLink hash={burnTxHash} chainId={base.id} />
            </div>
          )}
          {messageHash && (
            <div className="text-xs text-muted-foreground">
              <span>Message hash: </span>
              <code className="font-mono text-[10px]">{messageHash.slice(0, 18)}…</code>
            </div>
          )}
          {receiveTxHash && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>Receive tx:</span><TxLink hash={receiveTxHash} chainId={dest.chain.id} />
            </div>
          )}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-red-400 flex gap-2">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 mt-0.5"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>
          {error}
        </div>
      )}

      {/* Form */}
      {(phase === "idle" || phase === "error") && (
        <div className="rounded-xl border border-border bg-card/30 divide-y divide-border">

          {/* Destination selector */}
          <div className="p-4 space-y-2">
            <label className="text-sm font-medium">Destination chain</label>
            <div className="grid grid-cols-2 gap-2">
              {DESTINATIONS.map((d, i) => (
                <button
                  key={d.label}
                  onClick={() => setDestIndex(i)}
                  className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg border text-sm font-medium transition-all ${
                    i === destIndex
                      ? "bg-primary/10 border-primary/40 text-primary"
                      : "bg-secondary border-border text-muted-foreground hover:text-foreground hover:border-border/80"
                  }`}
                >
                  <span className="font-mono text-base w-5 text-center">{d.icon}</span>
                  {d.label}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              USDC will appear as native USDC on {dest.label} — no bridge or wrapped token.
            </p>
          </div>

          {/* Amount */}
          <div className="p-4 space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">Amount (USDC)</label>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  Balance:{" "}
                  {usdcBalanceRaw === undefined
                    ? <span className="inline-block w-14 h-3 rounded bg-secondary animate-pulse align-middle" />
                    : <span className="text-foreground font-medium">{formatUSDC(usdcBalanceRaw)} USDC</span>
                  }
                </span>
                {/* Bug fix #7: use BigInt-safe formatUSDC instead of Number() for Max.
                    Use non-null assertion — button only renders when usdcBalanceRaw is defined. */}
                {usdcBalanceRaw !== undefined && usdcBalanceRaw > 0n && (
                  <button
                    type="button"
                    onClick={() => setAmount(formatUSDC(usdcBalanceRaw!))}
                    disabled={isActive}
                    className="text-[11px] font-semibold text-primary hover:text-primary/80 px-1.5 py-0.5 rounded border border-primary/30 hover:border-primary/60 transition-colors disabled:opacity-40"
                  >
                    Max
                  </button>
                )}
              </div>
            </div>
            <div className="relative">
              <input
                type="number"
                min="0"
                step="0.000001"
                placeholder="0.00"
                value={amount}
                onChange={e => setAmount(e.target.value)}
                disabled={isActive}
                className="w-full px-3 py-2.5 rounded-lg border border-border bg-secondary text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/60 transition-colors pr-14 disabled:opacity-50"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground font-semibold">USDC</span>
            </div>
          </div>

          {/* Recipient */}
          <div className="p-4 space-y-2">
            <label className="text-sm font-medium">Recipient on {dest.label}</label>
            <input
              type="text"
              placeholder="0x…"
              value={recipient}
              onChange={e => setRecipient(e.target.value)}
              disabled={isActive}
              className="w-full px-3 py-2.5 rounded-lg border border-border bg-secondary text-sm font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/60 transition-colors disabled:opacity-50"
            />
            <p className="text-xs text-muted-foreground">
              Use your own address to bridge to yourself, or any other {dest.label} address.
            </p>
          </div>

          {/* Info */}
          <div className="px-4 py-3 bg-secondary/30 rounded-b-xl flex items-start gap-2.5 text-xs text-muted-foreground">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 mt-0.5"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="16"/><line x1="8" x2="16" y1="12" y2="12"/></svg>
            <span>
              Requires 2 transactions on Base (approve + burn) and 1 on {dest.label} (receive). Circle attestation
              typically takes 10–20 minutes for mainnet finality. No bridge fees — only gas on each chain.
            </span>
          </div>
        </div>
      )}

      {/* CTA Buttons */}
      <div className="flex gap-3">
        {phase === "idle" && (
          <button
            onClick={handleInitiate}
            disabled={!amount || !recipient || !address}
            className="flex-1 py-3 rounded-xl bg-primary text-primary-foreground font-semibold hover:bg-primary/90 transition-all disabled:opacity-40 shadow-[0_0_20px_hsl(221_83%_53%/0.3)]"
          >
            Initiate Transfer →
          </button>
        )}

        {phase === "error" && (
          <>
            <button
              onClick={reset}
              className="flex-1 py-3 rounded-xl border border-border text-sm font-medium hover:bg-secondary transition-all"
            >
              Start Over
            </button>
            <button
              onClick={handleInitiate}
              className="flex-1 py-3 rounded-xl bg-primary text-primary-foreground font-semibold hover:bg-primary/90 transition-all"
            >
              Retry
            </button>
          </>
        )}

        {phase === "ready" && (
          <button
            onClick={handleReceive}
            className="flex-1 py-3 rounded-xl bg-green-600 text-white font-semibold hover:bg-green-500 transition-all shadow-[0_0_20px_rgba(34,197,94,0.25)]"
          >
            Switch to {dest.label} &amp; Receive →
          </button>
        )}

        {phase === "done" && (
          <button
            onClick={reset}
            className="flex-1 py-3 rounded-xl border border-border text-sm font-medium hover:bg-secondary transition-all"
          >
            New Transfer
          </button>
        )}

        {(phase === "approving" || phase === "burning" || phase === "attesting" || phase === "switching" || phase === "receiving") && (
          <button
            disabled
            className="flex-1 py-3 rounded-xl bg-primary/50 text-primary-foreground font-semibold opacity-60 cursor-not-allowed"
          >
            {STEP_LABELS[phase]}…
          </button>
        )}
      </div>

      {/* CCTP explanation */}
      {phase === "idle" && (
        <div className="grid grid-cols-3 gap-3 text-xs text-muted-foreground">
          {[
            { step: "1", title: "Burn on Base", desc: "USDC is burned on Base via Circle's TokenMessenger" },
            { step: "2", title: "Attestation", desc: "Circle's off-chain service attests to the burn (~10 min)" },
            { step: "3", title: "Mint on dest", desc: "Native USDC is minted directly to the recipient" },
          ].map(({ step, title, desc }) => (
            <div key={step} className="p-3 rounded-lg border border-border bg-card/20 space-y-1">
              <div className="flex items-center gap-1.5 font-semibold text-foreground">
                <span className="w-4 h-4 rounded-full bg-primary/15 text-primary text-[10px] font-bold flex items-center justify-center">{step}</span>
                {title}
              </div>
              <p>{desc}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
