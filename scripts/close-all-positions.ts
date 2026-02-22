/**
 * close-all-positions.ts
 *
 * Emergency recovery script: force-close all open positions recorded in the
 * positions file, using actual on-chain token balances.
 *
 * Usage (on VPS):
 *   npx tsx scripts/close-all-positions.ts --confirm
 *
 * IMPORTANT: Stop the bot before running this script.
 *   sudo systemctl stop sol-trader
 *
 * NOTE: This script does NOT update execution logs or trade metrics.
 * The daily QA report for the day this runs will show a discrepancy — expected.
 */

import fs from 'fs';
import path from 'path';
import { PublicKey } from '@solana/web3.js';

// Config self-loads .env at import time via src/utils/config.ts
import { getConnection, getKeypair, config } from '../src/utils';
import { sellToken, paperSellToken, USDC_MINT } from '../src/execution/jupiter-swap';

const DATA_DIR = path.resolve(__dirname, '../data');
const SLIPPAGE_BPS = 300;

type PositionExit = {
  type: string;
  sellPct: number;
  tokensSold: number;
  usdcReceived: number;
  price: number;
  timestamp: number;
};

type Position = {
  id: string;
  mint: string;
  initialSizeUsdc: number;
  remainingTokens: number;
  exits: PositionExit[];
  status: 'open' | 'closed';
  closeReason?: string;
  [key: string]: unknown;
};

type PositionFile = {
  savedAt: string;
  open: Position[];
  closed: Position[];
  stats: {
    dailyPnlUsdc: number;
    consecutiveLosses: number;
    lastLossTime: number;
    [key: string]: unknown;
  };
};

function findPositionsFile(): { filePath: string; date: string } | null {
  const now = new Date();
  for (let daysBack = 0; daysBack <= 1; daysBack++) {
    const d = new Date(now.getTime() - daysBack * 86_400_000);
    const date = d.toISOString().split('T')[0];
    const filePath = path.join(DATA_DIR, `positions-${date}.json`);
    if (fs.existsSync(filePath)) {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as PositionFile;
      if ((raw.open?.length ?? 0) > 0) {
        return { filePath, date };
      }
    }
  }
  return null;
}

async function getOnChainRawBalance(mint: string): Promise<string> {
  const conn = getConnection();
  const wallet = getKeypair().publicKey;
  const mintPubkey = new PublicKey(mint);
  const accounts = await conn.getTokenAccountsByOwner(wallet, { mint: mintPubkey });
  if (accounts.value.length === 0) return '0';
  const parsed = await conn.getParsedAccountInfo(accounts.value[0].pubkey);
  if (parsed.value?.data && 'parsed' in parsed.value.data) {
    return (parsed.value.data as { parsed: { info: { tokenAmount: { amount: string } } } })
      .parsed.info.tokenAmount.amount;
  }
  return '0';
}

async function main() {
  const hasConfirm = process.argv.includes('--confirm');
  if (!hasConfirm) {
    console.error('');
    console.error('  STOP THE BOT BEFORE RUNNING THIS SCRIPT:');
    console.error('    sudo systemctl stop sol-trader');
    console.error('');
    console.error('  Then run with --confirm to proceed:');
    console.error('    npx tsx scripts/close-all-positions.ts --confirm');
    console.error('');
    process.exit(1);
  }

  console.log('=== close-all-positions ===');
  console.log(`Mode: ${config.trading.paperTrading ? 'PAPER' : 'LIVE'}`);
  console.log('');

  const found = findPositionsFile();
  if (!found) {
    console.log('No open positions found in today or yesterday\'s file. Nothing to do.');
    process.exit(0);
  }

  const { filePath, date } = found;
  console.log(`Loading positions from: ${filePath}`);

  const fileData = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as PositionFile;
  const openPositions = fileData.open ?? [];

  console.log(`Found ${openPositions.length} open position(s).\n`);

  let sold = 0;
  let ghostClosed = 0;
  let failed = 0;
  let totalUsdcRecovered = 0;

  for (const pos of openPositions) {
    const { mint, id } = pos;
    console.log(`Processing ${id} (mint: ${mint})`);

    // Get actual on-chain balance — do NOT use pos.remainingTokens
    let rawBalance: string;
    try {
      rawBalance = await getOnChainRawBalance(mint);
    } catch (err) {
      console.error(`  ERROR reading on-chain balance: ${err}`);
      failed++;
      continue;
    }

    if (rawBalance === '0') {
      console.log('  Ghost position — no tokens found on-chain. Marking closed.');
      pos.status = 'closed';
      pos.closeReason = 'force-closed (ghost: no on-chain balance)';
      ghostClosed++;
      continue;
    }

    console.log(`  On-chain raw balance: ${rawBalance}`);

    try {
      let result;
      if (config.trading.paperTrading) {
        result = await paperSellToken(mint, rawBalance, SLIPPAGE_BPS);
        console.log(`  PAPER sell simulated. success=${result.success}`);
      } else {
        result = await sellToken(mint, rawBalance, SLIPPAGE_BPS, false);
        console.log(`  Sell ${result.success ? 'SUCCEEDED' : 'FAILED'}. USDC received: ${result.usdcReceived?.toFixed(2) ?? '?'}`);
      }

      if (result.success) {
        const usdcOut = result.usdcReceived ?? 0;
        totalUsdcRecovered += usdcOut;
        pos.status = 'closed';
        pos.closeReason = `force-closed (script, recovered ${usdcOut.toFixed(2)} USDC)`;
        sold++;
      } else {
        console.error(`  Sell failed: ${result.error ?? 'unknown error'}`);
        failed++;
      }
    } catch (err) {
      console.error(`  ERROR executing sell: ${err}`);
      failed++;
    }
  }

  // Rewrite positions file: move successfully closed positions to closed[],
  // keep failed ones in open[] so the bot can retry on next start
  const nowClosed = openPositions.filter(p => p.status === 'closed');
  const stillOpen = openPositions.filter(p => p.status === 'open');

  const updatedFile: PositionFile = {
    savedAt: new Date().toISOString(),
    open: stillOpen,
    closed: [...(fileData.closed ?? []), ...nowClosed],
    stats: fileData.stats ?? { dailyPnlUsdc: 0, consecutiveLosses: 0, lastLossTime: 0 },
  };

  fs.writeFileSync(filePath, JSON.stringify(updatedFile, null, 2));

  console.log('');
  console.log('=== Summary ===');
  console.log(`  Sold (tokens found + swap succeeded): ${sold}`);
  console.log(`  Ghost closed (no tokens on-chain):    ${ghostClosed}`);
  console.log(`  Failed (left in open[]):              ${failed}`);
  console.log(`  Total USDC recovered from sells:      ${totalUsdcRecovered.toFixed(2)}`);
  console.log('');
  console.log(`Positions file updated: ${filePath}`);
  if (failed > 0) {
    console.log(`WARNING: ${failed} position(s) left open due to errors. Restart bot to retry.`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
