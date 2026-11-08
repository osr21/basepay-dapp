/** Exact ETH fees. A partial sum must never be presented as the total paid. */
export type FeeComponent = { status: "available"; wei: bigint } | { status: "unavailable"; message: string };
export type TransactionFee = {
  execution: FeeComponent;
  l1Data: FeeComponent;
  operator: FeeComponent;
  totalWei: bigint | null;
};
export type StoredTransactionFee = {
  executionWei: string | null;
  l1DataWei: string | null;
  operatorWei: string | null;
  totalWei: string | null;
};
const missing = (message: string): FeeComponent => ({ status: "unavailable", message });
const known = (wei: bigint): FeeComponent => ({ status: "available", wei });
export function totalFee(components: FeeComponent[]): bigint | null {
  let total = 0n;
  for (const fee of components) {
    if (fee.status !== "available") return null;
    total += fee.wei;
  }
  return total;
}
export function unavailableTransactionFee(): TransactionFee {
  return { execution: missing("Receipt fee unavailable"), l1Data: missing("Receipt L1 fee unavailable"), operator: missing("Receipt operator fee unavailable"), totalWei: null };
}
export function serializeFee(fee: TransactionFee): StoredTransactionFee {
  const value = (f: FeeComponent) => f.status === "available" ? f.wei.toString() : null;
  return { executionWei: value(fee.execution), l1DataWei: value(fee.l1Data), operatorWei: value(fee.operator), totalWei: fee.totalWei?.toString() ?? null };
}
export function deserializeFee(fee?: StoredTransactionFee | null): TransactionFee {
  const part = (value: unknown) => typeof value === "string" && /^\d+$/.test(value) ? known(BigInt(value)) : missing("Not recorded or unavailable");
  const execution = part(fee?.executionWei), l1Data = part(fee?.l1DataWei), operator = part(fee?.operatorWei);
  return { execution, l1Data, operator, totalWei: totalFee([execution, l1Data, operator]) };
}

/** Raw RPC fields are required: viem 2.52's Base formatter drops operator fields.
 * Use client.request({ method: "eth_getTransactionReceipt", params: [hash] }).
 * Do not reconstruct l1Fee from l1GasUsed * l1GasPrice (Fjord compression).
 */
export type BaseReceiptFees = {
  transactionHash?: unknown;
  blockHash?: unknown;
  blockNumber?: unknown;
  gasUsed?: unknown;
  effectiveGasPrice?: unknown;
  l1Fee?: unknown;
  operatorFeeScalar?: unknown;
  operatorFeeConstant?: unknown;
  daFootprintGasScalar?: unknown;
};
function quantity(value: unknown): bigint | null {
  if (typeof value === "bigint") return value >= 0n ? value : null;
  return typeof value === "string" && /^0x[0-9a-f]+$/i.test(value) ? BigInt(value) : null;
}
/** Rules: https://specs.optimism.io/protocol/isthmus/exec-engine.html#fees
 * https://docs.base.org/upgrades/jovian/exec-engine#operator-fee
 * gasUsed is the actual post-refund receipt gas, NOT the transaction gas limit.
 */
export function actualTransactionFee(receipt: BaseReceiptFees, jovian: boolean | null): TransactionFee {
  const gas = quantity(receipt.gasUsed), price = quantity(receipt.effectiveGasPrice), l1 = quantity(receipt.l1Fee);
  const scalar = quantity(receipt.operatorFeeScalar), constant = quantity(receipt.operatorFeeConstant);
  const execution = gas !== null && price !== null ? known(gas * price) : missing("Receipt gasUsed/effectiveGasPrice missing");
  const l1Data = l1 !== null ? known(l1) : missing("Receipt l1Fee missing");
  let operator = missing("Receipt operator fields or fee rules unavailable");
  if (scalar !== null && constant !== null && scalar <= 0xffffffffn && constant <= 0xffffffffffffffffn) {
    if (scalar === 0n) operator = known(constant);
    else if (gas !== null && jovian !== null) operator = known(
      (jovian ? gas * scalar * 100n : gas * scalar / 1_000_000n) + constant,
    );
  }
  return { execution, l1Data, operator, totalWei: totalFee([execution, l1Data, operator]) };
}

// Minimal read-only client surface, implemented by current viem PublicClient.
const oracleAbi = [{ type: "function", name: "isJovian", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] }] as const;
export interface ReceiptFeeReader {
  request: (args: { method: "eth_getTransactionReceipt"; params: [`0x${string}`] }) => Promise<unknown>;
  readContract: (args: { address: "0x420000000000000000000000000000000000000F"; abi: typeof oracleAbi; functionName: "isJovian"; blockNumber: bigint }) => Promise<unknown>;
}
export async function readActualTransactionFee(
  reader: ReceiptFeeReader, hash: `0x${string}`, expectedBlockHash?: string,
): Promise<TransactionFee> {
  try {
    const raw = await reader.request({ method: "eth_getTransactionReceipt", params: [hash] }) as BaseReceiptFees | null;
    if (!raw || typeof raw.transactionHash !== "string" || raw.transactionHash.toLowerCase() !== hash.toLowerCase() ||
        (expectedBlockHash && (typeof raw.blockHash !== "string" || raw.blockHash.toLowerCase() !== expectedBlockHash.toLowerCase()))) {
      return unavailableTransactionFee();
    }
    // Jovian's receipt marker is authoritative for that block. Otherwise read the
    // oracle at the RECEIPT block, never latest parameters for a historical fee.
    let jovian: boolean | null = quantity(raw.daFootprintGasScalar) !== null ? true : null;
    if (jovian === null && quantity(raw.operatorFeeScalar) !== null && quantity(raw.operatorFeeScalar) !== 0n) {
      const blockNumber = quantity(raw.blockNumber);
      if (blockNumber !== null) {
        const result = await reader.readContract({ address: "0x420000000000000000000000000000000000000F", abi: oracleAbi, functionName: "isJovian", blockNumber }).catch(() => null);
        if (typeof result === "boolean") jovian = result;
      }
    }
    return actualTransactionFee(raw, jovian);
  } catch { return unavailableTransactionFee(); }
}
