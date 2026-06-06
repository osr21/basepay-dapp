import { useQuery } from "@tanstack/react-query";
import { getAttestations } from "@coinbase/onchainkit/identity";
import { base } from "viem/chains";

export const EAS_ADDRESS            = "0x4200000000000000000000000000000000000021" as const;
export const EAS_SCHEMA_REGISTRY    = "0x4200000000000000000000000000000000000020" as const;
export const COINBASE_ATTESTER      = "0x357458739F90461b99789350868CD7CF330Dd7EE" as const;
export const COINBASE_INDEXER       = "0x2c7eE1E5f416dfF40054c27A62f7B357C4E8619C" as const;

// EASSchemaUid = `0x${string}` — Base Mainnet Coinbase schema UIDs
export const VERIFIED_ACCOUNT_SCHEMA_UID =
  "0xf8b05c79f090979bf4a80270aba232dff11a10d9ca55c4f88de95317970f0de9" as `0x${string}`;
export const VERIFIED_COINBASE_ONE_SCHEMA_UID =
  "0x254bd1b63e0591fefa66818ca054c78627306f253f86be6023725a67ee6bf9f4" as `0x${string}`;
export const VERIFIED_COUNTRY_SCHEMA_UID =
  "0x1801901fabd0e6189356b4fb52bb0ab855276d84f7ec140839fbd1f6801ca065" as `0x${string}`;

export interface CoinbaseAttestation {
  isVerified: boolean;
  isCoinbaseOne: boolean;
}

export function useCoinbaseAttestation(address: `0x${string}` | undefined) {
  const query = useQuery({
    queryKey: ["coinbase-attestation", address],
    queryFn: async (): Promise<CoinbaseAttestation> => {
      if (!address) return { isVerified: false, isCoinbaseOne: false };

      const [verified, coinbaseOne] = await Promise.all([
        getAttestations(address, base, {
          schemas: [VERIFIED_ACCOUNT_SCHEMA_UID],
        }).catch(() => [] as Awaited<ReturnType<typeof getAttestations>>),
        getAttestations(address, base, {
          schemas: [VERIFIED_COINBASE_ONE_SCHEMA_UID],
        }).catch(() => [] as Awaited<ReturnType<typeof getAttestations>>),
      ]);

      return {
        isVerified: verified.length > 0,
        isCoinbaseOne: coinbaseOne.length > 0,
      };
    },
    enabled: !!address,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });

  return { data: query.data ?? null, isLoading: query.isLoading };
}
