---
name: BaseScan V2 Verification
description: How to verify contracts on BaseScan using the Etherscan V2 API
---

## API endpoint
Use `https://api.etherscan.io/v2/api?chainid=8453` (NOT `https://api.basescan.org/api`)

**Why:** BaseScan deprecated their V1 API endpoints in 2025/2026. The old `api.basescan.org/api` returns `NOTOK` with "deprecated V1 endpoint" for all calls including `eth_getCode` proxy. The V2 unified API at `api.etherscan.io/v2/api` handles all chains via `chainid` parameter.

**Critical:** `chainid=8453` must be in the **URL query string**, NOT the POST body. Putting it in the POST body returns "Missing or unsupported chainid parameter".

## Verification parameters used
- `codeformat=solidity-single-file`
- `compilerversion=v0.8.35+commit.47b9dedd`
- `optimizationUsed=1`, `runs=200`
- `constructorArguements=000...` (note: typo in API field name is intentional)
- BASESCAN_API_KEY env var is the Replit secret

## Getting compiler version from on-chain bytecode
Use `cbor2` to decode the metadata suffix:
```python
meta_len = int.from_bytes(code[-2:], "big")
meta = code[-2-meta_len:-2]
decoded = cbor2.loads(meta)
solc = decoded.get("solc", b"")  # bytes [major, minor, patch]
```

## Bytecode selector checks fail on proxy contracts
Searching for function selectors in proxy bytecode always fails — proxies delegatecall to implementation. Use `w3.eth.call({"to": proxy, "data": selector})` to verify functions exist instead.
