import { useSignTypedData, useReadContract } from "wagmi";
import { parseSignature } from "viem";
import { USDC_ADDRESS, USDC_ABI } from "./wagmi";

const USDC_PERMIT_DOMAIN = {
  name: "USD Coin",
  version: "2",
  chainId: 8453,
  verifyingContract: USDC_ADDRESS,
} as const;

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
  v: number;
  r: `0x${string}`;
  s: `0x${string}`;
  deadline: bigint;
}

/**
 * Signs a USDC EIP-2612 permit — an off-chain typed message, NOT a transaction.
 * The wallet shows a "Sign" popup, not a "Send" popup, so Blockaid never scans it.
 *
 * @param deadlineSecs  How many seconds from now the permit is valid (default: 1 hour)
 */
export function useUsdcPermit(owner: `0x${string}` | undefined) {
  const { refetch } = useReadContract({
    address: USDC_ADDRESS,
    abi:     USDC_ABI,
    functionName: "nonces",
    args:    owner ? [owner] : undefined,
    query:   { enabled: !!owner },
  });

  const { signTypedDataAsync } = useSignTypedData();

  async function signPermit(
    spender:      `0x${string}`,
    value:        bigint,
    deadlineSecs  = 3_600,
  ): Promise<PermitSig> {
    if (!owner) throw new Error("Wallet not connected");

    const { data: freshNonce } = await refetch();
    if (freshNonce === undefined) throw new Error("Could not fetch USDC nonce");

    const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSecs);

    let sig: `0x${string}`;
    try {
      sig = await signTypedDataAsync({
        domain:      USDC_PERMIT_DOMAIN,
        types:       PERMIT_TYPES,
        primaryType: "Permit",
        message:     { owner, spender, value, nonce: freshNonce, deadline },
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
