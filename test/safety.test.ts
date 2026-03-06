import { rawToHumanAmount, scaleRawAmount } from '../src/execution/amounts';

process.env.HELIUS_API_KEY = process.env.HELIUS_API_KEY || 'test';
process.env.HELIUS_RPC_URL = process.env.HELIUS_RPC_URL || 'http://localhost:8899';
process.env.HELIUS_WSS_URL = process.env.HELIUS_WSS_URL || 'ws://localhost:8900';

async function loadTradeTracker() {
  return import('../src/analysis/trade-tracker');
}

describe('raw amount helpers', () => {
  test('convert raw amounts without parseInt precision loss', () => {
    expect(rawToHumanAmount('1000000000', 9)).toBe(1);
    expect(rawToHumanAmount('123456789', 6)).toBeCloseTo(123.456789);
    expect(rawToHumanAmount(1234567890123456789n, 9)).toBeCloseTo(1234567890.1234567, 6);
  });

  test('scale raw amounts using bigint-safe math', () => {
    expect(scaleRawAmount('1000000', 0.9999)).toBe(999900n);
    expect(scaleRawAmount(5000000000n, 0.5)).toBe(2500000000n);
    expect(scaleRawAmount('42', 0)).toBe(0n);
  });
});

describe('trade window uses USD notionals and token-weighted VWAP', () => {
  test('buy/sell volume and wallet concentration use USD amounts', async () => {
    const { recordTrade, getTradeWindow } = await loadTradeTracker();
    const mint = `mint-${Date.now()}-usd`;
    const now = Date.now();

    recordTrade({
      mint,
      signature: `${mint}-1`,
      timestamp: now - 10_000,
      side: 'buy',
      wallet: 'wallet-a',
      amountToken: 10,
      amountQuoteUsd: 100,
      pricePerToken: 10,
      quoteMint: 'USDC',
    });
    recordTrade({
      mint,
      signature: `${mint}-2`,
      timestamp: now - 5_000,
      side: 'buy',
      wallet: 'wallet-b',
      amountToken: 20,
      amountQuoteUsd: 300,
      pricePerToken: 15,
      quoteMint: 'USDC',
    });
    recordTrade({
      mint,
      signature: `${mint}-3`,
      timestamp: now - 2_000,
      side: 'sell',
      wallet: 'wallet-c',
      amountToken: 5,
      amountQuoteUsd: 75,
      pricePerToken: 15,
      quoteMint: 'USDC',
    });

    const window = getTradeWindow(mint, 60_000);

    expect(window.buyVolumeUsd).toBe(400);
    expect(window.sellVolumeUsd).toBe(75);
    expect(window.buySellRatio).toBeCloseTo(400 / 75);
    expect(window.maxSingleWalletBuyPct).toBeCloseTo(75);
  });

  test('vwap is weighted by token quantity, not quote notional', async () => {
    const { recordTrade, getTradeWindow } = await loadTradeTracker();
    const mint = `mint-${Date.now()}-vwap`;
    const now = Date.now();

    recordTrade({
      mint,
      signature: `${mint}-1`,
      timestamp: now - 20_000,
      side: 'buy',
      wallet: 'wallet-a',
      amountToken: 100,
      amountQuoteUsd: 100,
      pricePerToken: 1,
      quoteMint: 'USDC',
    });
    recordTrade({
      mint,
      signature: `${mint}-2`,
      timestamp: now - 10_000,
      side: 'buy',
      wallet: 'wallet-b',
      amountToken: 1,
      amountQuoteUsd: 100,
      pricePerToken: 100,
      quoteMint: 'USDC',
    });

    const window = getTradeWindow(mint, 60_000);

    expect(window.vwap).toBeCloseTo((100 * 1 + 1 * 100) / 101, 6);
    expect(window.return5mPct).toBeCloseTo(9900);
  });
});

describe('trade-log dedup state stays bounded', () => {
  test('dedup generations reset cleanly', async () => {
    const { _test_dedupState, _test_resetDedup } = await loadTradeTracker();
    _test_resetDedup();
    const state = _test_dedupState();
    expect(state.currentSigs.size).toBe(0);
    expect(state.previousSigs.size).toBe(0);
    expect(state.MAX_SIGS_PER_GENERATION).toBeGreaterThan(0);
  });
});
