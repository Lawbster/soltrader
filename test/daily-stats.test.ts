process.env.HELIUS_API_KEY = process.env.HELIUS_API_KEY || 'test';
process.env.HELIUS_RPC_URL = process.env.HELIUS_RPC_URL || 'http://localhost:8899';
process.env.HELIUS_WSS_URL = process.env.HELIUS_WSS_URL || 'ws://localhost:8900';

async function loadPositionManager() {
  return import('../src/execution/position-manager');
}

describe('daily stats recomputation', () => {
  test('daily pnl and loss streak only use positions closed on the requested UTC day', async () => {
    const { recomputeSavedStatsForDate } = await loadPositionManager();
    const positions = [
      {
        entryTime: Date.parse('2026-03-19T10:00:00.000Z'),
        initialSizeUsdc: 10,
        initialTokens: 1,
        strategyPlan: {
          executionMode: 'live',
        },
        exits: [
          {
            tokensSold: 1,
            usdcReceived: 8,
            type: 'hard_stop',
            sellPct: 100,
            price: 8,
            timestamp: Date.parse('2026-03-19T10:05:00.000Z'),
          },
        ],
      },
      {
        entryTime: Date.parse('2026-03-20T09:00:00.000Z'),
        initialSizeUsdc: 10,
        initialTokens: 1,
        strategyPlan: {
          executionMode: 'live',
        },
        exits: [
          {
            tokensSold: 1,
            usdcReceived: 12,
            type: 'tp1',
            sellPct: 100,
            price: 12,
            timestamp: Date.parse('2026-03-20T09:05:00.000Z'),
          },
        ],
      },
      {
        entryTime: Date.parse('2026-03-20T12:00:00.000Z'),
        initialSizeUsdc: 10,
        initialTokens: 1,
        strategyPlan: {
          executionMode: 'live',
        },
        exits: [
          {
            tokensSold: 1,
            usdcReceived: 9,
            type: 'hard_stop',
            sellPct: 100,
            price: 9,
            timestamp: Date.parse('2026-03-20T12:05:00.000Z'),
          },
        ],
      },
    ] as any;

    const stats = recomputeSavedStatsForDate(positions, '2026-03-20');

    expect(stats.totalTrades).toBe(3);
    expect(stats.wins).toBe(1);
    expect(stats.dailyPnlUsdc).toBeCloseTo(1);
    expect(stats.consecutiveLosses).toBe(1);
    expect(stats.lastLossTime).toBe(Date.parse('2026-03-20T12:05:00.000Z'));
  });

  test('days with no closed trades reset daily pnl and daily loss streak', async () => {
    const { recomputeSavedStatsForDate } = await loadPositionManager();
    const positions = [
      {
        entryTime: Date.parse('2026-03-19T10:00:00.000Z'),
        initialSizeUsdc: 10,
        initialTokens: 1,
        strategyPlan: {
          executionMode: 'live',
        },
        exits: [
          {
            tokensSold: 1,
            usdcReceived: 8,
            type: 'hard_stop',
            sellPct: 100,
            price: 8,
            timestamp: Date.parse('2026-03-19T10:05:00.000Z'),
          },
        ],
      },
    ] as any;

    const stats = recomputeSavedStatsForDate(positions, '2026-03-20');

    expect(stats.totalTrades).toBe(1);
    expect(stats.wins).toBe(0);
    expect(stats.dailyPnlUsdc).toBe(0);
    expect(stats.consecutiveLosses).toBe(0);
    expect(stats.lastLossTime).toBe(0);
  });

  test('paper closes stay out of live daily pnl and live loss streak', async () => {
    const { recomputeSavedStatsForDate } = await loadPositionManager();
    const positions = [
      {
        entryTime: Date.parse('2026-03-20T09:00:00.000Z'),
        initialSizeUsdc: 10,
        initialTokens: 1,
        strategyPlan: {
          executionMode: 'paper',
        },
        exits: [
          {
            tokensSold: 1,
            usdcReceived: 8,
            type: 'hard_stop',
            sellPct: 100,
            price: 8,
            timestamp: Date.parse('2026-03-20T09:05:00.000Z'),
          },
        ],
      },
      {
        entryTime: Date.parse('2026-03-20T12:00:00.000Z'),
        initialSizeUsdc: 10,
        initialTokens: 1,
        strategyPlan: {
          executionMode: 'live',
        },
        exits: [
          {
            tokensSold: 1,
            usdcReceived: 12,
            type: 'tp1',
            sellPct: 100,
            price: 12,
            timestamp: Date.parse('2026-03-20T12:05:00.000Z'),
          },
        ],
      },
    ] as any;

    const stats = recomputeSavedStatsForDate(positions, '2026-03-20');

    expect(stats.totalTrades).toBe(2);
    expect(stats.wins).toBe(1);
    expect(stats.dailyPnlUsdc).toBeCloseTo(2);
    expect(stats.dailyPaperPnlUsdc).toBeCloseTo(-2);
    expect(stats.consecutiveLosses).toBe(0);
    expect(stats.lastLossTime).toBe(0);
  });
});
