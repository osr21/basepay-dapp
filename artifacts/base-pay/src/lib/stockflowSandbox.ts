import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount, useChainId, useSwitchChain, useWalletClient } from "wagmi";
import { createPublicClient, http, formatUnits, parseUnits, isAddress, type Abi, type Address, type Hash } from "viem";
import { baseSepolia } from "viem/chains";
import artifact from "./stockflow-sandbox.json";

const client = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });
const abi = artifact.abi as Abi;
const key = (address: string) => `basepay-stockflow-sandbox:84532:${address.toLowerCase()}`;
export type SandboxState = {
  balance: string; position: string; spent: string; maxPerTrade: string;
  dailyLimit: string; expiresAt: number; active: boolean;
};
function decimal(value: string) {
  if (!/^\d+(\.\d{1,6})?$/.test(value.trim())) throw new Error("Enter an amount with at most six decimals.");
  const amount = parseUnits(value.trim(), 6);
  if (amount <= 0n) throw new Error("Amount must be greater than zero.");
  return amount;
}

export function useStockflowSandbox() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { data: wallet } = useWalletClient();
  const { switchChainAsync } = useSwitchChain();
  const [contractAddress, setContractAddress] = useState<Address | null>(null);
  const [state, setState] = useState<SandboxState | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<Hash | null>(null);
  const identity = address?.toLowerCase();
  const current = useRef(identity);
  current.current = identity;
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setState(null); setLastTx(null); setError(null); setPending(false);
    try {
      const saved = address ? localStorage.getItem(key(address)) : null;
      if (saved && !isAddress(saved)) throw new Error("Stored sandbox address is invalid.");
      setContractAddress(saved as Address | null);
    } catch (e) {
      setContractAddress(null);
      setError(e instanceof Error ? e.message : "Browser storage unavailable.");
    }
  }, [address]);

  const read = useCallback(async (target: Address, owner: string) => {
    const [data, actualOwner] = await Promise.all([
      client.readContract({ address: target, abi, functionName: "getState" }),
      client.readContract({ address: target, abi, functionName: "owner" }),
    ]);
    if (String(actualOwner).toLowerCase() !== owner) throw new Error("Sandbox does not belong to the connected wallet.");
    const values = data as readonly [bigint, bigint, bigint, bigint, bigint, bigint, boolean];
    if (current.current === owner) setState({
      balance: formatUnits(values[0], 6), position: formatUnits(values[1], 18),
      spent: formatUnits(values[2], 6), maxPerTrade: formatUnits(values[3], 6),
      dailyLimit: formatUnits(values[4], 6), expiresAt: Number(values[5]), active: values[6],
    });
  }, []);
  const run = useCallback(async (action: () => Promise<void>) => {
    const token = generation.current;
    setPending(true); setError(null);
    try { await action(); }
    catch (e) {
      if (token === generation.current) {
        const message = e instanceof Error ? e.message : "Transaction failed.";
        setError(message.length > 700 ? message.slice(0, 700) : message);
      }
    } finally { if (token === generation.current) setPending(false); }
  }, []);
  const refresh = useCallback(() => run(async () => {
    if (contractAddress && identity) await read(contractAddress, identity);
  }), [contractAddress, identity, read, run]);
  useEffect(() => {
    if (contractAddress && identity) void refresh();
  }, [contractAddress, identity, refresh]);

  function connected() {
    if (!wallet || !address) throw new Error("Connect a wallet first.");
    if (chainId !== baseSepolia.id || wallet.chain.id !== baseSepolia.id) throw new Error("Switch your wallet to Base Sepolia first.");
    return wallet;
  }
  async function confirm(hash: Hash, owner: string) {
    if (current.current === owner) setLastTx(hash);
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("Transaction reverted. No sandbox action was completed.");
    return receipt;
  }
  const deploy = () => run(async () => {
    const w = connected(); const owner = address!.toLowerCase();
    const hash = await w.deployContract({ abi, bytecode: artifact.bytecode as `0x${string}`, account: w.account, chain: baseSepolia });
    const receipt = await confirm(hash, owner);
    if (!receipt.contractAddress) throw new Error("Deployment receipt has no contract address.");
    // Persist against the originating account even if the wallet switches mid-confirmation.
    localStorage.setItem(key(owner), receipt.contractAddress);
    if (current.current === owner) setContractAddress(receipt.contractAddress);
    await read(receipt.contractAddress, owner);
  });
  const write = (functionName: string, args: readonly unknown[]) => run(async () => {
    const w = connected(); const owner = address!.toLowerCase();
    if (!contractAddress) throw new Error("Deploy your testnet sandbox first.");
    const { request } = await client.simulateContract({
      account: w.account, address: contractAddress, abi, functionName, args,
    });
    const hash = await w.writeContract({ ...request, chain: baseSepolia, account: w.account });
    await confirm(hash, owner);
    await read(contractAddress, owner);
  });
  const savePolicy = (max: string, daily: string, days: number) => run(async () => {
    const w = connected(); const owner = address!.toLowerCase();
    const maxAmount = decimal(max), dailyAmount = decimal(daily);
    if (maxAmount > dailyAmount || dailyAmount > 1000_000000n) throw new Error("Per-trade limit must not exceed daily limit; daily limit cannot exceed 1,000 demo USD.");
    if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error("Expiry must be between 1 and 30 days.");
    if (!contractAddress) throw new Error("Deploy your testnet sandbox first.");
    const block = await client.getBlock();
    const args = [maxAmount, dailyAmount, block.timestamp + BigInt(days * 86400)];
    const { request } = await client.simulateContract({ account: w.account, address: contractAddress, abi, functionName: "setPolicy", args });
    const hash = await w.writeContract({ ...request, chain: baseSepolia, account: w.account });
    await confirm(hash, owner); await read(contractAddress, owner);
  });
  const buy = (amount: string) => run(async () => {
    const w = connected(); const owner = address!.toLowerCase();
    if (!contractAddress) throw new Error("Deploy your testnet sandbox first.");
    const value = decimal(amount);
    const block = await client.getBlock();
    const { request } = await client.simulateContract({
      address: contractAddress, abi, functionName: "buy", account: w.account,
      args: [value, value * 10n ** 18n / 100_000000n, block.timestamp + 300n],
    });
    const hash = await w.writeContract({ ...request, chain: baseSepolia, account: w.account });
    await confirm(hash, owner); await read(contractAddress, owner);
  });
  return {
    address, chainId, isConnected, contractAddress, pending, error, lastTx, state,
    deploy, refresh, savePolicy, buy, revoke: () => write("revoke", []),
    switchToTestnet: () => run(async () => { await switchChainAsync({ chainId: baseSepolia.id }); }),
  };
}
