import { concat, encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { STOCKFLOW_ROUTER, stockflowErc20Abi, stockflowSwapAbi, type validatedTradeParams } from "./stockflow-trade-contract";
import { totalFee, type FeeComponent, type TransactionFee } from "@workspace/base-fees";
export { totalFee, readActualTransactionFee, serializeFee, deserializeFee } from "@workspace/base-fees";
export type { FeeComponent, TransactionFee } from "@workspace/base-fees";

export type TradeNetworkFees = {
  allowance: bigint;
  eth: bigint;
  reset: TransactionFee | null;
  approval: TransactionFee | null;
  swap: TransactionFee;
  totalWei: bigint | null;
  funding: "sufficient" | "insufficient" | "unknown";
};
export type NetworkFeeState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; estimate: TradeNetworkFees };

type FeeRequest = { account: Address; to: Address; data: Hex; value: bigint };
// L1Block's documented Isthmus getters. viem does not publicly export its ABI.
const l1BlockFeeAbi = parseAbi([
  "function operatorFeeScalar() view returns (uint32)",
  "function operatorFeeConstant() view returns (uint64)",
]);
/** Deliberately read-only: estimating never needs a wallet or a signing method. */
export interface BaseFeeReader {
  estimateGas: (request: FeeRequest) => Promise<bigint>;
  getGasPrice: () => Promise<bigint>;
  estimateL1Fee: (request: FeeRequest) => Promise<bigint>;
  estimateOperatorFee: (request: FeeRequest) => Promise<bigint>;
  readContract: (request: { address: Address; abi: typeof l1BlockFeeAbi; functionName: "operatorFeeScalar" | "operatorFeeConstant" }) => Promise<bigint | number>;
}
const L1_BLOCK = "0x4200000000000000000000000000000000000015" as const;
const unavailable = (e: unknown): FeeComponent => ({
  status: "unavailable",
  message: (e instanceof Error ? (e as Error & { shortMessage?: string }).shortMessage ?? e.message : "Fee read failed").slice(0, 180),
});
async function component(read: () => Promise<bigint>): Promise<FeeComponent> {
  try {
    const wei = await read();
    if (typeof wei !== "bigint" || wei < 0n) throw new Error("RPC returned an invalid fee.");
    return { status: "available", wei };
  } catch (e) { return unavailable(e); }
}
const parts = (fee: TransactionFee) => [fee.execution, fee.l1Data, fee.operator];

/** Same components as viem's estimateTotalFee, retained separately for honest partial states.
 * https://viem.sh/op-stack/actions/estimateTotalFee
 */
export async function estimateTransactionFee(reader: BaseFeeReader, request: FeeRequest): Promise<TransactionFee> {
  const [execution, l1Data, operator] = await Promise.all([
    component(async () => {
      const [gas, price] = await Promise.all([reader.estimateGas(request), reader.getGasPrice()]);
      if (typeof gas !== "bigint" || gas <= 0n || typeof price !== "bigint" || price < 0n) throw new Error("Invalid execution gas estimate.");
      return gas * price;
    }),
    component(() => reader.estimateL1Fee(request)),
    component(async () => {
      // viem 2.52 catches ALL operator read/estimate failures and returns 0.
      // Verify parameters independently: an RPC failure is not proof of a zero fee.
      const [scalar, constant] = await Promise.all([
        reader.readContract({ address: L1_BLOCK, abi: l1BlockFeeAbi, functionName: "operatorFeeScalar" }),
        reader.readContract({ address: L1_BLOCK, abi: l1BlockFeeAbi, functionName: "operatorFeeConstant" }),
      ]);
      if (![scalar, constant].every((v) => typeof v === "bigint" ? v >= 0n : Number.isSafeInteger(v) && v >= 0)) {
        throw new Error("Operator fee parameters unavailable.");
      }
      // A verified zero configuration needs no gas estimate and is legitimately zero.
      if (BigInt(scalar) === 0n && BigInt(constant) === 0n) return 0n;
      const fee = await reader.estimateOperatorFee(request);
      // Nonzero parameters can round to zero only when the scalar contribution is
      // below one wei. Verify that case rather than trusting viem's error fallback.
      if (fee === 0n) {
        const gas = await reader.estimateGas(request);
        if (BigInt(constant) + gas * BigInt(scalar) / 1_000_000n !== 0n) {
          throw new Error("Operator fee estimate unavailable (unexpected zero).");
        }
      }
      return fee;
    }),
  ]);
  return { execution, l1Data, operator, totalWei: totalFee([execution, l1Data, operator]) };
}

export function summarizeFees(steps: TransactionFee[], eth: bigint) {
  const components = steps.flatMap(parts);
  const totalWei = totalFee(components);
  const knownWei = components.reduce((sum, fee) => sum + (fee.status === "available" ? fee.wei : 0n), 0n);
  return {
    totalWei,
    funding: knownWei > eth ? "insufficient" as const : totalWei === null ? "unknown" as const : "sufficient" as const,
  };
}

export function requireTransactionFunds(fee: TransactionFee, eth: bigint) {
  if (fee.totalWei === null) throw new Error("Full Base network fee unavailable. Refresh the estimate before signing.");
  if (eth < fee.totalWei) throw new Error("Insufficient ETH for the full Base network fee, including L1 data and operator fees.");
}

export async function estimateTradeNetworkFees(
  reader: BaseFeeReader,
  account: Address,
  params: ReturnType<typeof validatedTradeParams>,
  allowance: bigint,
  eth: bigint,
  dataSuffix?: Hex,
): Promise<TradeNetworkFees> {
  const request = (to: Address, data: Hex): FeeRequest => ({
    account, to, data: dataSuffix ? concat([data, dataSuffix]) : data, value: 0n,
  });
  const approvalRequired = allowance < params.amountIn;
  const approval = (amount: bigint) => estimateTransactionFee(reader, request(params.tokenIn,
    encodeFunctionData({ abi: stockflowErc20Abi, functionName: "approve", args: [STOCKFLOW_ROUTER, amount] })));
  const [reset, approve, swap] = await Promise.all([
    approvalRequired && allowance > 0n ? approval(0n) : Promise.resolve(null),
    approvalRequired ? approval(params.amountIn) : Promise.resolve(null),
    estimateTransactionFee(reader, request(STOCKFLOW_ROUTER,
      encodeFunctionData({ abi: stockflowSwapAbi, functionName: "exactInputSingle", args: [params] }))),
  ]);
  const steps = [reset, approve, swap].filter((fee): fee is TransactionFee => fee !== null);
  return { allowance, eth, reset, approval: approve, swap, ...summarizeFees(steps, eth) };
}
