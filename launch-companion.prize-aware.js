// Track announced txs
const announcedPrizes = new Set();
const announcedAlerts = new Set();

async function checkForPayouts() {
  try {
    const sigs = await connection.getSignaturesForAddress(TREASURY_PUBKEY, { limit: 30 });
    const target = Math.round(PRIZE_SOL * LAMPORTS_PER_SOL);
    const tol = Math.max(5000, Math.floor(target * 0.001)); // 0.1% or 5k lamports
    const alertMin = 50_000; // ~0.00005 SOL: ignore dust

    for (const s of sigs) {
      const sig = s.signature;
      const tx = await connection.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 });
      if (!tx) continue;

      const t = (tx.blockTime || 0) * 1000;
      if (Date.now() - t > 30 * 60 * 1000) continue; // last 30 min

      // find SOL transfers from treasury
      const out = [];
      for (const inst of tx.transaction.message.instructions) {
        if (inst?.program === 'system' && inst.parsed?.type === 'transfer') {
          const info = inst.parsed.info;
          if (info?.source === TREASURY_PUBKEY.toBase58()) {
            out.push({ to: info.destination, lamports: Number(info.lamports) });
          }
        }
      }
      if (out.length === 0) continue;

      // Prize hit
      const prize = out.find(t => Math.abs(t.lamports - target) <= tol);
      if (prize && !announcedPrizes.has(sig)) {
        await bot.telegram.sendMessage(
          TG_CHAT,
          `🎉 Hourly Raffle Payout\nWinner: <code>${prize.to}</code>\nAmount: ${PRIZE_SOL} SOL\nTx: https://solscan.io/tx/${sig}`,
          { parse_mode: 'HTML' }
        );
        announcedPrizes.add(sig);
        continue;
      }

      // Non-prize alert (any other outbound ≥ alertMin)
      const bad = out.find(t => !prize && t.lamports >= alertMin);
      if (bad && !announcedAlerts.has(sig)) {
        const amt = (bad.lamports / LAMPORTS_PER_SOL).toFixed(6);
        await bot.telegram.sendMessage(
          TG_CHAT,
          `⚠️ NON-PRIZE TRANSFER DETECTED\nFrom treasury → <code>${bad.to}</code>\nAmount: ${amt} SOL\nTx: https://solscan.io/tx/${sig}\n\nPolicy breach: only hourly prize transfers are allowed.`,
          { parse_mode: 'HTML' }
        );
        announcedAlerts.add(sig);
      }
    }
  } catch (e) {
    log('checkForPayouts error', e.message);
  }
}
