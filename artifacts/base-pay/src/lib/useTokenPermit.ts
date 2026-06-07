import { useSignTypedData, useReadContract } from "wagmi";
import { parseSignature } from "viem";
import { type GaslessToken } from "./wagmi";

const NONCES_ABI = [
  {
    type: "function",
    name: "nonces",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

const PERMIT_TYPES = {
  Permit: [
    { name: "owner",    type: "address" },
    { name: "spender",  type: "address" },
    { name: "value",    type: "uint256" },
    { name: "nonce",    type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export interface PermitSig {
  v:        number;
  r:        `0x${string}`;
  s:        `0x${string}`;
  deadline: bigint;
}

/**
 * Signs an EIP-2612 Permit for any Circle FiatToken V2.2 (USDC, EURC).
 * The spender gets an allowance without the owner submitting an on-chain tx.
 *
 * @param owner  Connected wallet address
 * @param token  Token config from GASLESS_TOKENS (supplies EIP-712 domain)
 */
export function useTokenPermit(
  owner: `0x${string}` | undefined,
  token: GaslessToken,
) {
  const { refetch } = useReadContract({
    address:      token.address,
    abi:          NONCES_ABI,
    functionName: "nonces",
    args:         owner ? [owner] : undefined,
    query:        { enabled: !!owner },
  });

  const { signTypedDataAsync } = useSignTypedData();

  async function signPermit(
    spender:      `0x${string}`,
    value:        bigint,
    deadlineSecs  = 3_600,
  ): Promise<PermitSig> {
    if (!owner) throw new Error("Wallet not connected");

    const { data: freshNonce } = await refetch();
    if (freshNonce === undefined) throw new Error(`Could not fetch ${token.symbol} nonce`);

    const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSecs);

    const domain = {
      name:              token.domainName,
      version:           token.domainVersion,
      chainId:           8453,
      verifyingContract: token.address,
    } as const;

    let sig: `0x${string}`;
    try {
      sig = await signTypedDataAsync({
        domain,
        types:       PERMIT_TYPES,
        primaryType: "Permit",
        message:     { owner, spender, value, nonce: freshNonce as bigint, deadline },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/chainId.*must match|must match.*chainId/i.test(msg)) {
        throw new Error("Wrong network — please switch your wallet to Base Mainnet and try again.");
      }
      throw err;
    }

    const { v, r, s } = parseSignature(sig);
    return { v: Number(v), r: r as `0x${string}`, s: s as `0x${string}`, deadline };
  }

  return { signPermit };
}
