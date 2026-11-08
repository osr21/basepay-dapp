# Verified Base Mainnet smoke trade — 8 November 2026

[Documentation hub](README.md)

## Scope and consent

This was a real, explicitly authorized **0.10 USDC → NVDAc** test on Base
Mainnet (8453), not a simulation. The operator's participant grant was active
in the published app. The configured signer was used only after specific
one-off permission, through the published StockFlow login/quote/prepare/history
API. No participant grant was manufactured by the test.

Normal StockFlow trading remains wallet-confirmed. This exception did not add
a server-trading endpoint or authorize unattended future trades.

## Verified results

| Item | Result |
| --- | --- |
| Input | 0.10 USDC |
| Stock token | NVDAc — `0xb20000000000000000000078ee7ce2fE4908108C` |
| Tokens received | **0.00053199 NVDAc** |
| Minimum accepted output | 0.00052933 NVDAc |
| Slippage setting | 0.5% |
| Recipient | Same wallet that funded and signed the trade |
| Approval | Exactly 0.10 USDC |
| Router allowance after swap | **0 USDC** |
| Approval block | 54551788 |
| Swap block | 54551802 |
| Approval network cost | 0.000000332939332331 ETH |
| Swap network cost | 0.000001228612500121 ETH |
| Combined network cost | **0.000001561551832452 ETH** |

### Explorer evidence

- [Successful exact USDC approval](https://basescan.org/tx/0xa3738446fea2442dff9529d2b45e25a7640f5f9fedb58c8dc5ca715ecb14148f)
- [Successful NVDAc purchase](https://basescan.org/tx/0x925c92143ed196b0ea79cac5d4122ae8eb410bc4e95cf1e6561a0c9b453dd0e8)

The token output was verified from stock-token `Transfer` receipt logs.
Paid costs used execution gas and the receipt's L1 charge, with zero operator
parameters independently verified at the receipt blocks. The initial combined
fee reserve was 0.000003993738541682 ETH, below the authorized **0.00001 ETH
estimated network-fee budget**. Actual paid cost was lower.

At initial recording the transaction was mined successfully and StockFlow history
was `pending` while awaiting Base's safe-block confirmation. This records the
observed state at test time, not a claim that the transaction is still pending.

## Safety controls and conclusions

- Fixed funding wallet/recipient, stock, router and 100000 raw USDC input units.
- Fresh approved session, quote, token balance, allowance and simulation checks.
- Nonce checks before broadcasts; no automatic retries, speed-ups or replacements.
- No unlimited approval; the exact allowance was consumed.
- Temporary API session discarded after the test.

This demonstrates one real buy and the associated approval/recording path.
It does **not** demonstrate a sale, every stock/wallet, long-term liquidity,
autonomous allocation execution, an audit or jurisdiction-wide availability.
Future real tests need fresh consent and current eligibility/market checks.
