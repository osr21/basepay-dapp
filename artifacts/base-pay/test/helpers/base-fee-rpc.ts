import { custom, type Hex } from "viem";

// Synthetic Base JSON-RPC fixture, not a mock of any viem action. Keep selectors,
// addresses and ABI words independent of viem/op-stack's ABI so SDK contract
// changes fail these tests rather than silently updating both sides together.
export const GAS_PRICE_ORACLE = "0x420000000000000000000000000000000000000f";
export const L1_BLOCK = "0x4200000000000000000000000000000000000015";
export const SELECTORS = {
  l1: "0x49948e0e", // getL1Fee(bytes)
  scalar: "0x4d5d9a2a", // operatorFeeScalar()
  constant: "0x16d3bc7f", // operatorFeeConstant()
  allowance: "0xdd62ed3e", // allowance(address,address)
  balance: "0x70a08231", // balanceOf(address)
} as const;

export type RpcRequest = { method: string; params?: readonly unknown[] };
export type RpcTransaction = { from?: string; to?: string; data?: Hex; value?: Hex };
type Read = "gas" | "price" | "l1" | "scalar" | "constant" | "allowance" | "balance" | "eth";
type Failure = { fromCall?: number; kind?: "rpc" | "empty" | "malformed" };
type FixtureOptions = {
  scalar?: bigint;
  constant?: bigint;
  allowance?: bigint;
  eth?: bigint;
  failures?: Partial<Record<Read, Failure>>;
};
const quantity = (value: bigint): Hex => `0x${value.toString(16)}`;
const word = (value: bigint): Hex => `0x${value.toString(16).padStart(64, "0")}`;

export function baseFeeRpc(options: FixtureOptions = {}) {
  const requests: RpcRequest[] = [];
  const unexpected: RpcRequest[] = [];
  const counts: Partial<Record<Read, number>> = {};
  const reject = (request: RpcRequest): never => {
    unexpected.push(request);
    throw new Error(`Unexpected fixture RPC: ${JSON.stringify(request)}`);
  };
  const respond = (read: Read, result: Hex): Hex => {
    const count = counts[read] = (counts[read] ?? 0) + 1;
    const failure = options.failures?.[read];
    if (!failure || count < (failure.fromCall ?? 1)) return result;
    if (failure.kind === "empty") return "0x";
    if (failure.kind === "malformed") return "0x01"; // truncated uint ABI result
    // An EIP-1193 transport exposes JSON-RPC errors as rejected requests.
    throw Object.assign(new Error(`Fixture ${read} RPC unavailable`), { code: -32000 });
  };
  const provider = {
    async request(request: RpcRequest) {
      requests.push(request);
      const params = request.params ?? [];
      if (request.method === "eth_gasPrice" && params.length === 0) return respond("price", "0xa");
      if (request.method === "eth_getBalance" && params.length === 2 && params[1] === "latest") {
        return respond("eth", quantity(options.eth ?? 10n ** 18n));
      }
      const tx = params[0] as RpcTransaction | undefined;
      if (request.method === "eth_estimateGas" && params.length === 1 && tx?.to && tx.data) {
        return respond("gas", "0x186a0"); // 100,000 execution gas
      }
      if (request.method !== "eth_call" || params.length !== 2 || params[1] !== "latest") return reject(request);
      const to = tx?.to?.toLowerCase();
      const data = tx?.data;
      if (to === GAS_PRICE_ORACLE && data?.startsWith(SELECTORS.l1)) return respond("l1", word(200n));
      if (to === L1_BLOCK && data === SELECTORS.scalar) return respond("scalar", word(options.scalar ?? 2_000_000n));
      if (to === L1_BLOCK && data === SELECTORS.constant) return respond("constant", word(options.constant ?? 7n));
      if (data?.startsWith(SELECTORS.allowance)) return respond("allowance", word(options.allowance ?? 25_000000n));
      if (data?.startsWith(SELECTORS.balance)) return respond("balance", word(100_000000n));
      return reject(request);
    },
  };
  const transport = custom(provider, { retryCount: 0 });
  return { transport, request: provider.request, requests, unexpected, counts };
}

export type BaseFeeRpc = ReturnType<typeof baseFeeRpc>;
