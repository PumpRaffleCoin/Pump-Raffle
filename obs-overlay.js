// obs-overlay.js — overlay server (DexScreener-only price), /status + /announce + /big UI
import 'dotenv/config';
import express from 'express';
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import fs from 'node:fs';

// ── ENV
const PORT            = Number(process.env.OVERLAY_PORT || process.env.PORT || '8090');
const RPC_URL         = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const TOKEN_MINT      = process.env.TOKEN_MINT || '';
const TOKEN_DECIMALS  = Number(process.env.TOKEN_DECIMALS || '6');
const MIN_HOLD_USD    = Number(process.env.MIN_HOLD_USD || '20');
const PRIZE_SOL       = Number(process.env.PRIZE_SOL || '1');
const EXCLUDE         = (process.env.EXCLUDE_ADDRESSES || '').split(',').map(s=>s.trim()).filter(Boolean);
const ELIGIBLE_CACHE  = process.env.ELIGIBLE_CACHE || 'eligible.json';
const PRICE_MS        = Number(process.env.PRICE_MS || '7000'); // set to 2000 in .env.overlay for 2s

let TREASURY_PUBKEY;
try { TREASURY_PUBKEY = new PublicKey(process.env.TREASURY_PUBKEY); }
catch (e) { console.error('Invalid TREASURY_PUBKEY:', e.message); process.exit(1); }
if (!TOKEN_MINT) { console.error('Missing TOKEN_MINT'); process.exit(1); }

const connection = new Connection(RPC_URL, 'confirmed');
const log = (...a) => console.log(new Date().toISOString(), '-', ...a);

// ── STATE
const s = {
  minHoldUsd: MIN_HOLD_USD,
  prizeSol: PRIZE_SOL,
  usdPrice: null,
  vaultSol: null,
  runwayHours: null,
  eligible: null,
  lastWinner: null, // { to, sig }
  joinFeed: [],     // manual/auto toasts
};

// ── PRICE (DexScreener only)
async function fetchDexScreenerUsd(mint){
  try {
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
  } catch { return null; }
}
let lastPrice = null, lastPriceTs = 0;
async function ensurePrice(){
  const now = Date.now();
  if (now - lastPriceTs > PRICE_MS) {
    lastPrice = TOKEN_MINT ? await fetchDexScreenerUsd(TOKEN_MINT) : null;
    lastPriceTs = now;
    if (lastPrice) log('USD price', lastPrice.toFixed(10), 'for', TOKEN_MINT);
    else log('USD price unavailable for', TOKEN_MINT);
  }
  s.usdPrice = lastPrice;
}

// ── TREASURY BALANCE / RUNWAY (slow to avoid 429s)
async function ensureVault(){
  try {
    const lam = await connection.getBalance(TREASURY_PUBKEY, 'confirmed');
    const sol = lam / LAMPORTS_PER_SOL;
    s.vaultSol = sol;
    s.runwayHours = (PRIZE_SOL > 0) ? Math.floor(sol / PRIZE_SOL) : null;
  } catch(e) { log('ensureVault', e.message); }
}

// ── LAST WINNER (slow to avoid 429s)
async function ensureLastWinner(){
  try {
    const sigs = await connection.getSignaturesForAddress(TREASURY_PUBKEY, { limit: 20 });
    const target = Math.round(PRIZE_SOL * LAMPORTS_PER_SOL);
    const tol = Math.max(5000, Math.floor(target * 0.001));
    for (const sgn of sigs) {
      const tx = await connection.getParsedTransaction(sgn.signature, { maxSupportedTransactionVersion: 0 });
      if (!tx) continue;
      for (const inst of tx.transaction.message.instructions) {
        if (inst?.program === 'system' && inst.parsed?.type === 'transfer') {
          const info = inst.parsed.info;
          if (info?.source === TREASURY_PUBKEY.toBase58()) {
            const lamports = Number(info.lamports);
            if (Math.abs(lamports - target) <= tol) {
              s.lastWinner = { to: info.destination, sig: sgn.signature };
              return;
            }
          }
        }
      }
    }
  } catch(e){ log('ensureLastWinner', e.message); }
}

