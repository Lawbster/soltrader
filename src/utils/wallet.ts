import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { config } from './config';
import { createLogger } from './logger';

const log = createLogger('wallet');

let _keypair: Keypair | null = null;

export function getKeypair(): Keypair {
  if (!_keypair) {
    if (!config.wallet.privateKey) {
      if (config.trading.paperTrading) {
        // Generate an ephemeral keypair for paper trading (no real funds)
        _keypair = Keypair.generate();
        log.info('Paper mode: using ephemeral wallet', { publicKey: _keypair.publicKey.toBase58() });
      } else {
        throw new Error('WALLET_PRIVATE_KEY is required for live trading');
      }
    } else {
      const decoded = bs58.decode(config.wallet.privateKey);
      _keypair = Keypair.fromSecretKey(decoded);
      log.info('Wallet loaded', { publicKey: _keypair.publicKey.toBase58() });
    }
  }
  return _keypair;
}

export function getPublicKey(): PublicKey {
  return getKeypair().publicKey;
}
