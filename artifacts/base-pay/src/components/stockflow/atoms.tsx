import { useState } from "react";
import type { StockflowStock } from "@workspace/api-client-react";
import type { PriceStatus } from "@/lib/stockflow-logic";

export const usd = (n: number) => n.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const when = (t: number | string) => new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
export const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Request failed");

/* ───────────── shared atoms ───────────── */
export function Panel({ title, kicker, actions, children, className = "", delay = 0 }: { title: string; kicker?: string; actions?: React.ReactNode; children: React.ReactNode; className?: string; delay?: number }) {
  return (
    <section className={`sf-rise min-w-0 rounded-2xl border border-[hsl(var(--sf-ochre)/0.14)] bg-card/60 backdrop-blur-sm ${className}`} style={{ animationDelay: `${delay}ms` }}>
      <header className="flex flex-wrap items-end justify-between gap-3 px-5 pt-5 pb-3">
        <div>
          {kicker && <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-[hsl(var(--sf-ochre))]">{kicker}</p>}
          <h2 className="sf-display text-xl text-foreground">{title}</h2>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
      <div className="sf-rule mx-5" />
      <div className="p-5">{children}</div>
    </section>
  );
}

export const btn = "inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--sf-ochre))] disabled:opacity-40 disabled:cursor-not-allowed";
export const btnPrimary = `${btn} bg-[hsl(var(--sf-ochre))] text-[hsl(var(--sf-ink))] hover:bg-[hsl(var(--sf-ochre)/0.85)]`;
export const btnGhost = `${btn} border border-border text-secondary-foreground hover:border-[hsl(var(--sf-ochre)/0.5)] hover:text-foreground`;
export const btnDanger = `${btn} border border-[hsl(var(--sf-clay)/0.4)] text-[hsl(var(--sf-clay))] hover:bg-[hsl(var(--sf-clay)/0.1)]`;
export const field = "w-full rounded-lg border border-border bg-background/60 px-3 py-2 text-sm font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-[hsl(var(--sf-ochre)/0.6)] focus:ring-1 focus:ring-[hsl(var(--sf-ochre)/0.4)]";

export function StatusTag({ status }: { status: PriceStatus | "paused" | "active" | "revoked" | "expired" }) {
  const map: Record<string, string> = {
    fresh: "text-[hsl(var(--sf-verdigris))] border-[hsl(var(--sf-verdigris)/0.35)] bg-[hsl(var(--sf-verdigris)/0.08)]",
    active: "text-[hsl(var(--sf-verdigris))] border-[hsl(var(--sf-verdigris)/0.35)] bg-[hsl(var(--sf-verdigris)/0.08)]",
    stale: "text-[hsl(var(--sf-ochre))] border-[hsl(var(--sf-ochre)/0.35)] bg-[hsl(var(--sf-ochre)/0.08)]",
    expired: "text-[hsl(var(--sf-ochre))] border-[hsl(var(--sf-ochre)/0.35)] bg-[hsl(var(--sf-ochre)/0.08)]",
    unavailable: "text-muted-foreground border-border bg-secondary/50",
    revoked: "text-[hsl(var(--sf-clay))] border-[hsl(var(--sf-clay)/0.35)] bg-[hsl(var(--sf-clay)/0.08)]",
    paused: "text-[hsl(var(--sf-clay))] border-[hsl(var(--sf-clay)/0.35)] bg-[hsl(var(--sf-clay)/0.08)]",
  };
  const label: Record<string, string> = { fresh: "NAV <24h", stale: "Stale NAV", unavailable: "No NAV", paused: "Paused", active: "Active", revoked: "Revoked", expired: "Expired" };
  return <span data-testid={`status-${status}`} className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${map[status]}`}>{label[status]}</span>;
}

export function Skeleton({ rows = 4 }: { rows?: number }) {
  return <div className="space-y-2" aria-busy="true" aria-label="Loading">{Array.from({ length: rows }).map((_, i) => <div key={i} className="shimmer h-12 rounded-lg" />)}</div>;
}

export function Empty({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="sf-grid rounded-xl border border-dashed border-[hsl(var(--sf-ochre)/0.2)] px-6 py-10 text-center">
      <p className="sf-display text-lg text-foreground">{title}</p>
      <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">{body}</p>
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[hsl(var(--sf-clay)/0.35)] bg-[hsl(var(--sf-clay)/0.07)] px-4 py-3 text-sm text-[hsl(var(--sf-clay))]">
      <span>{message}</span>
      {onRetry && <button onClick={onRetry} className={btnDanger} data-testid="button-retry">Retry</button>}
    </div>
  );
}

export function StockGlyph({ stock }: { stock: Pick<StockflowStock, "symbol" | "iconUrl"> }) {
  const [broken, setBroken] = useState(false);
  if (stock.iconUrl && !broken) return <img src={stock.iconUrl} alt="" onError={() => setBroken(true)} className="h-8 w-8 shrink-0 rounded-full bg-secondary object-cover" />;
  return <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[hsl(var(--sf-ochre)/0.3)] font-mono text-[10px] text-[hsl(var(--sf-ochre))]">{stock.symbol.slice(0, 3)}</span>;
}

export function RefreshIcon({ spinning }: { spinning?: boolean }) {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={spinning ? "animate-spin" : ""}><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>;
}
