<div align="center">
  <h1>Pump Raffle</h1>
  <p><strong>Hands-off hourly SOL raffle for token holders</strong></p>

  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-informational"></a>
  <img alt="Node" src="https://img.shields.io/badge/Node-22%2B-blue">
  <img alt="PM2" src="https://img.shields.io/badge/PM2-managed-green">

  <!-- optional banner: put a file at docs/images/banner.png to display below -->
  <!-- <img src="docs/images/banner.png" alt="Pump Raffle banner" width="880" /> -->
</div>

## What is this?
- **Hourly draw**: snapshots token holders, excludes team/LP/treasury, keeps wallets ≥ **$MIN_HOLD_USD**, picks a random winner, and pays **PRIZE_SOL**.
- **Zero-touch ops**: Telegram announcements, live **OBS Overlay**, and **auto-top-up** of the treasury from creator rewards.
- **Transparency**: Non-custodial design; team/LP/treasury excluded. See the lightweight audit: **[docs/README_AUDIT.md](docs/README_AUDIT.md)**.

> 🛡️ **Security**: Real secrets live in local `.env` files which are git-ignored. Only example files are committed under **/examples**.

## Repo layout
