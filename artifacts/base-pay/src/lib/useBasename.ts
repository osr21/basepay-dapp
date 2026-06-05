import { useQuery } from "@tanstack/react-query";
import { createPublicClient, http, type Address } from "viem";
import { base } from "viem/chains";

// Basenames L2 Reverse Registrar on Base Mainnet
// Source: github.com/base/basenames
const REVERSE_REGISTRAR = "0x79ea96012eea67a83431f1701b3dff7e37f9e282" as const;
const L2_RESOLVER      = "0xC6d566A56A1aFf6508b41f6c90ff131615583BCD" as const;

const REVERSE_REGISTRAR_ABI = [
  {
    name: "node",
    type: "function",
    stateMutability: "pure",
    inputs: [{ name: "addr", type: "address" }],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const;

const RESOLVER_ABI = [
  {
    name: "name",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "node", type: "bytes32" }],
    outputs: [{ name: "", type: "string" }],
  },
  {
    name: "addr",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "node", type: "bytes32" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

const AVATAR_RESOLVER_ABI = [
  {
    name: "text",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "node", type: "bytes32" }, { name: "key", type: "string" }],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

const publicClient = createPublicClient({ chain: base, transport: http() });

async function resolveBasename(address: Address): Promise<{ name: string | null; avatar: string | null }> {
  try {
    const node = await publicClient.readContract({
      address: REVERSE_REGISTRAR,
      abi: REVERSE_REGISTRAR_ABI,
      functionName: "node",
      args: [address],
    });

    const name = await publicClient.readContract({
      address: L2_RESOLVER,
      abi: RESOLVER_ABI,
      functionName: "name",
      args: [node],
    });

    if (!name) return { name: null, avatar: null };

    let avatar: string | null = null;
    try {
      const avatarRaw = await publicClient.readContract({
        address: L2_RESOLVER,
        abi: AVATAR_RESOLVER_ABI,
        functionName: "text",
        args: [node, "avatar"],
      });
      avatar = avatarRaw || null;
    } catch {
      // avatar is optional — swallow
    }

    return { name, avatar };
  } catch {
    return { name: null, avatar: null };
  }
}

export function useBasename(address: string | undefined) {
  const addr = address?.toLowerCase().startsWith("0x") && address.length === 42
    ? address as Address
    : undefined;

  return useQuery({
    queryKey: ["basename", addr],
    queryFn: () => resolveBasename(addr!),
    enabled: !!addr,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });
}
