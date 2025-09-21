// raffle.js — hourly draw + Telegram winner post (DexScreener price)
// Loads .env and .env.telegram, excludes team/LP, dry-run safe

import dotenv from 'dotenv';
dotenv.config({ path: '.env' });
dotenv.config({ path: '.env.telegram' });

import {
  Connection,
  PublicKey,
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
  sendAndConfirmTransaction,
  Transaction,
} from '@solana/web3.js';

// ── ENV
const RPC_URL        = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const TOKEN_MINT     = process.env.TOKEN_MINT;
const TOKEN_DECIMALS = Number(process.env.TOKEN_DECIMALS || '6');
const MIN_HOLD_USD   = Number(process.env.MIN_HOLD_USD || '20');
const MIN_HOLD_UI    = Number(process.env.MIN_HOLD_UI || '0'); // optional extra gate
const PRIZE_SOL      = Number(process.env.PRIZE_SOL || '1');
const DRY_RUN        = String(process.env.DRY_RUN || 'true').toLowerCase() === 'true';
const EXCLUDE        = new Set((process.env.EXCLUDE_ADDRESSES||'').split(',').map(s=>s.trim()).filter(Boolean));
const RUN_NOW        = String(process.env.RUN_NOW||'').trim() !== ''; // skip waiting to top-of-hour if set

// Telegram
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const CHAT_ID   = process.env.CHAT_ID || '';

// Basic guards
if (!TOKEN_MINT) throw new Error('Missing TOKEN_MINT in .env');
if (!process.env.TREASURY_SECRET_KEY) throw new Error('Missing TREASURY_SECRET_KEY in .env');

const MINT_PK  = new PublicKey(TOKEN_MINT);
const TREASURY = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.TREASURY_SECRET_KEY)));
const TREASURY_PUBKEY = TREASURY.publicKey;

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const conn = new Connection(RPC_URL, 'confirmed');
const log = (...a) => console.log(new Date().toISOString(), '-', ...a);

// ───────────────────────────────────────────────────────────────────────────────
// Price (DexScreener only)

async function fetchDexScreenerUsd(mint){
  try{
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
      headers:{ accept:'application/json' }
    });
    if (!r.ok) return null;
    const d = await r.json();
    const pairs = Array.isArray(d?.pairs) ? d.pairs : [];
    const best =
      pairs.find(p => p.chainId==='solana' && (p.quoteToken?.symbol==='USDC'||p.quoteToken?.symbol==='USDT') && p.priceUsd) ||
      pairs.find(p => p.chainId==='solana' && p.priceUsd) ||
      pairs[0];
    return best?.priceUsd ? Number(best.priceUsd) : null;
  }catch{ return null; }
}

// ───────────────────────────────────────────────────────────────────────────────
// Holders snapshot (raw account decode; stable + fast)

function readU64LE(buf, off){ return Number(buf.readBigUInt64LE(off)); }
// Token account layout: 165 bytes; [0..31]=mint, [32..63]=owner, [64..71]=amount(u64 LE)
function decodeTokenAccount(data){
  const owner  = new PublicKey(data.subarray(32, 64)).toBase58();
  const amount = readU64LE(data, 64);
  return { owner, amount };
}
async function fetchHoldersMap(){
  const res = await conn.getProgramAccounts(TOKEN_PROGRAM_ID, {
    filters: [
      { dataSize: 165 },
      { memcmp: { offset: 0, bytes: MINT_PK.toBase58() } },
    ],
    commitment: 'confirmed',
  });
  const byOwner = new Map();
  for (const { account } of res){
    const dataField = account.data;
    const data = Buffer.isBuffer(dataField)
      ? dataField
      : Array.isArray(dataField)
        ? Buffer.from(dataField[0], 'base64')
        : Buffer.from(dataField, 'base64');
    if (data.length !== 165) continue;
    const { owner, amount } = decodeTokenAccount(data);
    if (!owner || amount <= 0) continue;
    const ui = amount / Math.pow(10, TOKEN_DECIMALS);
    byOwner.set(owner, (byOwner.get(owner) || 0) + ui);
  }
  return byOwner;
}

// ───────────────────────────────────────────────────────────────────────────────
// Telegram helper

