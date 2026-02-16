import { Connection } from '@solana/web3.js';
import { config } from './config';
import { createLogger } from './logger';
import { getKeypair } from './wallet';

const log = createLogger('rpc');

let _connection: Connection | null = null;

export function getConnection(): Connection {
  if (!_connection) {
    // Append rebate-address for Helius backrun rebates (MEV protection + SOL rebates)
    let rpcUrl = config.helius.rpcUrl;
    if (!config.trading.paperTrading && rpcUrl.includes('helius')) {
      const walletPubkey = getKeypair().publicKey.toBase58();
      const sep = rpcUrl.includes('?') ? '&' : '?';
      rpcUrl = `${rpcUrl}${sep}rebate-address=${walletPubkey}`;
    }

    _connection = new Connection(rpcUrl, {
      wsEndpoint: config.helius.wssUrl,
      commitment: 'confirmed',
    });
    log.info('RPC connection initialized', {
      rpc: rpcUrl.replace(/api-key=[^&]*/, 'api-key=***'),
      rebates: rpcUrl.includes('rebate-address'),
    });
  }
  return _connection;
}