// ── ELIGIBLE (from cache written by watcher)
function ensureEligibleFromCache(){
  try{
    if (!fs.existsSync(ELIGIBLE_CACHE)) return;
    const raw = JSON.parse(fs.readFileSync(ELIGIBLE_CACHE,'utf8'));
    if (Array.isArray(raw)) {
      const excl = new Set(EXCLUDE);
      const price = s.usdPrice || 0;
      let count = 0;
      for (const r of raw){
        const owner = r.owner || r.address || r.wallet;
        const ui = Number(r.ui ?? r.amount ?? 0);
        const usd = (r.usd != null) ? Number(r.usd) : (price ? (ui * price) : 0);
        if (!owner || excl.has(owner)) continue;
        if (usd >= MIN_HOLD_USD) count++;
      }
      s.eligible = count;
    }
  } catch {}
}

// ── JOBS (price fast via HTTP; RPC slower)
setInterval(ensurePrice, PRICE_MS);           ensurePrice();        // HTTP only
setInterval(ensureVault, 45_000);             ensureVault();        // RPC every 45s
setInterval(ensureLastWinner, 120_000);       ensureLastWinner();   // RPC every 2m
setInterval(ensureEligibleFromCache, 12_000); ensureEligibleFromCache();

const app = express();
app.use(express.json());

// JSON status
app.get('/status', (req,res) => res.json(s));

// Main overlay UI
const OVERLAY_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RAFFLE — Overlay</title>
<style>
:root{ --bg: rgba(0,0,0,0); --card: rgba(0,0,0,0.40); --muted:#b7eaff; --fg:#fff; --accent:#00d1ff; --glow:0 0 18px rgba(0,209,255,.55); --radius:18px; --pad:16px; --gap:16px; --scale:1; }
html,body{margin:0;padding:0;background:var(--bg);color:var(--fg);font-family:ui-sans-serif,system-ui,Segoe UI,Roboto,Helvetica,Arial;}
.root{ transform: scale(var(--scale)); transform-origin: top left; }
.wrap{ display:grid; grid-template-columns: 1.6fr 1fr 1fr 1.1fr; gap: var(--gap); padding: var(--pad); align-items:stretch; }
.card{ background:var(--card); border-radius:var(--radius); padding:14px 16px; box-shadow: 0 6px 26px rgba(0,0,0,.28), var(--glow); position:relative; overflow:hidden; }
.title{ color:var(--muted); font-weight:700; letter-spacing:.35px; margin-bottom:8px; font-size:14px; }
.value{ font-weight:800; font-size:34px; letter-spacing:.6px; }
.sub{ font-size:14px; opacity:.9; }
.prize{ grid-column: span 2; display:grid; grid-template-columns:auto 1fr; gap:18px; align-items:center; }
.prize .big{ font-size:52px; text-shadow: 0 0 18px rgba(0,209,255,.55); }
.glow{ color:var(--accent); } .badge{ display:inline-block; font-size:12px; padding:4px 8px; border-radius:999px; background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.18); margin-left:8px; }
.ring{ width:86px; height:86px; position:relative; } .ring svg{ position:absolute; inset:0; } .ring .t{ position:absolute; inset:0; display:flex; align-items:center; justify-content:center; font-weight:800; }
.winner{ grid-column: 1 / -1; display:flex; align-items:center; gap:14px; padding:12px 14px; }
.winner .addr{ font-weight:800; font-size:22px; } .winner .tx a{ color:var(--accent); text-decoration:none; }
.toastwrap{ position:absolute; right:16px; bottom:16px; display:flex; flex-direction:column; gap:10px; }
.toast{ background:rgba(0,0,0,0.55); border:1px solid rgba(255,255,255,0.18); border-radius:14px; padding:10px 14px; box-shadow: var(--glow); opacity:0; transform: translateY(8px); transition: all 240ms ease; font-weight:700; }
.toast.show{ opacity:1; transform: translateY(0); }
.flash{ position:absolute; inset:0; pointer-events:none; background:radial-gradient(ellipse at center, rgba(255,255,255,.35), rgba(255,255,255,0)); opacity:0; }
.flash.show{ animation: flash 900ms ease; } @keyframes flash { 0%{opacity:.0} 20%{opacity:.9} 100%{opacity:0} }
@media (max-width:1200px){ .wrap{ grid-template-columns:1.4fr 1fr; } .prize{ grid-column: 1 / -1; } }
</style>
</head>
<body>
<div class="root"><div class="wrap">
  <div class="card prize">
    <div class="ring">
      <svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="17" stroke="rgba(255,255,255,.15)" stroke-width="4" fill="none"/>
        <circle id="ring" cx="20" cy="20" r="17" stroke="var(--accent)" stroke-width="4" fill="none" stroke-linecap="round" stroke-dasharray="106.81" stroke-dashoffset="0"/></svg>
      <div class="t" id="count">--:--</div>
    </div>
    <div>
      <div class="title">Next Draw</div>
      <div class="value big">Prize <span class="glow" id="prize">—</span><span class="badge">hourly</span></div>
      <div class="sub">Snapshot at top of hour · Team / Treasury / LP excluded</div>
    </div>
    <div class="flash" id="flash"></div>
  </div>
  <div class="card"><div class="title">Eligible (≥ $<span id="min">20</span>)</div><div class="value" id="eligible">0</div><div class="sub">Holding at draw time</div></div>
  <div class="card"><div class="title">Price</div><div class="value" id="price">$–.--</div><div class="sub">DexScreener feed</div></div>
  <div class="card"><div class="title">Vault / Runway</div><div class="value" id="runway">– / –h</div><div class="sub">Auto top-ups from creator rewards</div></div>
  <div class="card winner"><div class="title">Last Winner</div><div class="addr" id="winner">—</div><div class="tx" id="tx"> </div></div>
  <div class="toastwrap" id="toasts"></div>
