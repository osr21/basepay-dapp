import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPublicClient, decodeFunctionData, encodeFunctionData, parseAbi, parseTransaction, type Address, type Hex } from "viem";
import { base } from "viem/chains";
import { publicActionsL2 } from "viem/op-stack";
import {
  estimateTradeNetworkFees, estimateTransactionFee, requireTransactionFunds, summarizeFees,
  type BaseFeeReader, type FeeComponent,
} from "../src/lib/stockflow-network-fees";
import { STOCKFLOW_ROUTER, STOCKFLOW_USDC, stockflowErc20Abi, stockflowSwapAbi } from "../src/lib/stockflow-trade-contract";
import { baseFeeRpc, GAS_PRICE_ORACLE, L1_BLOCK, SELECTORS, type BaseFeeRpc, type RpcTransaction } from "./helpers/base-fee-rpc";

import { actualTransactionFee, readActualTransactionFee, serializeFee, deserializeFee } from "@workspace/base-fees";

const account = "0x1111111111111111111111111111111111111111" as const;
const params = {
  tokenIn: STOCKFLOW_USDC, tokenOut: "0x2222222222222222222222222222222222222222" as Address,
  tickSpacing: 100, recipient: account, deadline: 2_000_000_000n,
  amountIn: 25_000000n, amountOutMinimum: 100n, sqrtPriceLimitX96: 0n,
};
const request = { account, to: STOCKFLOW_ROUTER, data: "0x1234" as const, value: 0n };
const available = (wei: bigint): FeeComponent => ({ status: "available", wei });
const reader = {
  estimateGas: vi.fn<BaseFeeReader["estimateGas"]>(),
  getGasPrice: vi.fn<BaseFeeReader["getGasPrice"]>(),
  estimateL1Fee: vi.fn<BaseFeeReader["estimateL1Fee"]>(),
  estimateOperatorFee: vi.fn<BaseFeeReader["estimateOperatorFee"]>(),
  readContract: vi.fn<BaseFeeReader["readContract"]>(),
};
beforeEach(() => {
  vi.resetAllMocks();
  reader.estimateGas.mockResolvedValue(100_000n);
  reader.getGasPrice.mockResolvedValue(10n);
  reader.estimateL1Fee.mockResolvedValue(200n);
  reader.estimateOperatorFee.mockResolvedValue(30n);
  reader.readContract.mockResolvedValue(1n);
});

describe("Base full transaction cost", () => {
  it("adds execution, L1 data and operator fees using exact bigint arithmetic", async () => {
    const gas = 9007199254740993n;
    reader.estimateGas.mockResolvedValue(gas);
    reader.getGasPrice.mockResolvedValue(9007199254740997n);
    const fee = await estimateTransactionFee(reader, request);
    expect(fee).toEqual({
      execution: available(gas * 9007199254740997n), l1Data: available(200n), operator: available(30n),
      totalWei: gas * 9007199254740997n + 230n,
    });
    expect(reader.estimateL1Fee).toHaveBeenCalledWith(request);
    expect(reader.estimateOperatorFee).toHaveBeenCalledWith(request);
  });

  it.each(["estimateGas", "getGasPrice", "estimateL1Fee", "estimateOperatorFee"] as const)(
    "does not present a full total if %s fails", async (method) => {
      reader[method].mockRejectedValue(new Error("RPC unavailable"));
      const fee = await estimateTransactionFee(reader, request);
      expect(fee.totalWei).toBeNull();
      expect(summarizeFees([fee], 10n ** 18n).funding).toBe("unknown");
      expect(() => requireTransactionFunds(fee, 10n ** 18n)).toThrow(/unavailable/);
    },
  );

  it("does not convert missing operator parameter reads into a free operator fee", async () => {
    reader.readContract.mockRejectedValue(new Error("RPC timeout"));
    reader.estimateOperatorFee.mockResolvedValue(0n);
    const fee = await estimateTransactionFee(reader, request);
    expect(fee.operator).toEqual({ status: "unavailable", message: "RPC timeout" });
    expect(fee.totalWei).toBeNull();
  });

  it("rejects viem's silent zero fallback when verified operator parameters require a fee", async () => {
    reader.estimateOperatorFee.mockResolvedValue(0n);
    const fee = await estimateTransactionFee(reader, request);
    expect(fee.operator.status).toBe("unavailable");
    expect(fee.totalWei).toBeNull();
  });

  it("accepts a verified zero operator fee on Base without guessing", async () => {
    reader.readContract.mockResolvedValue(0n);
    const fee = await estimateTransactionFee(reader, request);
    expect(fee.operator).toEqual(available(0n));
    expect(fee.totalWei).toBe(1_000200n);
    expect(reader.estimateOperatorFee).not.toHaveBeenCalled();
  });

  it("allows scalar fees that really round down to zero", async () => {
    reader.readContract.mockImplementation(async ({ functionName }) => functionName === "operatorFeeScalar" ? 1n : 0n);
    reader.estimateOperatorFee.mockResolvedValue(0n);
    expect((await estimateTransactionFee(reader, request)).operator).toEqual(available(0n));
  });

  it("does not trust an invalid or missing fee value", async () => {
    reader.estimateL1Fee.mockResolvedValue(undefined as unknown as bigint);
    const fee = await estimateTransactionFee(reader, request);
    expect(fee.totalWei).toBeNull();
    expect(fee.l1Data.status).toBe("unavailable");
  });

  it("requires ETH for L1 data and operator cost even when execution gas is affordable", async () => {
    const fee = await estimateTransactionFee(reader, request);
    expect(summarizeFees([fee], 1_000000n)).toEqual({ totalWei: 1_000230n, funding: "insufficient" });
    expect(() => requireTransactionFunds(fee, 1_000000n)).toThrow(/Insufficient ETH/);
    expect(() => requireTransactionFunds(fee, 1_000230n)).not.toThrow();
    expect(summarizeFees([fee], 1_000230n).funding).toBe("sufficient");
  });

  it("can report insufficient ETH for known components without inventing a missing total", async () => {
    reader.estimateL1Fee.mockRejectedValue(new Error("L1 data unavailable"));
    const fee = await estimateTransactionFee(reader, request);
    expect(summarizeFees([fee], 0n)).toEqual({ totalWei: null, funding: "insufficient" });
  });
});

