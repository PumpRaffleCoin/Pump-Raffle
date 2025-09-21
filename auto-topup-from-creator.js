// auto-topup-from-creator.js — claim Pump.fun creator rewards, then send to treasury
// Fee payer = Treasury (so creator wallet doesn't need SOL). Atomic claim+transfer.

import 'dotenv/config';
import {
  Connection, PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL,
  TransactionMessage, VersionedTransaction
} from '@solana/web3.js';

const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const TOPUP_SOL = Number(process.env.TOPUP_SOL || '1');
const INTERVAL_MS = Number(process.env.INTERVAL_MS || '3600000');
const DRY_RUN = String(process.env.DRY_RUN || 'false').toLowerCase() === 'true';

const TREASURY_PUBKEY = new PublicKey(process.env.TREASURY_PUBKEY);

// Keys
function kpFromEnv(name) {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} missing in env`);
  const arr = Uint8Array.from(JSON.parse(raw));
  return Keypair.fromSecretKey(arr);
}
const creator = kpFromEnv('CREATOR_SECRET_KEY');   // authority for claim
const treasury = kpFromEnv('TREASURY_SECRET_KEY'); // fee payer + recipient

const connection = new Connection(RPC_URL, 'confirmed');
const log = (...a)=>console.log(new Date().toISOString(), '-', ...a);

// --- IMPORTANT: You must implement/build the Pump.fun claim instruction here.
// If you already had a working claim function in your previous file, reuse it.
async function buildPumpfunClaimIx(creatorPubkey) {
  // Placeholder: return an array of claim instructions targeting Pump.fun program
  // Example:
  // return [ new TransactionInstruction({ programId: PUMPFUN_PROGRAM, keys: [...], data: ... }) ];
  // For now, we assume your previous script had this; keep it and just return it here.
  throw new Error('buildPumpfunClaimIx not implemented in this snippet — reuse your existing claim logic.');
}

// Convenience: try to estimate available rewards after claim (optional)
async function getCreatorBalanceSOL() {
  const lam = await connection.getBalance(creator.publicKey, 'confirmed');
  return lam / LAMPORTS_PER_SOL;
}

async function runOnce() {
  try {
    log('Top-up starting. Creator', creator.publicKey.toBase58(), '→ Treasury', TREASURY_PUBKEY.toBase58());

    // 1) Build instructions: claim + transfer
    const claimIxs = await buildPumpfunClaimIx(creator.publicKey); // <-- reuse your existing claim builder
    const amountLamports = Math.round(TOPUP_SOL * LAMPORTS_PER_SOL);

    const transferIx = SystemProgram.transfer({
      fromPubkey: creator.publicKey,     // funds just claimed will sit here
      toPubkey: TREASURY_PUBKEY,
      lamports: amountLamports
    });

    const ixs = [...claimIxs, transferIx];

    // 2) Build a V0 tx with fee payer = treasury (so creator doesn't need SOL for fees)
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
    const msg = new TransactionMessage({
      payerKey: treasury.publicKey,       // fee payer is treasury
      recentBlockhash: blockhash,
      instructions: ixs
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);

    // Sign with BOTH: creator (claim + transfer), treasury (fee payer)
    tx.sign([treasury, creator]);

    if (DRY_RUN) {
      log('[DRY_RUN] Would send claim+transfer of', TOPUP_SOL.toFixed(4), 'SOL');
      return;
    }

    const sig = await connection.sendTransaction(tx, { maxRetries: 3 });
    const conf = await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      'confirmed'
    );
    log(`Sent ${TOPUP_SOL.toFixed(4)} SOL to treasury. sig ${sig} · status ${conf.value.err ? 'ERR' : 'OK'}`);

  } catch (e) {
    log('Top-up error', e.message);
  }
}

function schedule() {
  // Align to top of hour
  const now = new Date();
  const next = new Date(now);
  next.setMinutes(0,0,0);
  if (next <= now) next.setHours(now.getHours()+1);
  const ms = next - now;
  log(`Scheduling first run at top of hour in ${(ms/60000).toFixed(1)} min…`);
  setTimeout(async () => {
    await runOnce();
    setInterval(runOnce, INTERVAL_MS);
  }, ms);
}

(async () => {
  try {
    const bal = await getCreatorBalanceSOL();
    log('Creator current SOL balance:', bal.toFixed(6));
  } catch {}
  schedule();
})();
