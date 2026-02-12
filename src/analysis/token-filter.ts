import { createLogger } from '../utils';
import { loadStrategyConfig } from '../strategy/strategy-config';
import { TokenData, TradeWindow, FilterResult } from './types';

const log = createLogger('filter');

// Section 1: Tradable Universe filters
export function filterUniverse(token: TokenData): FilterResult {
  const cfg = loadStrategyConfig().universe;

  if (token.tokenAgeMins < cfg.tokenAgeMinMinutes) {
    return { passed: false, reason: `Too young: ${Math.round(token.tokenAgeMins)}m < ${cfg.tokenAgeMinMinutes}m` };
  }

  if (token.tokenAgeMins > cfg.tokenAgeMaxMinutes) {
    return { passed: false, reason: `Too old: ${Math.round(token.tokenAgeMins)}m > ${cfg.tokenAgeMaxMinutes}m` };
  }

  if (token.mcapUsd < cfg.mcapMinUsd) {
    return { passed: false, reason: `Mcap too low: $${Math.round(token.mcapUsd)} < $${cfg.mcapMinUsd}` };
  }

  if (token.mcapUsd > cfg.mcapMaxUsd) {
    return { passed: false, reason: `Mcap too high: $${Math.round(token.mcapUsd)} > $${cfg.mcapMaxUsd}` };
  }

  if (token.liquidityUsd < cfg.minLiquidityUsd) {
    return { passed: false, reason: `Low liquidity: $${Math.round(token.liquidityUsd)} < $${cfg.minLiquidityUsd}` };
  }

  if (cfg.requireAuthorityRenounced && !token.mintAuthorityRevoked) {
    return { passed: false, reason: 'Mint authority not renounced' };
  }

  if (cfg.requireAuthorityRenounced && !token.freezeAuthorityRevoked) {
    return { passed: false, reason: 'Freeze authority not renounced' };
  }

  if (token.top10HolderPct > cfg.maxTop10HolderPct) {
    return { passed: false, reason: `Top10 hold ${Math.round(token.top10HolderPct)}% > ${cfg.maxTop10HolderPct}%` };
  }

  return { passed: true };
}

// Section 2: Entry signal filters (requires trade window data + LP context)
export function filterEntry(token: TokenData, window: TradeWindow, lpChange10mPct?: number): FilterResult {
  const cfg = loadStrategyConfig();
  const entry = cfg.entry;
  const universe = cfg.universe;

  // Volume check (from universe, using trade window data)
  if (token.volume5mUsd < universe.minVolume5mUsd) {
    return { passed: false, reason: `5m volume $${Math.round(token.volume5mUsd)} < $${universe.minVolume5mUsd}` };
  }

  // Momentum: 5-minute return >= threshold
  if (window.return5mPct < entry.minReturn5mPct) {
    return { passed: false, reason: `5m return ${window.return5mPct.toFixed(1)}% < ${entry.minReturn5mPct}%` };
  }

  // VWAP: current price above VWAP (1m close > VWAP)
  if (window.vwap > 0 && token.priceSol < window.vwap) {
    return { passed: false, reason: `Price ${token.priceSol.toExponential(2)} below VWAP ${window.vwap.toExponential(2)}` };
  }

  // Buy/sell ratio
  if (window.buySellRatio < entry.minBuySellRatio5m) {
    return { passed: false, reason: `B/S ratio ${window.buySellRatio.toFixed(2)} < ${entry.minBuySellRatio5m}` };
  }

  // Unique buyers
  if (window.uniqueBuyers < entry.minUniqueBuyers5m) {
    return { passed: false, reason: `Only ${window.uniqueBuyers} unique buyers < ${entry.minUniqueBuyers5m}` };
  }

  // Whale buy concentration
  if (window.maxSingleWalletBuyPct > entry.maxSingleWalletBuyPct) {
    return { passed: false, reason: `Single wallet ${window.maxSingleWalletBuyPct.toFixed(1)}% of buys > ${entry.maxSingleWalletBuyPct}%` };
  }

  // LP stability: reject if liquidity dropped more than threshold in last 10 minutes
  if (lpChange10mPct !== undefined && lpChange10mPct < entry.maxLpChange10mPct) {
    return { passed: false, reason: `LP dropped ${lpChange10mPct.toFixed(1)}% in 10m (limit: ${entry.maxLpChange10mPct}%)` };
  }

  return { passed: true };
}

// Combined: run universe + entry filters
export function filterToken(token: TokenData, window: TradeWindow, lpChange10mPct?: number): FilterResult {
  const universeResult = filterUniverse(token);
  if (!universeResult.passed) {
    log.debug('Universe filter rejected', { mint: token.mint, reason: universeResult.reason });
    return universeResult;
  }

  const entryResult = filterEntry(token, window, lpChange10mPct);
  if (!entryResult.passed) {
    log.debug('Entry filter rejected', { mint: token.mint, reason: entryResult.reason });
    return entryResult;
  }

  log.info('Token passed all filters', { mint: token.mint });
  return { passed: true };
}
