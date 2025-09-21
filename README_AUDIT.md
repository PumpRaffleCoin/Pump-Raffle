# Pump Raffle — Public Audit / Transparency Notes

_Last updated: 2025-09-21_

## Treasury

- Address: `9ZTtmeF6RwxFyJ1gBK7476daP5Nf4E4mFYQYuq6SkLcZ` (read-only, pays prizes)
- Funding: Hourly top-ups from project creator rewards when available.

## Prize Logic

- Draw cadence: **Hourly** at the top of the hour (UTC of the host machine).
- Prize amount: `PRIZE_SOL` (currently 1 SOL) sent on-chain to the winner.
- Winner selection:
  1. Snapshot holders for `TOKEN_MINT`.
  2. Compute USD value (DexScreener/Jupiter price fallback).
  3. Filter **exclusions** (team/treasury/LP).
  4. Keep wallets with holdings ≥ `$MIN_HOLD_USD`.
  5. Uniform random winner from the eligible set.
- Payouts: On successful transfer, the **transaction signature** is logged and announced.

## Exclusions

- Treasury: `9ZTtmeF6RwxFyJ1gBK7476daP5Nf4E4mFYQYuq6SkLcZ`
- LP pair: `GuMAWgvmjYR5gsPQe8bWf2JiwsP1hLSQhDGWyKb6TTrj`
- Token mint (for safety): `8WgaLFmDzrRPTsa823HmJPwxwhRZh6QWGw5rmoLtpump`
- Add others as needed in `EXCLUDE_ADDRESSES`.

## Automation & Controls

- **Hands-off**: PM2-managed processes run 24/7.
- **Auto top-up**: `auto-topup-from-creator.js` claims creator rewards (when claimable) and sends SOL to the treasury, respecting:
  - `TOPUP_SOL` target per hour (e.g., 1 SOL).
  - `RESERVE_SOL` kept on the creator signer for fees.
  - `DRY_RUN` safety toggle.
- **No human picking**: Winner selection is purely programmatic.

## What we DO NOT do

- We do not reuse failed or partial snapshots.
- We do not include excluded addresses.
- We do not manually select winners.

## How to verify

- Watch the **treasury** balance and outbound txns on Solscan.
- Compare **OBS overlay** `/status` with on-chain data:
  - `vaultSol`, `runwayHours`, `lastWinner.sig`.
- Telegram posts include the tx link for every prize.

## Reproduce Locally

- Clone repo, install Node 22+, run `npm i`.
- Create `.env*` files from the examples.
- Use `DRY_RUN=true` first.
- Start via the PM2 commands in `README.md`.

> For issues or independent reviews: open a GitHub issue or email `pumprafflecoin@pm.me`.
