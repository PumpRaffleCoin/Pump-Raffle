// eligibility-watcher.js — DexScreener-only price, Telegram + OBS announce, 429/backoff-safe holder scan
import dotenv from 'dotenv';
dotenv.config({ path: '.env' });
dotenv.config({ path: '.env.telegram' });

import { Connection, PublicKey } from '@solana/web3.js';
import fs from 'node:fs';

// ── ENV
const RPC_URL        = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const TOKEN_MINT     = process.env.TOKEN_MINT;
const TOKEN_DECIMALS = Number(process.env.TOKEN_DECIMALS || '6');
const MIN_HOLD_USD   = Number(process.env.MIN_HOLD_USD || '20');  // eligibility threshold
const MIN_BUY_USD    = Number(process.env.MIN_BUY_USD || '20');   // announce buys >= this USD delta
const EXCLUDE        = new Set((process.env.EXCLUDE_ADDRESSES || '').split(',').map(s=>s.trim()).filter(Boolean));
const ELIGIBLE_CACHE = process.env.ELIGIBLE_CACHE || 'eligible.json';
const OVERLAY_URL    = process.env.OVERLAY_URL || 'http://127.0.0.1:8090';
const BOT_TOKEN      = process.env.BOT_TOKEN || '';
const CHAT_ID        = process.env.CHAT_ID || '';
const POLL_MS        = Number(process.env.POLL_MS || '90000');     // 90s between scans (plus jitter)
const JITTER_MS      = Math.floor(Math.random() * 8000);
const MAX_BACKOFF_MS = 5 * 60_000;

if (!TOKEN_MINT) throw new Error('TOKEN_MINT missing in .env');

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const MINT_PK          = new PublicKey(TOKEN_MINT);
const conn             = new Connection(RPC_URL, 'confirmed');
const log = (...a) => console.log(new Date().toISOString(), '-', ...a);

// ── PRICE (DexScreener only)
async function fetchDexScreenerUsd(mint){
  try{
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
      headers:{ 'accept':'application/json' }
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
async function fetchUsdPriceRobust(mint/*, decimals */){
  // DexScreener only (network allows it; Jupiter blocked on your machine)
  const ds = await fetchDexScreenerUsd(mint);
  return ds ?? null;
}

// ── Telegram + Overlay
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
async function announceOverlay(evt){
  try{
    await fetch(`${OVERLAY_URL}/announce`, {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify(evt)
    });
  }catch{}
}
const short = a => a ? (a.slice(0,4)+'…'+a.slice(-4)) : '—';

// ── Raw token holder scan (no parsed accounts)
function readU64LE(buf, off){ return Number(buf.readBigUInt64LE(off)); }
// Token account: 165 bytes; [0..31]=mint, [32..63]=owner, [64..71]=amount(u64 LE)
function decodeTokenAccount(data){
  const owner = new PublicKey(data.subarray(32, 64)).toBase58();
  const amount = readU64LE(data, 64);
  return { owner, amount };
}

async function fetchHoldersRaw(){
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

// ── Main loop with single-flight + backoff on transient errors
let prev = new Map();   // owner -> ui
let running = false;
let backoffMs = 0;
let nextAllowedAt = 0;

async function loop(){
  if (running) return;
  const now = Date.now();
  if (now < nextAllowedAt) return;
  running = true;

  try{
    const price = await fetchUsdPriceRobust(TOKEN_MINT, TOKEN_DECIMALS);
    if (!price){ log('price unavailable'); return; }

    const nowMap = await fetchHoldersRaw();
    const eligRows = [];

    for (const [owner, ui] of nowMap.entries()){
      const usd = ui * price;
      if (!EXCLUDE.has(owner) && usd >= MIN_HOLD_USD) eligRows.push({ owner, ui, usd });

      const old = prev.get(owner) || 0;
      const deltaUi = ui - old;
      if (deltaUi > 0){
        const deltaUsd = deltaUi * price;

        if (!EXCLUDE.has(owner) && deltaUsd >= MIN_BUY_USD){
          const msg = `🟢 <b>Buy</b> +$${deltaUsd.toFixed(2)} by <code>${short(owner)}</code>\nNow holding ~$${(ui*price).toFixed(2)}\nhttps://solscan.io/account/${owner}`;
          log('BUY', short(owner), `+$${deltaUsd.toFixed(2)} (now $${(ui*price).toFixed(2)})`);
          await sendTelegram(msg);
          await announceOverlay({ type:'buy', owner, usd: ui*price, delta: deltaUsd, ts: Date.now() });
        }

        const oldUsd = old * price;
        if (oldUsd < MIN_HOLD_USD && (ui*price) >= MIN_HOLD_USD && !EXCLUDE.has(owner)){
          const msg = `✅ <b>New Eligible</b> ${short(owner)} (now ~$${(ui*price).toFixed(2)})`;
          await sendTelegram(msg);
          await announceOverlay({ type:'join', owner, usd: ui*price, delta: deltaUi*price, ts: Date.now() });
        }
      }
    }

    try { fs.writeFileSync(ELIGIBLE_CACHE, JSON.stringify(eligRows), 'utf8'); } catch {}
    prev = nowMap;

    // success → relax backoff
    backoffMs = Math.max(0, Math.floor(backoffMs / 2));
    log(`Eligible now: ${eligRows.length}  • price $${price.toFixed(6)}`);
  }catch(e){
    const msg = String(e?.message || e);
    const transient =
      msg.includes('429') ||
      msg.includes('fetch failed') ||
      msg.includes('ENOTFOUND') ||
      msg.includes('ECONNRESET') ||
      msg.includes('ETIMEDOUT');

    if (transient) {
      backoffMs = backoffMs ? Math.min(backoffMs * 2, MAX_BACKOFF_MS) : 30_000;
      nextAllowedAt = Date.now() + backoffMs;
      log(`loop transient error — ${msg} — backing off ${Math.round(backoffMs/1000)}s`);
    } else {
      log('loop error', msg);
    }
  }finally{
    running = false;
  }
}

// start with jitter so multiple procs never align
setInterval(loop, POLL_MS + JITTER_MS);
loop();
