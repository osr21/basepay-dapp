import solc from "solc";
import { readFileSync, writeFileSync } from "node:fs";
const source = readFileSync(new URL("../../contracts/StockFlowSandbox.sol", import.meta.url), "utf8");
const output = JSON.parse(solc.compile(JSON.stringify({
  language: "Solidity",
  sources: { "StockFlowSandbox.sol": { content: source } },
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "paris", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
})));
for (const error of output.errors ?? []) {
  if (error.severity === "error") throw new Error(error.formattedMessage);
}
const contract = output.contracts["StockFlowSandbox.sol"].StockFlowSandbox;
writeFileSync(new URL("../../artifacts/base-pay/src/lib/stockflow-sandbox.json", import.meta.url), JSON.stringify({
  abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}`,
}, null, 2) + "\n");
console.info("Compiled testnet-only StockFlow sandbox.");
