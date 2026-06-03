# BasePayRouter — Deployment Guide

Smart contract that routes USDC payments on Base, collecting a protocol fee for the deployer wallet.

## Prerequisites

Install [Foundry](https://book.getfoundry.sh/getting-started/installation):
```bash
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

## Deploy to Base Mainnet

```bash
forge create \
  --rpc-url https://mainnet.base.org \
  --private-key $DEPLOYER_PRIVATE_KEY \
  contracts/BasePayRouter.sol:BasePayRouter \
  --constructor-args 0xdb5019b8dfbccef8906c39b16a4870082eabbc4c 30
```

- **Arg 1**: `feeCollector` — your deployer wallet address (receives fees)
- **Arg 2**: `feeBps` — fee in basis points (30 = 0.30%)

## After Deployment

1. Copy the deployed contract address from the output.
2. Set it in your environment:
   ```
   VITE_ROUTER_ADDRESS=0x<deployed_address>
   ```
3. The frontend will automatically switch to single-transaction routing.

## Test on Base Sepolia First

```bash
forge create \
  --rpc-url https://sepolia.base.org \
  --private-key $DEPLOYER_PRIVATE_KEY \
  contracts/BasePayRouter.sol:BasePayRouter \
  --constructor-args 0xdb5019b8dfbccef8906c39b16a4870082eabbc4c 30
```

Test USDC on Base Sepolia: `0x036CbD53842c5426634e7929541eC2318f3dCF7e`

## Verify on BaseScan

```bash
forge verify-contract \
  <DEPLOYED_ADDRESS> \
  contracts/BasePayRouter.sol:BasePayRouter \
  --chain base \
  --etherscan-api-key $BASESCAN_API_KEY \
  --constructor-args $(cast abi-encode "constructor(address,uint256)" \
    0xdb5019b8dfbccef8906c39b16a4870082eabbc4c 30)
```

## Fee Model

| Gross Amount | Fee (0.30%) | Net to Recipient |
|---|---|---|
| 100 USDC | 0.30 USDC | 99.70 USDC |
| 500 USDC | 1.50 USDC | 498.50 USDC |
| 1000 USDC | 3.00 USDC | 997.00 USDC |
