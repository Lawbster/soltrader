import { Connection } from '@solana/web3.js';
import { config } from './config';
import { createLogger } from './logger';

const log = createLogger('rpc');

let _connection: Connection | null = null;

export function getConnection(): Connection {
  if (!_connection) {
    _connection = new Connection(config.helius.rpcUrl, {
      wsEndpoint: config.helius.wssUrl,
      commitment: 'confirmed',
    });
    log.info('RPC connection initialized', {
      rpc: config.helius.rpcUrl.replace(/api-key=.*/, 'api-key=***'),
    });
  }
  return _connection;
}