describe("reset, approval and swap network costs", () => {
  it.each([
    [0n, false, true, 2n],
    [1n, true, true, 3n],
    [params.amountIn, false, false, 1n],
    [params.amountIn + 1n, false, false, 1n],
  ])("uses the actual allowance %s to select required transactions", async (allowance, reset, approval, count) => {
    const fee = await estimateTradeNetworkFees(reader, account, params, allowance, 10n ** 18n);
    expect(!!fee.reset).toBe(reset);
    expect(!!fee.approval).toBe(approval);
    expect(fee.swap.totalWei).toBe(1_000230n);
    expect(fee.totalWei).toBe(1_000230n * count);
    const approvals = reader.estimateL1Fee.mock.calls.filter(([r]) => r.to === STOCKFLOW_USDC)
      .map(([r]) => decodeFunctionData({ abi: stockflowErc20Abi, data: r.data }).args);
    expect(approvals).toEqual(reset ? [[STOCKFLOW_ROUTER, 0n], [STOCKFLOW_ROUTER, params.amountIn]]
      : approval ? [[STOCKFLOW_ROUTER, params.amountIn]] : []);
    for (const [r] of reader.estimateL1Fee.mock.calls) {
      expect(r.account).toBe(account);
      expect(r.value).toBe(0n);
    }
  });

  it("includes the connector's attribution suffix in all estimated calldata", async () => {
    await estimateTradeNetworkFees(reader, account, params, 1n, 10n ** 18n, "0xaabb");
    expect(reader.estimateL1Fee).toHaveBeenCalledTimes(3);
    for (const [r] of reader.estimateL1Fee.mock.calls) expect(r.data.endsWith("aabb")).toBe(true);
  });

  it("keeps the swap explicitly unavailable before approval without submitting anything", async () => {
    reader.estimateGas.mockImplementation(async (r) => {
      if (r.to === STOCKFLOW_ROUTER) throw new Error("Allowance insufficient for swap");
      return 100_000n;
    });
    const fee = await estimateTradeNetworkFees(reader, account, params, 0n, 10n ** 18n);
    expect(fee.approval?.totalWei).toBe(1_000230n);
    expect(fee.swap.execution.status).toBe("unavailable");
    expect(fee.totalWei).toBeNull();
    expect(fee.funding).toBe("unknown");
    // The only capabilities supplied to the estimator are read-only.
    expect(Object.keys(reader).sort()).toEqual(["estimateGas", "estimateL1Fee", "estimateOperatorFee", "getGasPrice", "readContract"]);
  });
});

