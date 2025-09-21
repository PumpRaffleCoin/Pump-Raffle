import 'dotenv/config';
import { Telegraf } from 'telegraf';
import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';

// Token Program IDs
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

// ENV
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const TOKEN_MINT = new PublicKey(process.env.TOKEN_MINT);
const TREASURY_PUBKEY = new PublicKey(process.env.TREASURY_PUBKEY);
const MIN_HOLD_USD = Number(process.env.MIN_HOLD_USD || '20');
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;

if (!TG_TOKEN || !TG_CHAT) throw new Error('Missing Telegram envs');

const bot = new Telegraf(TG_TOKEN);
const connection = new Connection(RPC_URL, 'confirmed');

function log(...args) { console.log(new Date().toISOString(), '-', ...args); }

async function getUsdPrice(mint) {
  try {
    const u = `https://lite-api.jup.ag/price/v3?ids=${mint.toBase58()}`;
    const res = await fetch(u);
    if (!res.ok) return null;
    const j = await res.json();
    const entry = j[mint.toBase58()] || j.data?.[mint.toBase58()];
    const price = entry?.usdPrice ?? entry?.price ?? null;
    return typeof price === 'number' ? price : null;
  } catch { return null; }
}

async function getEligibleHolderCount(programId) {
  const filters = [
    { dataSize: 165 },
    { memcmp: { offset: 0, bytes: TOKEN_MINT.toBase58() } },
  ];
  const accounts = await connection.getParsedProgramAccounts(programId, { filters });
  const price = await getUsdPrice(TOKEN_MINT);
  if (price == null) return { count: 0, price: null };

  const holders = new Map();
  for (const acc of accounts) {
    const info = acc.account.data.parsed?.info;
    if (!info) continue;
    const owner = info.owner;
    const tokenAmount = info.tokenAmount;
    if (!owner || !tokenAmount) continue;
    const ui = Number(tokenAmount.uiAmount);
    if (!Number.isFinite(ui)) continue;
    holders.set(owner, (holders.get(owner) || 0) + ui);
  }
  const eligible = Array.from(holders.values()).filter(ui => (ui * price) >= MIN_HOLD_USD).length;
  return { count: eligible, price };
}

async function getEligibleHolderCountAny() {
  let res = await getEligibleHolderCount(TOKEN_PROGRAM_ID);
  if (res.count === 0 && res.price !== null) {
    const res2 = await getEligibleHolderCount(TOKEN_2022_PROGRAM_ID);
    return res2.price === null ? res : res2;
  }
  return res;
}

// Track recent payout announcements to avoid duplicates
const announced = new Set();

async function checkForPayouts() {
  try {
    const sigs = await connection.getSignaturesForAddress(TREASURY_PUBKEY, { limit: 20 });
    for (const s of sigs) {
      if (announced.has(s.signature)) continue;
      const tx = await connection.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
      if (!tx) continue;
      const blockTime = (tx.blockTime || 0) * 1000;
      if (Date.now() - blockTime > 15 * 60 * 1000) continue; // only last 15 min

      const transfers = [];
      for (const inst of tx.transaction.message.instructions) {
        const parsed = inst;
        if (parsed?.program === 'system' && parsed.parsed?.type === 'transfer') {
          const info = parsed.parsed.info;
          if (info?.source === TREASURY_PUBKEY.toBase58()) {
            transfers.push({ to: info.destination, lamports: Number(info.lamports) });
          }
        }
      }
      // Look for ~1 SOL transfers (allow small drift)
      const hit = transfers.find(t => Math.abs(t.lamports - LAMPORTS_PER_SOL) < 5000);
      if (hit) {
        const msg = `🎉 Hourly Raffle Payout Detected\nWinner: <code>${hit.to}</code>\nAmount: 1 SOL\nTx: https://solscan.io/tx/${s.signature}`;
        await bot.telegram.sendMessage(TG_CHAT, msg, { parse_mode: 'HTML' });
        announced.add(s.signature);
        log('Announced payout', s.signature);
      }
    }
  } catch (e) {
    log('checkForPayouts error', e.message);
  }
}

function msUntilNextTopOfHour() {
  const now = new Date();
  const next = new Date(now);
  next.setMinutes(0, 0, 0);
  next.setHours(now.getHours() + 1);
  return next.getTime() - now.getTime();
}

async function postCountdownAndMilestone() {
  const { count, price } = await getEligibleHolderCountAny();
  const mins = Math.round(msUntilNextTopOfHour() / 60000);
  const priceStr = price ? `$${price.toFixed(6)}` : '(price unavailable)';
  const text = `⏰ Next draw in ~${mins} min\nEligible holders (≥ $${MIN_HOLD_USD}): <b>${count}</b>\nToken price: ${priceStr}`;
  await bot.telegram.sendMessage(TG_CHAT, text, { parse_mode: 'HTML' });
}

async function main() {
  log('Starting Launch Companion bot…');
  await postCountdownAndMilestone();
  // Every minute: check payouts; Every 5 min: refresh countdown/milestone
  setInterval(checkForPayouts, 60 * 1000);
  setInterval(postCountdownAndMilestone, 5 * 60 * 1000);
}

main().catch(e => { console.error(e); process.exit(1); });
