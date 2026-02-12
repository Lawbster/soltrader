import { Logs, PublicKey } from '@solana/web3.js';
import { getConnection, config, createLogger } from '../utils';
import { TokenLaunch, TokenEventHandler } from './types';

const log = createLogger('monitor');

// pump.fun log signatures for token creation
const PUMPFUN_CREATE_DISCRIMINATOR = 'Program log: Instruction: Create';
// Raydium AMM initialization
const RAYDIUM_INIT_DISCRIMINATOR = 'Program log: Instruction: Initialize';

export class TokenMonitor {
  private handlers: TokenEventHandler[] = [];
  private subscriptionIds: number[] = [];
  private running = false;

  onTokenLaunch(handler: TokenEventHandler) {
    this.handlers.push(handler);
  }

  private emit(launch: TokenLaunch) {
    for (const handler of this.handlers) {
      try {
        handler(launch);
      } catch (err) {
        log.error('Handler error', err);
      }
    }
  }

  async start() {
    if (this.running) return;
    this.running = true;

    const conn = getConnection();
    log.info('Starting token monitor...');

    // Subscribe to pump.fun program logs
    const pumpSubId = conn.onLogs(
      new PublicKey(config.programs.pumpFun),
      (logInfo: Logs) => this.handlePumpFunLog(logInfo),
      'confirmed'
    );
    this.subscriptionIds.push(pumpSubId);
    log.info('Subscribed to pump.fun logs', { program: config.programs.pumpFun });

    // Subscribe to Raydium AMM logs
    const raydiumSubId = conn.onLogs(
      new PublicKey(config.programs.raydiumAmm),
      (logInfo: Logs) => this.handleRaydiumLog(logInfo),
      'confirmed'
    );
    this.subscriptionIds.push(raydiumSubId);
    log.info('Subscribed to Raydium AMM logs', { program: config.programs.raydiumAmm });

    log.info('Token monitor running. Listening for new launches...');
  }

  async stop() {
    if (!this.running) return;
    this.running = false;

    const conn = getConnection();
    for (const subId of this.subscriptionIds) {
      await conn.removeOnLogsListener(subId);
    }
    this.subscriptionIds = [];
    log.info('Token monitor stopped');
  }

  private handlePumpFunLog(logInfo: Logs) {
    if (logInfo.err) return;

    const logs = logInfo.logs;
    const isCreate = logs.some(l => l.includes(PUMPFUN_CREATE_DISCRIMINATOR));
    if (!isCreate) return;

    // Extract mint address from account keys in logs
    // pump.fun create logs include the mint as one of the referenced accounts
    const mint = this.extractMintFromLogs(logs, 'pumpfun');
    if (!mint) {
      log.debug('pump.fun create detected but could not extract mint', {
        signature: logInfo.signature,
      });
      return;
    }

    const launch: TokenLaunch = {
      mint,
      source: 'pumpfun',
      signature: logInfo.signature,
      detectedAt: Date.now(),
    };

    log.info('New pump.fun token detected', { mint, sig: logInfo.signature });
    this.emit(launch);
  }

  private handleRaydiumLog(logInfo: Logs) {
    if (logInfo.err) return;

    const logs = logInfo.logs;
    const isInit = logs.some(l => l.includes(RAYDIUM_INIT_DISCRIMINATOR));
    if (!isInit) return;

    // For Raydium, we'll fetch the transaction to get full account details
    const launch: TokenLaunch = {
      mint: '', // Will be enriched by fetching the tx
      source: 'raydium',
      signature: logInfo.signature,
      detectedAt: Date.now(),
    };

    log.info('New Raydium pool detected', { sig: logInfo.signature });
    this.enrichRaydiumLaunch(launch);
  }

  private extractMintFromLogs(logs: string[], source: string): string | null {
    // Look for "Program log: mint: <address>" pattern
    for (const line of logs) {
      const mintMatch = line.match(/mint:\s*([1-9A-HJ-NP-Za-km-z]{32,44})/);
      if (mintMatch) return mintMatch[1];
    }

    // Look for any Solana public key pattern in create-related logs
    // pump.fun often logs the mint address directly
    for (const line of logs) {
      if (line.includes('Create') || line.includes('create')) {
        const keyMatch = line.match(/([1-9A-HJ-NP-Za-km-z]{43,44})/);
        if (keyMatch) return keyMatch[1];
      }
    }

    return null;
  }

  private async enrichRaydiumLaunch(launch: TokenLaunch) {
    try {
      const conn = getConnection();
      const tx = await conn.getParsedTransaction(launch.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });

      if (!tx?.meta) {
        log.warn('Could not fetch Raydium tx for enrichment', { sig: launch.signature });
        this.emit(launch); // Emit anyway, downstream can handle missing mint
        return;
      }

      // Raydium initialize instruction puts the token mints in the account keys
      // Account layout: [amm, authority, openOrders, lpMint, coinMint, pcMint, ...]
      // coinMint (index 4) is typically the new token, pcMint (index 5) is SOL/USDC
      const accountKeys = tx.transaction.message.accountKeys;
      const SOL_MINT = 'So11111111111111111111111111111111111111112';
      const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

      // Find the non-SOL/USDC mint from the account keys
      for (const key of accountKeys) {
        const addr = key.pubkey.toBase58();
        if (addr !== SOL_MINT && addr !== USDC_MINT) {
          // Verify it's a mint by checking if it appears in token balance changes
          const preTokenBalances = tx.meta.preTokenBalances || [];
          const postTokenBalances = tx.meta.postTokenBalances || [];
          const allMints = [
            ...preTokenBalances.map(b => b.mint),
            ...postTokenBalances.map(b => b.mint),
          ];

          if (allMints.includes(addr)) {
            launch.mint = addr;
            break;
          }
        }
      }

      if (!launch.mint) {
        // Fallback: just grab the first non-standard mint from token balances
        const postBalances = tx.meta.postTokenBalances || [];
        for (const bal of postBalances) {
          if (bal.mint !== SOL_MINT && bal.mint !== USDC_MINT) {
            launch.mint = bal.mint;
            break;
          }
        }
      }

      if (launch.mint) {
        log.info('Raydium launch enriched', { mint: launch.mint, sig: launch.signature });
      } else {
        log.warn('Could not extract mint from Raydium tx', { sig: launch.signature });
      }

      this.emit(launch);
    } catch (err) {
      log.error('Failed to enrich Raydium launch', { sig: launch.signature, error: err });
      this.emit(launch);
    }
  }
}
