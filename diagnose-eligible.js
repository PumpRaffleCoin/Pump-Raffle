import 'dotenv/config';
import {
  Connection,
  PublicKey,
} from '@solana/web3.js';

const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const TOKEN_MINT = new PublicKey(process.env.TOKEN_MINT);
const MIN_HOLD_USD = Number(process.env.MIN_HOLD_USD || '20');
const MIN_HOLD_UI = Number(process.env.MIN_HOLD_UI || '0');
const EXCLUDE_ADDRESSES = (process.env.EXCLUDE_ADDRESSES || '').split(',').map(s => s.trim()).filter(Boolean);

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

const connection = new Connection(RPC_URL, 'confirmed');
function log(...args){ console.log(new Date().toISOString(), '-', ...args); }

async function getUsdPrice(mint){
  try{
    const u = `https://lite-api.jup.ag/price/v3?ids=${mint.toBase58()}`;
    const r = await fetch(u);
    if(!r.ok) return null;
    const j = await r.json();
    const e = j[mint.toBase58()] || j.data?.[mint.toBase58()];
    const price = e?.usdPrice ?? e?.price ?? null;
    return typeof price === 'number' ? price : null;
  }catch{ return null; }
}

async function holderMap(programId){
  const filters = [ { dataSize:165 }, { memcmp:{ offset:0, bytes: TOKEN_MINT.toBase58() } } ];
  const accs = await connection.getParsedProgramAccounts(programId, { filters });
  const m = new Map();
  for(const a of accs){
    const info = a.account.data.parsed?.info; if(!info) continue;
    const owner = info.owner; const ta = info.tokenAmount; if(!owner || !ta) continue;
    const ui = Number(ta.uiAmount); if(!Number.isFinite(ui)) continue;
    m.set(owner, (m.get(owner)||0) + ui);
  }
  return m;
}

function fmt(n){ return Number(n).toLocaleString('en-GB', { maximumFractionDigits: 6 }); }

async function main(){
  const price = await getUsdPrice(TOKEN_MINT);
  if(price == null) {
    log('No USD price available. You can set MIN_HOLD_USD=0 and MIN_HOLD_UI to a token amount temporarily.');
  } else {
    log('Token price (USD):', price);
  }

  let holders = await holderMap(TOKEN_PROGRAM_ID);
  if(holders.size === 0){
    holders = await holderMap(TOKEN_2022_PROGRAM_ID);
  }
  const arr = Array.from(holders.entries()).map(([owner, ui]) => ({ owner, ui, usd: price ? ui*price : null }));

  // Sort by usd if price exists, else by ui
  arr.sort((a,b) => (b.usd ?? b.ui) - (a.usd ?? a.ui));

  const filtered = arr.filter(h =>
    !EXCLUDE_ADDRESSES.includes(h.owner) &&
    (MIN_HOLD_UI > 0 ? h.ui >= MIN_HOLD_UI : true) &&
    (price && MIN_HOLD_USD > 0 ? (h.usd >= MIN_HOLD_USD) : true)
  );

  console.log('\n=== Top Holders (first 25) ===');
  for(const h of (filtered.length ? filtered : arr).slice(0,25)){
    const line = `${h.owner}  |  tokens=${fmt(h.ui)}  |  ${h.usd!=null ? ('$'+fmt(h.usd)) : '(no USD price)'}${EXCLUDE_ADDRESSES.includes(h.owner) ? '  [EXCLUDED]' : ''}`;
    console.log(line);
  }

  console.log('\nEligible count:', filtered.length);
  if(filtered[0]){
    console.log('Likely current winner if drawn now:', filtered[0].owner);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
