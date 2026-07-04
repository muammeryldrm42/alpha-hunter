# ALPHA MEME

Filtered on-chain alpha scanner for fresh Solana meme tokens.

Every token is discovered from multiple radars (GeckoTerminal new + trending pools, DexScreener latest profiles + boosts, OKX Wallet signal feed when reachable), then forced through **ALPHA FILTER v1** — 8 hard gates — before it can appear anywhere in the UI:

1. **LIQ** — minimum liquidity ($10k default, adjustable)
2. **VOL** — 24h volume ≥ $25k and vol/liq ≥ 0.4
3. **AGE** — pair age between 20 minutes and the selected window (24h / 3d / 7d)
4. **ACT** — ≥ 30 transactions in the last hour
5. **WASH** — rejects one-sided tape (bot/wash patterns)
6. **KNIFE** — falling-knife veto across 1h/6h/24h
7. **RUG** — MC-crash blacklist + liq/MC ≥ 2%
8. **SPIKE** — rejects manipulation-grade 5m moves

Survivors get a 0–100 **Alpha Score** (momentum alignment, flow acceleration, buy dominance, turnover, depth, radar presence, continuity streak) and signal tags: **HOT BUYS**, **WHALE ALERT**, **SMART TRADER**, **FRESH ALPHA**, plus **OKX** badges when the wallet signal feed responds.

Charts are embedded from GeckoTerminal. Optional Telegram alerts fire for scores ≥ 75 (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`).

## Run

```
cd backend
npm install
npm run dev
```

Deploys to Vercel as-is (`vercel.json` included). No API keys required.

Heuristics only — not financial advice.
