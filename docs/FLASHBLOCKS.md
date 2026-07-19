# Flashblocks Pre-Confirmation

  > Added: July 2026 · Route: `/gasless` · Files: `useFlashblocksConfirm.ts`, `GaslessTransfer.tsx`

  ## What is Flashblocks?

  Base produces blocks every 2 seconds. **Flashblocks** sub-divides each block into ten 200 ms "flashblocks" streamed continuously from the sequencer. A transaction that lands in a flashblock is **ordering-committed** — it will be in the final block with overwhelming certainty, typically within 200 ms of mempool inclusion.

  BasePay uses Flashblocks to surface a real-time "⚡ Pre-confirmed in Xms" badge to users immediately after a gasless transfer is relayed, before the 2-second block boundary.

  ---

  ## User Flow

  ```
  User signs EIP-3009 message
           │
           ▼
  RelayTransfer POST → API relays tx on-chain
           │
           ▼  step = "confirming"
  useFlashblocksConfirm polls eth_getTransactionReceipt every 200ms
           │
           ├── receipt returned (~200ms) → status = "preconfirmed"
           │   show "⚡ Pre-confirmed in Xms" badge → wait 800ms → step = "done"
           │
           └── no receipt after 3.5s → step = "done" (fallback)
  ```

  ---

  ## Implementation

  ### `useFlashblocksConfirm.ts`

  A zero-dependency React hook that polls `eth_getTransactionReceipt` on the Base Mainnet public client.

  ```typescript
  import { useFlashblocksConfirm } from "@/lib/useFlashblocksConfirm";

  const { status, preconfirmedAt } = useFlashblocksConfirm(txHash);
  // status: "idle" | "watching" | "preconfirmed" | "confirmed"
  // preconfirmedAt: elapsed ms from poll start to first receipt
  ```

  **How it works:**

  | Phase | Timing | Detail |
  |---|---|---|
  | Head-start delay | 100ms | Lets the relayer broadcast before the first poll |
  | Pre-confirmation poll | every 200ms | `getTransactionReceipt` on Base mainnet |
  | Pre-confirmation detected | ~200ms after relay | First non-null receipt = Flashblocks pre-confirmed |
  | Poll after detection | every 500ms | Slower polling until block is finalised |
  | Confirmed | 2500ms after polling start | tx is in a settled block |

  **Key design decisions:**
  - Uses `publicClient.getTransactionReceipt` (viem) — no WebSocket subscription required. Works with Base's public RPC (`https://mainnet.base.org`) out of the box.
  - Errors (receipt not found / RPC issue) are silently caught; polling continues.
  - Cleanup is fully React-lifecycle-safe: cancels the timer when the component unmounts or txHash changes.

  ```typescript
  export function useFlashblocksConfirm(txHash: Hash | undefined) {
    const [status,         setStatus]         = useState<FlashblocksStatus>("idle");
    const [preconfirmedAt, setPreconfirmedAt] = useState<number | undefined>();
    const publicClient = usePublicClient({ chainId: base.id });
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
      if (!txHash || !publicClient) { setStatus("idle"); return; }

      setStatus("watching");
      let cancelled = false, seenFirst = false;
      const startMs = Date.now();

      async function poll() {
        if (cancelled) return;
        try {
          const receipt = await publicClient.getTransactionReceipt({ hash: txHash! });
          if (receipt && !cancelled) {
            if (!seenFirst) {
              seenFirst = true;
              setPreconfirmedAt(Date.now() - startMs);
              setStatus("preconfirmed");
            }
            if (Date.now() - startMs >= 2500) { setStatus("confirmed"); return; }
          }
        } catch { /* not yet available */ }
        if (!cancelled) timerRef.current = setTimeout(poll, seenFirst ? 500 : 200);
      }

      timerRef.current = setTimeout(poll, 100);
      return () => { cancelled = true; if (timerRef.current) clearTimeout(timerRef.current); };
    }, [txHash, publicClient]);

    return { status, preconfirmedAt };
  }
  ```

  ### Integration in `GaslessTransfer.tsx`

  ```typescript
  const { status: fbStatus, preconfirmedAt } = useFlashblocksConfirm(
    step === "confirming" ? (txHash as `0x${string}` | undefined) : undefined,
  );

  // Auto-advance: pre-confirmed → show badge 800ms → done. Fallback: 3.5s timeout.
  useEffect(() => {
    if (step !== "confirming") return;
    if (fbStatus === "preconfirmed" || fbStatus === "confirmed") {
      const t = setTimeout(() => setStep("done"), 800);
      return () => clearTimeout(t);
    }
    const fallback = setTimeout(() => setStep("done"), 3500);
    return () => clearTimeout(fallback);
  }, [step, fbStatus]);
  ```

  ---

  ## Network Compatibility

  | RPC Endpoint | Flashblocks support |
  |---|---|
  | `https://mainnet.base.org` (public) | ✅ Yes — Base-Reth node |
  | Alchemy / QuickNode / Chainstack premium | ✅ Yes — Flashblocks-aware nodes |
  | Third-party RPC (non-flashblocks) | ❌ No — receipt returns null until full block |

  > **Note:** If the RPC is not Flashblocks-aware, `eth_getTransactionReceipt` returns null until the 2-second block commits. The 3.5s fallback ensures the UI still advances correctly.

  ---

  ## Related GitHub Issues

  These open bugs in `base/base` can cause intermittent null receipts during polling (BasePay handles both gracefully via its fallback):

  - [base/base#3796](https://github.com/base/base/issues/3796) — `build_pending_state` panics on empty flashblocks vec → null receipts
  - [base/base#3924](https://github.com/base/base/issues/3924) — `flashblocks_per_block` divide-by-zero → RPC instability
  - [base/base#3300](https://github.com/base/base/issues/3300) — feature request: pluggable Flashblocks subscriber (would allow event-driven pre-confirmation instead of polling)

  BasePay commented on all three with integration feedback: see the [GitHub Research Report](https://github.com/osr21/basepay-dapp/discussions).

  ---

  ## References

  - [Base Flashblocks Docs](https://docs.base.org/base-chain/flashblocks/docs)
  - [base/base-flashblocks-demo](https://github.com/base/base-flashblocks-demo)
  - [base/flashblocks-websocket-proxy](https://github.com/base/flashblocks-websocket-proxy)
  - [Chainstack Flashblocks Guide](https://docs.chainstack.com/docs/flashblocks-on-base)
  