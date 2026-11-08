import { formatEther } from "viem";
import { deserializeFee, type StoredTransactionFee, type TransactionFee } from "@workspace/base-fees";

const cost = (wei: bigint | null | undefined) => wei == null ? "Unavailable" : `${formatEther(wei)} ETH`;
export function PaidNetworkFees({ reviewed, actual, pending = false }: {
  reviewed?: TransactionFee | null;
  actual?: TransactionFee | null;
  pending?: boolean;
}) {
  return (
    <section className="w-full space-y-1 rounded-lg bg-muted/20 p-2 font-mono text-[10px]" aria-label="Reviewed versus paid network fees">
      <p>Reviewed network estimate: {reviewed?.totalWei == null ? "Unavailable / not recorded" : `~${cost(reviewed.totalWei)}`}</p>
      <p className="font-semibold">Actual network fee paid: {actual ? cost(actual.totalWei) : pending ? "Unavailable — awaiting receipt" : "Unavailable"}</p>
      {actual && <dl className="grid gap-1 sm:grid-cols-3">
        {([["L2 execution", actual.execution], ["L1 data", actual.l1Data], ["Operator", actual.operator]] as const).map(([label, fee]) => (
          <div key={label} className="min-w-0"><dt className="text-muted-foreground">{label}</dt><dd className="break-words" title={fee.status === "unavailable" ? fee.message : undefined}>{fee.status === "available" ? cost(fee.wei) : "Unavailable"}</dd></div>
        ))}
      </dl>}
      {actual?.totalWei === null && <p className="text-muted-foreground">Full actual fee unavailable; missing components are not zero.</p>}
    </section>
  );
}

export function HistoricalNetworkFees({ reviewed, actual, nonSwap = false }: { reviewed?: StoredTransactionFee | null; actual?: StoredTransactionFee | null; nonSwap?: boolean }) {
  return (
    <div className="w-full">
      <p className="mt-1 font-mono text-[10px] text-muted-foreground">{nonSwap ? "Replacement transaction costs — not a completed swap" : "Swap network costs only"} · approval/reset costs excluded</p>
      <PaidNetworkFees reviewed={deserializeFee(reviewed)} actual={deserializeFee(actual)} />
      <p className="font-mono text-[10px] text-muted-foreground">Reviewed estimate is client-reported{nonSwap ? " for the original swap" : ""}; paid fees are receipt-derived. Pool fee: included in output, not a network fee. BasePay service fee: 0.</p>
    </div>
  );
}
