import {
  VersionedTransaction,
  SystemProgram,
  PublicKey,
  TransactionMessage,
} from '@solana/web3.js';
import { getConnection, getKeypair, createLogger } from '../utils';

const log = createLogger('jito');

// Jito block engine endpoints (mainnet)
const JITO_BLOCK_ENGINE_URL = 'https://mainnet.block-engine.jito.wtf/api/v1/bundles';

// Jito tip accounts — pick one at random per bundle
const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4bVqkfRtQ7NmXwkiNPLpzuN',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];

function getRandomTipAccount(): PublicKey {
  const idx = Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length);
  return new PublicKey(JITO_TIP_ACCOUNTS[idx]);
}

// Send swap tx + separate tip tx as a Jito bundle
export async function sendWithJito(
  swapTx: VersionedTransaction,
  tipLamports: number = 10_000 // 0.00001 SOL default tip
): Promise<string | null> {
  const keypair = getKeypair();
  const conn = getConnection();

  try {
    // Build a separate tip transaction (can't modify Jupiter's VersionedTransaction)
    const tipIx = SystemProgram.transfer({
      fromPubkey: keypair.publicKey,
      toPubkey: getRandomTipAccount(),
      lamports: tipLamports,
    });

    const { blockhash } = await conn.getLatestBlockhash('confirmed');
    const tipMessage = new TransactionMessage({
      payerKey: keypair.publicKey,
      recentBlockhash: blockhash,
      instructions: [tipIx],
    }).compileToV0Message();

    const tipTx = new VersionedTransaction(tipMessage);
    tipTx.sign([keypair]);

    const serializedSwap = Buffer.from(swapTx.serialize()).toString('base64');
    const serializedTip = Buffer.from(tipTx.serialize()).toString('base64');

    // Bundle: [swap tx, tip tx] — executed atomically by Jito
    const res = await fetch(JITO_BLOCK_ENGINE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'sendBundle',
        params: [[serializedSwap, serializedTip]],
      }),
    });

    const json = await res.json() as {
      result?: string;
      error?: { message: string };
    };

    if (json.error) {
      log.error('Jito bundle error', { error: json.error.message });
      return null;
    }

    const bundleId = json.result;
    log.info('Jito bundle submitted', { bundleId, tipLamports });

    return bundleId || null;
  } catch (err) {
    log.error('Failed to send Jito bundle', { error: err });
    return null;
  }
}

// Check bundle status
export async function getBundleStatus(bundleId: string): Promise<string> {
  try {
    const res = await fetch(JITO_BLOCK_ENGINE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getBundleStatuses',
        params: [[bundleId]],
      }),
    });

    const json = await res.json() as {
      result?: { value: { bundle_id: string; status: string }[] };
    };

    const status = json.result?.value?.[0]?.status || 'unknown';
    return status;
  } catch (err) {
    log.error('Failed to check bundle status', { bundleId, error: err });
    return 'error';
  }
}
