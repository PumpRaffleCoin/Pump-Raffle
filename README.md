# Pump Raffle — Hourly SOL Raffle for Token Holders

Public repo for the Pump Raffle system. It runs a **hands-off hourly raffle** for token holders who meet a $MIN_HOLD_USD threshold, **announces winners to Telegram**, and provides a **live OBS overlay**. A separate top-up bot can fund the treasury automatically using creator rewards.

> **Security**: Real secrets live in local `.env` files which are **git-ignored**. Only the `*.example` files are committed.

## What it does

- **Hourly draw** (`raffle.js`): at the top of each hour, snapshot holders, filter out team/LP/treasury, keep wallets with holdings ≥ $MIN_HOLD_USD, pick a random winner, and (if not in DRY_RUN) pay `PRIZE_SOL`.
- **Telegram announcer** (`launch-companion.prize-aware.js` + `eligibility-watcher.js`): posts winner, count-downs, and can post **buy/eligibility** events.
- **OBS overlay** (`obs-overlay.js`): browser source that shows **countdown, eligible count, price, vault/runway, last winner**, plus big toasts (/toast).
- **Auto top-up** (`auto-topup-from-creator.js`): claims creator rewards (when available) and transfers SOL to the **treasury** hourly.

## Quick start

1. **Install**
   - Node 22+, Git, PM2
   - `npm i`

2. **Create private envs (not committed)**
   - Copy from examples: `.env`, `.env.overlay`, `.env.telegram`, `.env.topup`
   - Fill in values. **Never commit real private keys.**

3. **Run with PM2 (Windows examples)**
```powershell
npx pm2@latest start raffle.js --name sol-hourly-raffle --cwd C:\raffle
npx pm2@latest start launch-companion.prize-aware.js --name raffle-telegram --cwd C:\raffle --node-args="--env-file=.env.telegram"
npx pm2@latest start obs-overlay.js --name raffle-overlay --cwd C:\raffle --node-args="--env-file=.env.overlay"
npx pm2@latest start eligibility-watcher.js --name raffle-elig-watcher --cwd C:\raffle --node-args="--env-file=.env"
npx pm2@latest start auto-topup-from-creator.js --name raffle-topup --cwd C:\raffle --node-args="--env-file=.env.topup"
npx pm2@latest save
```

4. **OBS**
   - Add a **Browser Source** pointing to:
     - Main overlay: `http://localhost:8090/?scale=1&accent=%2300d1ff`
     - Big toasts only: `http://localhost:8090/toast?scale=1.2`
   - Test toast from PowerShell:
```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8090/announce `
  -ContentType 'application/json' `
  -Body '{"type":"buy","owner":"TestWallet","usd":25.00,"delta":25.00}'
```

5. **Telegram**
   - Create a bot with BotFather, add it to your channel, make it admin.
   - Set `BOT_TOKEN` and `CHAT_ID` in `.env.telegram`.

6. **Transparency**
   - Keep `README_AUDIT.md` updated with treasury address, rules, exclusions, draw logic, and how top-ups work.
