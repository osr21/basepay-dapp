import { formatEther } from "viem";
import type { FeeComponent, NetworkFeeState, TransactionFee } from "@/lib/stockflow-network-fees";
import { btnGhost } from "./atoms";

const eth = (wei: bigint) => `${formatEther(wei)} ETH`;
function ComponentCost({ label, fee }: { label: string; fee: FeeComponent }) {
  return <div className="min-w-0"><dt className="text-muted-foreground">{label}</dt><dd className="break-words">{fee.status === "available" ? eth(fee.wei) : `Unavailable: ${fee.message}`}</dd></div>;
}
function TransactionCost({ label, fee }: { label: string; fee: TransactionFee | null }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="font-semibold">{label}: {fee ? fee.totalWei === null ? "Full cost unavailable" : `~${eth(fee.totalWei)}` : "Not required · 0 ETH"}</p>
      {fee && <dl className="mt-2 grid gap-2 sm:grid-cols-3">
        <ComponentCost label="L2 execution" fee={fee.execution} />
        <ComponentCost label="L1 data" fee={fee.l1Data} />
        <ComponentCost label="Operator" fee={fee.operator} />
      </dl>}
    </div>
  );
}

/** Shared by the pre-approval ticket and the final swap review. Never renders a
 * partial subtotal as a full network fee, or rounds tiny positive fees to zero. */
export function NetworkFees({ state, refresh, disabled }: { state: NetworkFeeState; refresh: () => void; disabled?: boolean }) {
  return (
    <section className="space-y-2 font-mono text-[11px]" aria-label="Base network fee estimate" aria-live="polite" data-testid="text-gas-estimate">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold">Base network fee estimate</h3>
        <button type="button" className={btnGhost} disabled={disabled || state.status === "loading"} onClick={refresh}>Refresh fees</button>
      </div>
      {state.status === "idle" ? <p>Not estimated.</p>
        : state.status === "loading" ? <p>Estimating full Base network fees…</p>
        : state.status === "error" ? <p className="text-[hsl(var(--sf-clay))]">Full network cost unavailable: {state.message}</p>
        : <>
          <TransactionCost label="Allowance reset" fee={state.estimate.reset} />
          <TransactionCost label="Exact approval" fee={state.estimate.approval} />
          <TransactionCost label="Swap" fee={state.estimate.swap} />
          <p data-testid="text-network-total">Total remaining network cost: {state.estimate.totalWei === null ? "Unavailable — one or more required components could not be estimated." : `~${eth(state.estimate.totalWei)}`}</p>
          <p>ETH balance for this estimate: {eth(state.estimate.eth)}</p>
          {state.estimate.funding === "insufficient" ? <p role="alert" className="text-[hsl(var(--sf-clay))]" data-testid="text-insufficient-network-eth">Insufficient ETH for the estimated network fees. Add Base ETH before signing.</p>
            : state.estimate.funding === "unknown" ? <p>ETH sufficiency unknown until all required costs are available.</p>
            : <p>ETH covers this estimate, not a guaranteed maximum.</p>}
          {state.estimate.approval && <p>Swap execution may be unavailable until approval is confirmed. An approval that needs a reset may also be unavailable until that reset confirms. No transaction is sent to estimate fees.</p>}
        </>}
      <p className="text-muted-foreground">Network fees are paid separately in ETH: L2 execution + L1 data + applicable operator fee. Estimates refresh every 15 seconds and after allowance changes. Actual fees and wallet gas limits may differ; already-paid transactions are excluded.</p>
      <p className="text-muted-foreground">Pool fee: included in the quoted output, not added again here. BasePay service fee: 0.</p>
    </section>
  );
}
