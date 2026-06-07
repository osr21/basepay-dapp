import { useSignTypedData } from "wagmi";
import { parseSignature } from "viem";
import { type GaslessToken } from "./wagmi";

const TRANSFER_TYPES = {
  TransferWithAuthorization: [
    { name: "from",        type: "address" },
    { name: "to",          type: "address" },
    { name: "value",       type: "uint256" },
    { name: "validAfter",  type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce",       type: "bytes32" },
  ],
} as const;

export interface AuthorizationSig {
  v:           number;
  r:           `0x${string}`;
  s:           `0x${string}`;
  nonce:       `0x${string}`;
  validAfter:  bigint;
  validBefore: bigint;
}

function randomBytes32(): `0x${string}` {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return ("0x" + Array.from(arr, b => b.toString(16).padStart(2, "0")).join("")) as `0x${string}`;
}

/**
 * Signs an EIP-3009 TransferWithAuthorization for any Circle FiatToken V2.2
 * (USDC, EURC, etc.). The relayer submits the tx; user pays zero gas.
 *
 * @param token        Token config from GASLESS_TOKENS (supplies EIP-712 domain)
 * @param validForSecs How long the authorization stays valid (default: 30 minutes)
 */
export function useUsdcAuthorization(
  owner: `0x${string}` | undefined,
  token: GaslessToken,
) {
  const { signTypedDataAsync } = useSignTypedData();

  async function signAuthorization(
    to:           `0x${string}`,
    value:        bigint,
    validForSecs  = 1_800,
  ): Promise<AuthorizationSig> {
    if (!owner) throw new Error("Wallet not connected");

    const nonce       = randomBytes32();
    const now         = BigInt(Math.floor(Date.now() / 1000));
    const validAfter  = 0n;
    const validBefore = now + BigInt(validForSecs);

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
        types:       TRANSFER_TYPES,
        primaryType: "TransferWithAuthorization",
        message:     {
          from:        owner,
          to,
          value,
          validAfter,
          validBefore,
          nonce,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/chainId.*must match|must match.*chainId/i.test(msg)) {
        throw new Error("Wrong network — please switch your wallet to Base Mainnet and try again.");
      }
      throw err;
    }

    let parsed: ReturnType<typeof parseSignature>;
    try {
      parsed = parseSignature(sig);
    } catch {
      throw new Error(
        "Your wallet returned an incompatible signature format. " +
        "EIP-3009 gasless transfers require a standard secp256k1 (EOA) signature.",
      );
    }

    const { v, r, s } = parsed;
    return {
      v: Number(v),
      r: r as `0x${string}`,
      s: s as `0x${string}`,
      nonce,
      validAfter,
      validBefore,
    };
  }

  return { signAuthorization };
}