</div></div>
<script>
const qp = new URLSearchParams(location.search);
const accent = qp.get('accent'); const scale = parseFloat(qp.get('scale') || '1');
if(accent) document.documentElement.style.setProperty('--accent', accent);
if(!Number.isNaN(scale)) document.documentElement.style.setProperty('--scale', scale);
const $ = s => document.getElementById(s);
const short = a => a ? (a.slice(0,4)+'…'+a.slice(-4)) : '—';
function nextTopOfHour(){ const now=new Date(); const next=new Date(now); next.setMinutes(0,0,0); next.setHours(now.getHours()+1); return next; }
function updateCountdown(){ const now=new Date(), next=nextTopOfHour(), ms=next-now; const m=Math.max(0,Math.floor(ms/60000)), s=Math.max(0,Math.floor((ms%60000)/1000)); $('count').textContent = String(m).padStart(2,'0')+':'+String(s).padStart(2,'0'); const total=3600, remaining=Math.max(0,Math.floor(ms/1000)), frac=1-(remaining/total), C=2*Math.PI*17; document.getElementById('ring').setAttribute('stroke-dashoffset', String((1-frac)*C)); }
setInterval(updateCountdown, 500); updateCountdown();
let lastSig='', lastJoinTs=0;
function toast(text){ const box=$('toasts'); const t=document.createElement('div'); t.className='toast'; t.textContent=text; box.appendChild(t); requestAnimationFrame(()=>t.classList.add('show')); setTimeout(()=>{ t.classList.remove('show'); setTimeout(()=>t.remove(),240); }, 4200); }
async function poll(){
  try{
    const r=await fetch('/status',{cache:'no-store'}); const s=await r.json();
    $('min').textContent = (s.minHoldUsd ?? 20);
    $('eligible').textContent = (s.eligible ?? 0);
    $('price').textContent = (s.usdPrice ? '$'+Number(s.usdPrice).toFixed(6) : '$–.--');
    $('prize').textContent = (s.prizeSol ? s.prizeSol + ' SOL' : '—');
    $('runway').textContent = (s.vaultSol!=null ? s.vaultSol.toFixed(2)+' SOL' : '–') + ' / ' + (s.runwayHours!=null ? s.runwayHours+'h' : '–');
    const w=s.lastWinner; if(w && w.sig){ $('winner').textContent=short(w.to); $('tx').innerHTML='· <a target="_blank" href="https://solscan.io/tx/'+w.sig+'">tx</a>'; if(w.sig!==lastSig){ lastSig=w.sig; const f=document.getElementById('flash'); f.classList.remove('show'); void f.offsetWidth; f.classList.add('show'); } } else { $('winner').textContent='—'; $('tx').textContent=''; }
    if (Array.isArray(s.joinFeed)) {
      for (const it of s.joinFeed) {
        if (it.ts && it.ts > lastJoinTs) {
          const text = (it.type==='buy') ? ('🟢 Buy $'+Number(it.delta||0).toFixed(2)+' — '+short(it.owner)+' (now $'+Number(it.usd||0).toFixed(2)+')') : ('✅ New Eligible — '+short(it.owner)+' ($'+Number(it.usd||0).toFixed(2)+')');
          toast(text); lastJoinTs = it.ts;
        }
      }
    }
  }catch(e){}
}
setInterval(poll, 1500); poll();
</script>
</body></html>`;
app.get('/', (req,res) => res.type('html').send(OVERLAY_HTML));

// BIG banner (separate movable source)
const BIG_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Raffle — Big Announce</title><style>:root{ --scale:1; --accent:#00d1ff; --fg:#fff; --bg:rgba(0,0,0,0); }html,body{margin:0;padding:0;background:var(--bg);color:var(--fg);font-family:ui-sans-serif,system-ui,Segoe UI,Roboto,Helvetica,Arial;}.root{ transform: scale(var(--scale)); transform-origin: top left; padding:10px; }.box{ display:inline-flex; align-items:center; gap:14px; padding:16px 20px; border-radius:20px; background:rgba(0,0,0,.60); border:1px solid rgba(255,255,255,.18); box-shadow:0 10px 30px rgba(0,0,0,.35), 0 0 28px rgba(0,209,255,.55); }.kind{ font-weight:900; font-size:32px; letter-spacing:.3px; color:var(--accent); }.text{ font-weight:800; font-size:44px; letter-spacing:.5px; }.wrap{ opacity:0; transform:translateY(8px); transition:all .24s ease; display:inline-block; }.wrap.show{ opacity:1; transform:translateY(0); }</style></head><body><div class="root"><div id="wrap" class="wrap"><div class="box"><div id="kind" class="kind">—</div><div id="msg" class="text">—</div></div></div></div><script>var qp=new URLSearchParams(location.search);var scale=parseFloat(qp.get('scale')||'1');if(!isNaN(scale))document.documentElement.style.setProperty('--scale',scale);var accent=qp.get('accent');if(accent){document.documentElement.style.setProperty('--accent',accent)}var typeFilter=(qp.get('type')||'').toLowerCase();var dur=parseInt(qp.get('dur')||'6000');if(isNaN(dur))dur=6000;var lastTs=0;function short(a){return a?(a.slice(0,4)+'…'+a.slice(-4)):'—'}function show(kind,text){var w=document.getElementById('wrap');var k=document.getElementById('kind');var m=document.getElementById('msg');k.textContent=kind;m.textContent=text;w.classList.add('show');clearTimeout(window.__hideT);window.__hideT=setTimeout(function(){w.classList.remove('show')},dur)}async function poll(){try{var r=await fetch('/status',{cache:'no-store'});var s=await r.json();if(Array.isArray(s.joinFeed)){for(var i=0;i<s.joinFeed.length;i++){var it=s.joinFeed[i];if(!it.ts||it.ts<=lastTs)continue;var t=(it.type||'').toLowerCase();if(typeFilter&&t!==typeFilter){lastTs=it.ts;continue}if(t==='buy'){show('BUY', '$'+Number(it.delta||0).toFixed(2)+' — '+short(it.owner)+' (now $'+Number(it.usd||0).toFixed(2)+')')}else{show('ELIGIBLE', short(it.owner)+' ($'+Number(it.usd||0).toFixed(2)+')')}lastTs=it.ts}}}catch(e){}}setInterval(poll,800);poll();</script></body></html>`;
app.get('/big', (req,res) => res.type('html').send(BIG_HTML));

// Manual announce (toasts/banners) from other processes
app.post('/announce', (req,res) => {
  const { type, owner, usd, delta } = req.body || {};
  if (owner) {
    s.joinFeed.push({ type: type||'join', owner, usd: Number(usd||0), delta: Number(delta||0), ts: Date.now() });
    if (s.joinFeed.length > 50) s.joinFeed.splice(0, s.joinFeed.length - 50);
  }
  res.json({ ok: true });
});

app.listen(PORT, () => log('OBS overlay listening on http://localhost:'+PORT));