describe("installed viem publicActionsL2 against Base JSON-RPC fixtures", () => {
  let rpc: BaseFeeRpc;
  const connect = (options: Parameters<typeof baseFeeRpc>[0] = {}) => {
    rpc = baseFeeRpc(options);
    // Real public actions, real ABI encoding/decoding, no wallet or live RPC.
    return createPublicClient({ chain: base, transport: rpc.transport, cacheTime: 0 }).extend(publicActionsL2());
  };
  afterEach(() => {
    // Unknown requests must fail even if an action catches their rejection.
    expect(rpc.unexpected).toEqual([]);
    expect(rpc.requests.length).toBeGreaterThan(0);
    expect(rpc.requests.every(({ method }) => ["eth_call", "eth_estimateGas", "eth_gasPrice"].includes(method))).toBe(true);
  });

  it("reads Base's actual oracle contracts and combines decoded execution, L1 and nonzero operator fees", async () => {
    const client = connect();
    const fee = await estimateTransactionFee(client, request);
    expect(fee).toEqual({
      execution: available(1_000_000n), l1Data: available(200n), operator: available(200_007n),
      totalWei: 1_200_207n,
    });
    expect(rpc.counts).toEqual({ gas: 2, price: 1, l1: 1, scalar: 2, constant: 2 });
    const calls = rpc.requests.filter(({ method }) => method === "eth_call").map(({ params }) => params![0] as RpcTransaction);
    expect(calls.filter(({ to }) => to?.toLowerCase() === L1_BLOCK).map(({ data }) => data).sort())
      .toEqual([SELECTORS.scalar, SELECTORS.scalar, SELECTORS.constant, SELECTORS.constant].sort());
    expect(calls.find(({ data }) => data?.startsWith(SELECTORS.l1))?.to?.toLowerCase()).toBe(GAS_PRICE_ORACLE);
  });

  it("accepts a zero operator configuration only after both getters successfully decode", async () => {
    const client = connect({ scalar: 0n, constant: 0n });
    expect(await estimateTransactionFee(client, request)).toEqual({
      execution: available(1_000_000n), l1Data: available(200n), operator: available(0n), totalWei: 1_000_200n,
    });
    // One independent verification each; no redundant operator gas estimation.
    expect(rpc.counts).toEqual({ gas: 1, price: 1, l1: 1, scalar: 1, constant: 1 });
  });

  it.each([
    { scalar: 0n, constant: 9n, expected: 9n },
    { scalar: 20n, constant: 0n, expected: 2n },
    { scalar: 1n, constant: 0n, expected: 0n },
  ])("handles scalar=$scalar and constant=$constant, including genuine rounding to zero", async ({ scalar, constant, expected }) => {
    const client = connect({ scalar, constant });
    const fee = await estimateTransactionFee(client, request);
    expect(fee.operator).toEqual(available(expected));
    expect(fee.totalWei).toBe(1_000_200n + expected);
  });

  it.each(["scalar", "constant", "gas"] as const)(
    "documents that viem's installed operator action swallows a %s JSON-RPC failure as zero", async (read) => {
      const client = connect({ failures: { [read]: {} } });
      expect(await client.estimateOperatorFee(request)).toBe(0n);
      expect(rpc.counts[read]).toBe(1);
    },
  );

  it.each(["scalar", "constant"] as const)(
    "does not mistake a failed %s getter for a verified zero configuration", async (read) => {
      const client = connect({ scalar: 0n, constant: 0n, failures: { [read]: {} } });
      const fee = await estimateTransactionFee(client, request);
      expect(fee.execution).toEqual(available(1_000_000n));
      expect(fee.l1Data).toEqual(available(200n));
      expect(fee.operator.status).toBe("unavailable");
      expect(fee.totalWei).toBeNull();
      expect(summarizeFees([fee], 10n ** 18n).funding).toBe("unknown");
      expect(() => requireTransactionFunds(fee, 10n ** 18n)).toThrow(/unavailable/);
      expect(rpc.counts.gas).toBe(1);
    },
  );

  it.each(["scalar", "constant", "gas"] as const)(
    "rejects the silent zero when %s fails inside viem after independent verification succeeds", async (read) => {
      const client = connect({ failures: { [read]: { fromCall: 2 } } });
      const fee = await estimateTransactionFee(client, request);
      expect(fee.execution).toEqual(available(1_000_000n));
      expect(fee.l1Data).toEqual(available(200n));
      expect(fee.operator.status).toBe("unavailable");
      expect(fee.totalWei).toBeNull();
      expect(rpc.counts[read]).toBeGreaterThanOrEqual(2);
      expect(() => requireTransactionFunds(fee, 10n ** 18n)).toThrow(/unavailable/);
    },
  );

  it.each(["empty", "malformed"] as const)("fails closed on %s ABI results rather than inventing a total", async (kind) => {
    const client = connect({ failures: { scalar: { kind }, l1: { kind } } });
    const fee = await estimateTransactionFee(client, request);
    expect(fee.operator.status).toBe("unavailable");
    expect(fee.l1Data.status).toBe("unavailable");
    expect(fee.totalWei).toBeNull();
  });

  it.each([
    ["gas", "execution"], ["price", "execution"], ["l1", "l1Data"],
  ] as const)("keeps a %s transport error unavailable in %s", async (read, part) => {
    const client = connect({ failures: { [read]: {} } });
    const fee = await estimateTransactionFee(client, request);
    expect(fee[part].status).toBe("unavailable");
    expect(fee.totalWei).toBeNull();
    expect(() => requireTransactionFunds(fee, 10n ** 18n)).toThrow(/unavailable/);
  });

  it("passes complete attributed reset, approval and swap transactions to getL1Fee(bytes), read-only", async () => {
    const client = connect();
    const suffix = "0xaabb" as const;
    const fee = await estimateTradeNetworkFees(client, account, params, 1n, 10n ** 18n, suffix);
    expect(fee.reset?.totalWei).toBe(1_200_207n);
    expect(fee.approval?.totalWei).toBe(1_200_207n);
    expect(fee.swap.totalWei).toBe(1_200_207n);
    expect(fee.totalWei).toBe(3_600_621n);
    expect(fee.funding).toBe("sufficient");

    const attributed = (data: Hex): Hex => `${data}${suffix.slice(2)}`;
    const expected = [
      { to: STOCKFLOW_USDC, data: attributed(encodeFunctionData({ abi: stockflowErc20Abi, functionName: "approve", args: [STOCKFLOW_ROUTER, 0n] })) },
      { to: STOCKFLOW_USDC, data: attributed(encodeFunctionData({ abi: stockflowErc20Abi, functionName: "approve", args: [STOCKFLOW_ROUTER, params.amountIn] })) },
      { to: STOCKFLOW_ROUTER, data: attributed(encodeFunctionData({ abi: stockflowSwapAbi, functionName: "exactInputSingle", args: [params] })) },
    ].map(({ to, data }) => ({ to: to.toLowerCase(), data }));
    const oracleCalls = rpc.requests.filter(({ method, params }) => method === "eth_call"
      && (params![0] as RpcTransaction).to?.toLowerCase() === GAS_PRICE_ORACLE);
    expect(oracleCalls).toHaveLength(3);
    const transactions = oracleCalls.map(({ params }) => {
      const { args: [serialized] } = decodeFunctionData({
        abi: parseAbi(["function getL1Fee(bytes) view returns (uint256)"]),
        data: (params![0] as RpcTransaction).data!,
      });
      return parseTransaction(serialized);
    });
    expect(transactions.map(({ to, data }) => ({ to: to?.toLowerCase(), data }))).toEqual(expected);
    for (const tx of transactions) {
      expect(tx.chainId).toBe(8453);
      expect(tx.type).toBe("eip1559");
      expect(tx.value ?? 0n).toBe(0n);
      expect(tx.r).toBeUndefined();
      expect(tx.s).toBeUndefined();
    }
    const gasRequests = rpc.requests.filter(({ method }) => method === "eth_estimateGas");
    expect(gasRequests).toHaveLength(6);
    for (const { params: rpcParams } of gasRequests) {
      const tx = rpcParams![0] as RpcTransaction;
      expect(tx.from?.toLowerCase()).toBe(account);
      expect(tx.value).toBe("0x0");
      expect(expected).toContainEqual({ to: tx.to?.toLowerCase(), data: tx.data });
    }
  });
});

