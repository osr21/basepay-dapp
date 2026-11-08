import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ganache from "ganache";
import { createPublicClient, createWalletClient, custom, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const artifact = JSON.parse(readFileSync(new URL("../../artifacts/base-pay/src/lib/stockflow-sandbox.json", import.meta.url), "utf8"));
const provider = ganache.provider({ logging: { quiet: true }, chain: { chainId: 84532 } });
const chain = defineChain({ id: 84532, name: "Local Sepolia sandbox test", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["http://unused.invalid"] } } });
const transport = custom(provider);
const publicClient = createPublicClient({ chain, transport });
const accounts = await provider.request({ method: "eth_accounts", params: [] });
const account = privateKeyToAccount(provider.getInitialAccounts()[accounts[0]].secretKey);
const wallet = createWalletClient({ account, chain, transport });
const abi = artifact.abi;
let checks = 0;
try {
  const receipt = await publicClient.waitForTransactionReceipt({ hash: await wallet.deployContract({ abi, bytecode: artifact.bytecode }) });
  const address = receipt.contractAddress;
  assert.ok(address);
  const read = (name, args = []) => publicClient.readContract({ address, abi, functionName: name, args });
  const write = async (name, args = []) => {
    const { request } = await publicClient.simulateContract({ account, address, abi, functionName: name, args });
    const r = await publicClient.waitForTransactionReceipt({ hash: await wallet.writeContract(request) });
    assert.equal(r.status, "success"); return r;
  };
  const denied = async (name, args, account = accounts[0]) => {
    await assert.rejects(publicClient.simulateContract({ account, address, abi, functionName: name, args }));
    checks++;
  };
  let now = (await publicClient.getBlock()).timestamp;
  assert.equal(await read("balance"), 1000_000000n); checks++;
  await write("buy", [25_000000n, 25n * 10n ** 16n, now + 300n]);
  assert.equal(await read("position"), 25n * 10n ** 16n); checks++;
  assert.equal(await read("balance"), 975_000000n); checks++;
  await denied("buy", [26_000000n, 0n, now + 300n]);
  await denied("buy", [1_000000n, 0n, now + 300n], accounts[1]);
  await denied("buy", [1_000000n, 0n, now - 1n]);
  await denied("buy", [1_000000n, 100n * 10n ** 18n, now + 300n]);
  await denied("setPolicy", [0n, 100_000000n, now + 100n]);
  await denied("setPolicy", [10_000000n, 5_000000n, now + 100n]);
  await write("setPolicy", [100_000000n, 100_000000n, now + 86400n * 7n]);
  assert.equal(await read("spent"), 25_000000n); checks++;
  await denied("buy", [76_000000n, 0n, now + 300n]);
  await write("buy", [75_000000n, 0n, now + 300n]);
  await denied("buy", [1_000000n, 0n, now + 300n]);
  await write("revoke");
  await denied("buy", [1_000000n, 0n, now + 300n]);
  await provider.request({ method: "evm_increaseTime", params: [86401] });
  await provider.request({ method: "evm_mine", params: [] });
  now = (await publicClient.getBlock({ blockTag: "latest" })).timestamp;
  await write("setPolicy", [25_000000n, 100_000000n, now + 100n]);
  assert.equal(await read("spent"), 0n); checks++;
  await write("buy", [1_000000n, 0n, now + 60n]);
  await provider.request({ method: "evm_increaseTime", params: [101] });
  await provider.request({ method: "evm_mine", params: [] });
  await denied("buy", [1_000000n, 0n, now + 200n]);
  console.info(`StockFlow sandbox: ${checks} checks passed (local EVM, no live funds).`);
} finally { await provider.disconnect(); }

const mainnet = ganache.provider({ logging: { quiet: true }, chain: { chainId: 8453 } });
try {
  const chainMainnet = { ...chain, id: 8453 };
  const accts = await mainnet.request({ method: "eth_accounts", params: [] });
  const signer = privateKeyToAccount(mainnet.getInitialAccounts()[accts[0]].secretKey);
  const w = createWalletClient({ account: signer, chain: chainMainnet, transport: custom(mainnet) });
  await assert.rejects(w.deployContract({ abi, bytecode: artifact.bytecode }));
  console.info("StockFlow sandbox: deployment on Base mainnet rejected.");
} finally { await mainnet.disconnect(); }
