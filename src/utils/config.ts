import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

const isPaperMode = optional('PAPER_TRADING', 'true') === 'true';

export const config = {
  helius: {
    apiKey: required('HELIUS_API_KEY'),
    rpcUrl: required('HELIUS_RPC_URL'),
    wssUrl: required('HELIUS_WSS_URL'),
  },
  wallet: {
    privateKey: isPaperMode ? optional('WALLET_PRIVATE_KEY', '') : required('WALLET_PRIVATE_KEY'),
  },
  trading: {
    paperTrading: isPaperMode,
    maxPositionSol: parseFloat(optional('MAX_POSITION_SOL', '1.0')),
    maxConcurrentPositions: parseInt(optional('MAX_CONCURRENT_POSITIONS', '5')),
    defaultSlippageBps: parseInt(optional('DEFAULT_SLIPPAGE_BPS', '300')),
  },
  alerts: {
    discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  },
  // Well-known program IDs
  programs: {
    pumpFun: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    raydiumAmm: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  },
} as const;