describe("receipt-derived actual network fees", () => {
  const hash = `0x${"ab".repeat(32)}` as const;
  const blockHash = `0x${"cd".repeat(32)}`;
  const receipt = {
    transactionHash: hash, blockHash, blockNumber: "0x10", gasUsed: "0x186a1", effectiveGasPrice: "0xa",
    l1Fee: "0xc8", operatorFeeScalar: "0x186a0", operatorFeeConstant: "0x1e",
  };
  it("uses post-refund gasUsed, the effective price, and authoritative l1Fee", () => {
    const fee = actualTransactionFee({ ...receipt, gas: "0xffffff", l1GasUsed: "0xff", l1GasPrice: "0xff" } as typeof receipt, false);
    expect(fee.execution).toEqual(available(1_000010n));
    expect(fee.l1Data).toEqual(available(200n));
    expect(fee.operator).toEqual(available(10_030n));
    expect(fee.totalWei).toBe(1_010240n);
  });
  it("applies Jovian's new operator multiplier rather than the Isthmus division", () => {
    const fee = actualTransactionFee(receipt, true);
    expect(fee.operator).toEqual(available(100001n * 100000n * 100n + 30n));
  });
  it("keeps values well above Number.MAX_SAFE_INTEGER exact through storage", () => {
    const fee = actualTransactionFee({ ...receipt, gasUsed: "0x20000000000001", effectiveGasPrice: "0x20000000000003" }, false);
    expect(fee.execution).toEqual(available(9007199254740993n * 9007199254740995n));
    expect(deserializeFee(JSON.parse(JSON.stringify(serializeFee(fee))))).toEqual(fee);
  });
  it.each(["gasUsed", "effectiveGasPrice", "l1Fee", "operatorFeeScalar", "operatorFeeConstant"] as const)(
    "does not invent a total when receipt %s is missing", (field) => {
      const fee = actualTransactionFee({ ...receipt, [field]: null }, false);
      expect(fee.totalWei).toBeNull();
      expect(serializeFee(fee).totalWei).toBeNull();
    },
  );
  it.each([undefined, null, "", "0x", "-1", 0, NaN, "junk"])("rejects an invalid fee %s instead of calling it zero", (value) => {
    expect(actualTransactionFee({ ...receipt, l1Fee: value }, false).l1Data.status).toBe("unavailable");
  });
  it("accepts explicit zero fields but does not infer zero from absent operator parameters", () => {
    const fee = actualTransactionFee({ ...receipt, l1Fee: "0x0", operatorFeeScalar: "0x0", operatorFeeConstant: "0x0" }, null);
    expect(fee.operator).toEqual(available(0n));
    expect(fee.l1Data).toEqual(available(0n));
    expect(fee.totalWei).toBe(1000010n);
    expect(actualTransactionFee({ ...receipt, operatorFeeScalar: undefined, operatorFeeConstant: undefined }, true).totalWei).toBeNull();
  });
  it("does not guess the active operator rules", () => {
    expect(actualTransactionFee(receipt, null).operator.status).toBe("unavailable");
  });
  it("reads the raw receipt with current viem request API and pins rule reads to its block", async () => {
    const rpc = { request: vi.fn().mockResolvedValue(receipt), readContract: vi.fn().mockResolvedValue(false) };
    const fee = await readActualTransactionFee(rpc, hash, blockHash);
    expect(fee.totalWei).toBe(1010240n);
    expect(rpc.request).toHaveBeenCalledWith({ method: "eth_getTransactionReceipt", params: [hash] });
    expect(rpc.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "isJovian", blockNumber: 16n }));
    expect(Object.keys(rpc).sort()).toEqual(["readContract", "request"]);
  });
  it("recognizes the Jovian receipt marker without reading today's oracle", async () => {
    const rpc = { request: vi.fn().mockResolvedValue({ ...receipt, daFootprintGasScalar: "0x190" }), readContract: vi.fn() };
    const fee = await readActualTransactionFee(rpc, hash, blockHash);
    expect(fee.operator).toEqual(available(100001n * 100000n * 100n + 30n));
    expect(rpc.readContract).not.toHaveBeenCalled();
  });
  it("keeps the known costs when historical rule reads fail", async () => {
    const rpc = { request: vi.fn().mockResolvedValue(receipt), readContract: vi.fn().mockRejectedValue(new Error("archive unavailable")) };
    const fee = await readActualTransactionFee(rpc, hash, blockHash);
    expect(fee.totalWei).toBeNull();
    expect(fee.l1Data).toEqual(available(200n));
    expect(fee.operator.status).toBe("unavailable");
  });
  it.each([null, { ...receipt, transactionHash: "0x00" }, { ...receipt, blockHash: "0x00" }])(
    "does not use a missing, wrong-hash or different-block receipt", async (raw) => {
      const rpc = { request: vi.fn().mockResolvedValue(raw), readContract: vi.fn() };
      const fee = await readActualTransactionFee(rpc, hash, blockHash);
      expect(fee).toMatchObject({ totalWei: null, execution: { status: "unavailable" } });
      expect(rpc.readContract).not.toHaveBeenCalled();
    },
  );
});
