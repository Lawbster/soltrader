export { loadStrategyConfig } from './strategy-config';
export { scoreToken } from './scoring';
export { evaluateEntry, evaluateExit } from './rules';
export {
  initMetrics,
  recordExecutionAttempt,
  recordClosedPosition,
  getAggregateMetrics,
  saveMetrics,
  printMetricsSummary,
  getTradeMetrics,
} from './metrics';
export type { EntrySignal, ExitSignal, PortfolioState } from './rules';
export type { StrategyConfig } from './strategy-config';
export type { TradeMetric, AggregateMetrics } from './metrics';
