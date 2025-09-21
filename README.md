# Pump Raffle — Hands-Off Hourly SOL Raffle

A minimal, non-custodial hourly raffle for token holders:
- **Automatic hourly draw** at the top of each hour
- **Winners announced to Telegram**
- **Live OBS overlay** (countdown, price, vault/runway, last winner, and buy/eligibility toasts)
- **Auto top-up** from creator rewards to keep the treasury funded

> 🔐 **Security:** No secrets in this repo. Real keys live only in local `.env` files which are git-ignored. Public example files are provided.

---

## What’s included

- **Raffle engine** `raffle.js`  
  Snapshots holders at the top of the hour, excludes team/LP/treasury wallets, keeps holders ≥ `$MIN_HOLD_USD`, picks a winner using secure randomness, and sends `PRIZE_SOL` from the treasury (if not in `DRY_RUN`).

- **Telegram announcer** `launch-companion.prize-aware.js` + **eligibility watcher** `eligibility-watcher.js`  
  Posts winners and can announce **buys that cross the threshold** (≥ `$MIN_HOLD_USD`) with wallet short address.

- **OBS overlay** `obs-overlay.js`  
  Browser source for your stream. Shows countdown, eligible count, token price (Jupiter/DexScreener), vault/runway, last winner, and on-screen toasts for buys/eligibility.

- **Auto top-up** `auto-topup-from-creator.js`  
  Claims creator rewards and, respecting a `RESERVE_SOL`, transfers SOL to the treasury each hour. Start in `DRY_RUN=true` and flip to `false` when ready.

---

## How the winner is picked

1) Snapshot token holders at the **top of the hour**  
2) **Exclude** addresses you list (team, LP, treasury, etc.)  
3) Keep wallets whose holdings value ≥ `$MIN_HOLD_USD`  
4) **Uniform random pick** among eligibles (secure randomness from Node’s crypto)  
5) Send `PRIZE_SOL` to the winner (if not `DRY_RUN`) and announce to Telegram/overlay

This design is **hands-off**: you don’t pick the winner manually.

---

## Quick start (Windows + PM2)

> You’ll create **private** env files from the public examples. Do **not** commit your real keys.

1. **Install deps**
   ```powershell
   cd C:\raffle
   npm i
