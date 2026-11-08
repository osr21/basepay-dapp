import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { isAddress } from "viem";
import {
  useListStockflowPilotParticipants, getListStockflowPilotParticipantsQueryKey, getGetStockflowPilotSessionQueryKey,
  useSaveStockflowPilotParticipant,
} from "@workspace/api-client-react";
import type { StockflowPilotParticipant } from "@workspace/api-client-react";
import { truncateAddress } from "@/lib/wagmi";
import { Panel, Skeleton, Empty, ErrorBox, StatusTag, btnPrimary, btnGhost, btnDanger, field, when, errMsg } from "./atoms";

type Draft = { wallet: string; countryCode: string; days: string; approved: boolean; reviewConfirmed: boolean; existing: boolean };
const blank: Draft = { wallet: "", countryCode: "", days: "14", approved: true, reviewConfirmed: false, existing: false };
const normalizeCountryCode = (value: string) => {
  const code = value.trim().toUpperCase();
  return code === "UK" ? "GB" : code;
};

export function PilotAdmin() {
  const qc = useQueryClient();
  const list = useListStockflowPilotParticipants({ query: { queryKey: getListStockflowPilotParticipantsQueryKey(), refetchInterval: 30_000 } });
  const save = useSaveStockflowPilotParticipant();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const done = () => {
    void qc.invalidateQueries({ queryKey: getListStockflowPilotParticipantsQueryKey() });
    void qc.invalidateQueries({ queryKey: getGetStockflowPilotSessionQueryKey() });
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    const wallet = draft.wallet.trim(), cc = normalizeCountryCode(draft.countryCode), days = Number(draft.days);
    if (!isAddress(wallet)) return setFormError("Enter a valid 0x wallet address.");
    if (!/^[A-Z]{2}$/.test(cc)) return setFormError("Country must be a two-letter ISO code, e.g. GB (United Kingdom), DE, SG, JP. UK is also accepted.");
    if (!Number.isInteger(days) || days < 1 || days > 30) return setFormError("Grant length must be 1 to 30 whole days.");
    if (draft.approved && !draft.reviewConfirmed) return setFormError("Confirm the operator review before approving.");
    setFormError(null);
    save.mutate({ data: { wallet, countryCode: cc, days, approved: draft.approved, reviewConfirmed: draft.approved ? draft.reviewConfirmed : false } }, {
      onSuccess: () => { setDraft(null); done(); },
      onError: (err) => setFormError(errMsg(err)),
    });
  };

  const revoke = (p: StockflowPilotParticipant) => {
    setRevoking(p.wallet);
    save.mutate({ data: { wallet: p.wallet, countryCode: p.countryCode, days: 1, approved: false, reviewConfirmed: false } }, {
      onSettled: () => setRevoking(null),
      onSuccess: done,
      onError: (err) => setFormError(errMsg(err)),
    });
  };

  const edit = (p: StockflowPilotParticipant) => { setFormError(null); setDraft({ wallet: p.wallet, countryCode: p.countryCode, days: "14", approved: p.approved, reviewConfirmed: false, existing: true }); };

  return (
    <Panel kicker="Operator only" title="Pilot participants" delay={60}
      actions={!draft && <button className={btnPrimary} onClick={() => { setFormError(null); setDraft(blank); }} data-testid="button-new-participant">Add wallet</button>}>
      <p className="mb-4 text-xs leading-relaxed text-muted-foreground">Only wallet, declared country and grant window are stored. No names, emails or documents. A country declaration is not KYC, and approving a wallet for this operator-reviewed pilot is not legal or regulatory clearance.</p>
      {draft && (
        <form onSubmit={submit} className="sf-rise mb-5 space-y-3 rounded-xl border border-[hsl(var(--sf-ochre)/0.3)] bg-[hsl(var(--sf-ochre)/0.04)] p-4" noValidate>
          <div className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr]">
            <div className="min-w-0"><label htmlFor="pa-w" className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Wallet</label>
              <input id="pa-w" className={field} value={draft.wallet} disabled={draft.existing} onChange={(e) => setDraft({ ...draft, wallet: e.target.value })} placeholder="0x…" data-testid="input-participant-wallet" /></div>
            <div><label htmlFor="pa-c" className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Country (ISO)</label>
              <input id="pa-c" maxLength={2} aria-describedby="pa-country-help" className={`${field} uppercase`} value={draft.countryCode} onChange={(e) => { setFormError(null); setDraft({ ...draft, countryCode: e.target.value }); }} onBlur={() => setDraft({ ...draft, countryCode: normalizeCountryCode(draft.countryCode) })} placeholder="GB" data-testid="input-participant-country" /></div>
            <div><label htmlFor="pa-d" className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Days (1–30)</label>
              <input id="pa-d" inputMode="numeric" className={field} value={draft.days} onChange={(e) => setDraft({ ...draft, days: e.target.value })} data-testid="input-participant-days" /></div>
          </div>
          <p id="pa-country-help" className="text-xs text-muted-foreground">United Kingdom: GB. UK is accepted and saved as GB.</p>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.approved} onChange={(e) => setDraft({ ...draft, approved: e.target.checked, reviewConfirmed: false })} data-testid="checkbox-participant-approved" />Grant trading access</label>
          {draft.approved && (
            <label className="flex items-start gap-2 rounded-lg border border-border bg-background/40 p-3 text-xs text-secondary-foreground">
              <input type="checkbox" className="mt-0.5" checked={draft.reviewConfirmed} onChange={(e) => setDraft({ ...draft, reviewConfirmed: e.target.checked })} data-testid="checkbox-participant-review" />
              <span>I have completed this pilot's operator review of this wallet: participant eligibility, the stock issuer's transfer and holder restrictions, the declared jurisdiction's rules, and sanctions screening of the address. Selecting a country alone is not that review. This is still not KYC and not legal clearance.</span>
            </label>
          )}
          {formError && <ErrorBox message={formError} />}
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={btnPrimary} disabled={save.isPending || (draft.approved && !draft.reviewConfirmed)} data-testid="button-save-participant">{save.isPending ? "Saving…" : draft.approved ? "Approve" : "Save without access"}</button>
            <button type="button" className={btnGhost} onClick={() => setDraft(null)} data-testid="button-cancel-participant">Cancel</button>
          </div>
        </form>
      )}
      {!draft && formError && <div className="mb-3"><ErrorBox message={formError} /></div>}
      {list.isLoading ? <Skeleton rows={3} />
        : list.isError ? <ErrorBox message={`Participants unavailable: ${errMsg(list.error)}`} onRetry={() => list.refetch()} />
        : (list.data ?? []).length === 0 ? <Empty title="No participants" body="Nobody can trade until you review and approve a wallet. Nothing is ever approved automatically." />
        : (
          <ul className="divide-y divide-border">
            {(list.data ?? []).map((p) => {
              const expired = Date.parse(p.expiresAt) <= Date.now();
              return (
                <li key={p.wallet} className="flex flex-wrap items-center gap-3 py-3" data-testid={`row-participant-${p.wallet}`}>
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-sm" title={p.wallet}>{truncateAddress(p.wallet)} <span className="ml-1 text-muted-foreground">{p.countryCode}</span></p>
                    <p className="font-mono text-[10px] text-muted-foreground">until {when(p.expiresAt)} · by {truncateAddress(p.reviewedBy)} · {when(p.updatedAt)}</p>
                  </div>
                  <StatusTag status={!p.approved ? "revoked" : expired ? "expired" : "active"} />
                  <button className={btnGhost} onClick={() => edit(p)} data-testid={`button-edit-participant-${p.wallet}`}>Edit</button>
                  <button className={btnDanger} onClick={() => revoke(p)} disabled={!p.approved || revoking === p.wallet} data-testid={`button-revoke-participant-${p.wallet}`}>{revoking === p.wallet ? "Revoking…" : "Revoke"}</button>
                </li>
              );
            })}
          </ul>
        )}
    </Panel>
  );
}
