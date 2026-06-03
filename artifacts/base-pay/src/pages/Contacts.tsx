import { useState } from "react";
import { useAccount } from "wagmi";
import { isAddress } from "viem";
import { useListContacts, useCreateContact, useDeleteContact, getListContactsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { truncateAddress } from "@/lib/wagmi";
import { WalletButton } from "@/components/Layout";
import { Link } from "wouter";

export default function ContactsPage() {
  const { address, isConnected } = useAccount();
  const [name, setName] = useState("");
  const [walletAddress, setWalletAddress] = useState("");
  const [ens, setEns] = useState("");
  const [showForm, setShowForm] = useState(false);
  const queryClient = useQueryClient();

  const { data: contacts, isLoading } = useListContacts(
    { ownerAddress: address },
    { query: { enabled: !!address, queryKey: getListContactsQueryKey({ ownerAddress: address }) } }
  );

  const { mutate: createContact, isPending: isCreating } = useCreateContact({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListContactsQueryKey({ ownerAddress: address }) });
        setName(""); setWalletAddress(""); setEns(""); setShowForm(false);
      },
    },
  });

  const { mutate: deleteContact } = useDeleteContact({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListContactsQueryKey({ ownerAddress: address }) });
      },
    },
  });

  function handleDeleteContact(id: number) {
    if (!address) return;
    deleteContact({ id, params: { ownerAddress: address } });
  }

  const isValidAddress = isAddress(walletAddress);
  const canAdd = name.trim() && isValidAddress && !isCreating;

  if (!isConnected) {
    return (
      <div className="max-w-md mx-auto flex flex-col items-center justify-center min-h-[50vh] text-center">
        <p className="text-muted-foreground mb-4">Connect your wallet to manage contacts</p>
        <WalletButton />
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Contacts</h1>
          <p className="text-sm text-muted-foreground">Your saved wallet addresses</p>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-all shadow-[0_0_16px_hsl(221_83%_53%/0.25)]"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" x2="12" y1="5" y2="19"/><line x1="5" x2="19" y1="12" y2="12"/></svg>
          Add Contact
        </button>
      </div>

      {/* Add form */}
      {showForm && (
        <div className="rounded-2xl border border-border bg-card p-5 space-y-4">
          <h2 className="text-sm font-semibold">New Contact</h2>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Name</label>
              <input
                type="text"
                placeholder="Alice"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-3 py-2.5 rounded-lg border border-border bg-secondary text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/40 focus:border-primary/40 transition-all"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">ENS <span className="text-muted-foreground/50">(optional)</span></label>
              <input
                type="text"
                placeholder="alice.eth"
                value={ens}
                onChange={(e) => setEns(e.target.value)}
                className="w-full px-3 py-2.5 rounded-lg border border-border bg-secondary text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/40 focus:border-primary/40 transition-all"
              />
            </div>
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Wallet Address</label>
            <input
              type="text"
              placeholder="0x..."
              value={walletAddress}
              onChange={(e) => setWalletAddress(e.target.value)}
              className={`w-full px-3 py-2.5 rounded-lg border bg-secondary text-sm font-mono placeholder:text-muted-foreground focus:outline-none focus:ring-1 transition-all ${
                walletAddress && !isValidAddress ? "border-destructive/60 focus:ring-destructive/40" : "border-border focus:ring-primary/40 focus:border-primary/40"
              }`}
            />
            {walletAddress && !isValidAddress && (
              <p className="text-xs text-destructive mt-1">Invalid address</p>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => {
                if (!canAdd || !address) return;
                createContact({ data: { name: name.trim(), walletAddress, ensName: ens || undefined, ownerAddress: address } });
              }}
              disabled={!canAdd}
              className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all ${canAdd ? "bg-primary text-primary-foreground hover:bg-primary/90" : "bg-secondary text-muted-foreground cursor-not-allowed"}`}
            >
              {isCreating ? "Saving..." : "Save Contact"}
            </button>
            <button onClick={() => setShowForm(false)} className="px-4 py-2 rounded-lg text-sm border border-border hover:bg-secondary transition-all">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Contacts list */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        {isLoading ? (
          <div className="divide-y divide-border">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="px-5 py-4 flex items-center gap-4">
                <div className="w-9 h-9 rounded-full shimmer shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3.5 w-24 rounded shimmer" />
                  <div className="h-3 w-36 rounded shimmer" />
                </div>
              </div>
            ))}
          </div>
        ) : contacts && contacts.length > 0 ? (
          <div className="divide-y divide-border">
            {contacts.map((c) => (
              <div key={c.id} className="px-5 py-4 flex items-center gap-4 hover:bg-secondary/20 transition-colors">
                <div className="w-9 h-9 rounded-full bg-primary/15 border border-primary/20 flex items-center justify-center shrink-0">
                  <span className="text-xs font-bold text-primary">{c.name[0]?.toUpperCase()}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold">{c.name}</p>
                  <p className="text-xs text-muted-foreground font-mono">{truncateAddress(c.walletAddress)}</p>
                  {c.ensName && <p className="text-xs text-primary">{c.ensName}</p>}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Link href={`/send?to=${c.walletAddress}`}>
                    <a className="text-xs px-2.5 py-1.5 rounded-md border border-primary/20 bg-primary/5 text-primary hover:bg-primary/10 transition-all">
                      Send
                    </a>
                  </Link>
                  <button
                    onClick={() => handleDeleteContact(c.id)}
                    className="text-xs px-2.5 py-1.5 rounded-md border border-destructive/20 bg-destructive/5 text-destructive hover:bg-destructive/10 transition-all"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="px-5 py-12 text-center text-muted-foreground text-sm">
            No contacts yet. Add wallet addresses you send to often.
          </div>
        )}
      </div>
    </div>
  );
}
