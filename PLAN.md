# Sol-Trader: Solana Scalp Trading Bot

## Overview
Automated trading bot targeting low-cap Solana tokens ($20k-$100k mcap) with a high-frequency scalp strategy. The goal is not moonshots — it's consistent small wins with strict risk management.

## Core Strategy
- **Target**: Tokens with $20k-$100k mcap that have survived 1+ hours (filters instant rugs)
- **Entry signal**: Volume spike + new wallet accumulation pattern
- **Take profit**: +15-30%
- **Stop loss**: -10-15%
- **Position size**: Small and fixed (0.5-2 SOL per trade during testing)
- **Max concurrent positions**: Capped (5 initially)
- **Edge**: Win 55%+ of trades where avg win > avg loss = net positive over volume

## Tech Stack
- **Language**: TypeScript
- **Runtime**: Node.js
- **RPC**: Helius (free tier for dev, $49/mo developer plan for live)
- **Chain**: Solana
- **DEX**: Jupiter for swaps
- **Data sources**: pump.fun launches, Raydium new pairs
- **Hosting**: Self-hosted VPS (24/7)

## Architecture

```
sol-trader/
├── src/
│   ├── monitor/        # Token launch monitoring (pump.fun, Raydium)
│   ├── analysis/       # Rug detection, holder analysis, scoring/filters
│   ├── execution/      # Jupiter swaps, position management
│   ├── strategy/       # Entry/exit logic, risk management
│   └── utils/          # Wallet, RPC connection, logging, config
├── data/               # Trade logs, token snapshots
├── config/             # Strategy params, thresholds
├── .env                # API keys (gitignored)
├── package.json
└── tsconfig.json
```

## Build Phases

### Phase 1: Data & Monitoring ← START HERE
- [x] Project scaffold (dirs, .env)
- [x] package.json + tsconfig + .gitignore
- [x] Core utils: RPC connection (Helius WebSocket), wallet, logger, config loader
- [x] Token monitor: listen for pump.fun new launches + Raydium new pairs
- [x] Store token snapshots (price, volume, holders over time)
- [x] Snapshot batching + token cleanup to reduce RPC load

### Phase 2: Analysis & Filtering
- [ ] Developer wallet history check (has this wallet rugged before?)
- [x] Token distribution analysis (supply concentration)
- [x] Liquidity status (locked, amount, duration)
- [x] Buy/sell ratio and velocity tracking
- [x] Token age + survival filter
- [x] Scoring system: each token gets a composite score from all filters
- [x] Configurable parameter thresholds (easy to tune)

### Phase 3: Execution Engine
- [x] Jupiter swap integration (buy/sell)
- [x] Jito bundle support (faster tx inclusion)
- [x] Position manager: track entries, set TP/SL, auto-close
- [x] Slippage protection
- [x] Concurrent position limits enforced

### Phase 4: Paper Trading
- [x] Paper executor with realistic simulation (latency, slippage, failure, fees)
- [x] Position manager routes through paper executor when PAPER_TRADING=true
- [x] Performance metrics tracker (win rate, profit factor, Sharpe, drawdown, etc.)
- [x] Metrics persisted to data/metrics.json, summary on shutdown
- [x] Go-live gates checklist (docs/LIVE_GATES.md)
- [x] Test harness with vitest (8 safety tests)
- [ ] Run for 14 days collecting data, evaluate go-live gates

### Phase 5: Live Trading
- [ ] Switch from paper to real execution (env flag toggle)
- [ ] Start with minimal capital (0.5 SOL positions)
- [ ] Alerts: Discord/Telegram webhooks on trades
- [ ] Dashboard or log viewer for monitoring
- [ ] Scale position size based on confidence

## Key Decisions
- **Paper trade first** — prove the strategy before risking capital
- **Budget**: $500 initial testing, scale to $20k if strategy proves out
- **Helius free tier** for development, upgrade to Developer ($49/mo) for live
- **Risk per trade is fixed and small** — this is a volume play, not a YOLO play

## Setup Requirements
1. Sign up at helius.dev and get API key (free tier)
2. Generate a fresh Solana wallet for the bot (never use your main wallet)
3. Fund with small amount of SOL for testing
4. Add keys to .env
5. `npm install` and start monitoring