async function sendTelegram(text){
  if (!BOT_TOKEN || !CHAT_ID) return;
  try{
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true })
    });
  }catch(e){ log('telegram error', e.message); }
}
const short = a => a ? (a.slice(0,4)+'…'+a.slice(-4)) : '—';

// ───────────────────────────────────────────────────────────────────────────────
// Draw logic

function msToTopOfHour(){
  const now = new Date();
  const next = new Date(now);
  next.setMinutes(0,0,0);
  next.setHours(now.getHours()+1);
  return next - now;
}

async function pickWinner(){
  // 1) Price
  const price = await fetchDexScreenerUsd(TOKEN_MINT);
  if (!price) throw new Error('Token USD price unavailable');

  // 2) Holders
  const map = await fetchHoldersMap();

  // 3) Filter by exclusions and thresholds
  const eligible = [];
  for (const [owner, ui] of map.entries()){
    if (EXCLUDE.has(owner)) continue;
    if (ui < MIN_HOLD_UI) continue;
    const usd = ui * price;
    if (usd >= MIN_HOLD_USD) eligible.push({ owner, ui, usd });
  }

  log(`Token USD price ~ ${price.toFixed(10)}`);
  log(`Eligible wallets after filters (>= $${MIN_HOLD_USD}): ${eligible.length}`);
  if (eligible.length === 0) return null;

  // 4) Uniform random by wallet (not by balance)
  const idx = Math.floor(Math.random() * eligible.length);
  const win = eligible[idx];
  return { ...win, price };
}

async function sendPrize(toPubkey){
  const lamports = Math.round(PRIZE_SOL * LAMPORTS_PER_SOL);
  const tx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: TREASURY_PUBKEY,
    toPubkey: new PublicKey(toPubkey),
    lamports,
  }));
  const sig = await sendAndConfirmTransaction(conn, tx, [TREASURY], { commitment: 'confirmed' });
  return sig;
}

// ───────────────────────────────────────────────────────────────────────────────
// Main

(async () => {
  const mint = TOKEN_MINT;
  log(`Starting hourly draw for mint ${mint}`);
  log(`Treasury ${TREASURY_PUBKEY.toBase58()} balance ${(await conn.getBalance(TREASURY_PUBKEY))/LAMPORTS_PER_SOL} SOL`);

  // wait to top of hour unless RUN_NOW is set
  if (!RUN_NOW) {
    const ms = msToTopOfHour();
    log(`Waiting ${(ms/60000).toFixed(1)} min to top of hour…`);
    await new Promise(r => setTimeout(r, ms + 40)); // safety a few ms
  }

  try {
    const pick = await pickWinner();
    if (!pick) {
      await sendTelegram(`⚠️ <b>No eligible wallets</b> this hour. Threshold: $${MIN_HOLD_USD}.`);
      return;
    }

    const { owner, ui, usd, price } = pick;
    const lamports = Math.round(PRIZE_SOL * LAMPORTS_PER_SOL);
    const header = `🏆 <b>Hourly Winner</b> (${PRIZE_SOL} SOL)`;

    if (DRY_RUN) {
      log(`Winner picked: ${owner} (held ~${ui.toFixed(4)} tokens, est $${usd.toFixed(2)})`);
      log(`[DRY_RUN] Not sending prize. Would have sent ${PRIZE_SOL} SOL to ${owner}`);
      await sendTelegram(
        `${header}\n<code>${short(owner)}</code>\n` +
        `Hold: ~$${usd.toFixed(2)}  (px $${price.toFixed(6)})\n` +
        `<i>Dry run: prize not sent</i>`
      );
      return;
    }

    // Real send
    const sig = await sendPrize(owner);
    log(`Prize sent: ${PRIZE_SOL} SOL to ${owner}  sig ${sig}`);

    await sendTelegram(
      `${header}\n<code>${short(owner)}</code>\n` +
      `Hold: ~$${usd.toFixed(2)}  (px $${price.toFixed(6)})\n` +
      `tx: https://solscan.io/tx/${sig}`
    );
  } catch (e) {
    log('Draw error', e?.message || e);
    await sendTelegram(`❌ <b>Draw error</b>: ${String(e?.message || e)}`);
  }
})();
