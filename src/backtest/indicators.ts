// Self-contained copies of RSI/CRSI functions — no dependency on live analysis module.

/** Single RSI value over the full values array (Wilder smoothing). */
export function computeRsi(values: number[], period: number): number | null {
  if (values.length < period + 1) return null;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const delta = values[i] - values[i - 1];
    if (delta >= 0) gains += delta;
    else losses -= delta;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const delta = values[i] - values[i - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Streak series: consecutive up/down closes. */
export function computeStreaks(values: number[]): number[] {
  const streaks: number[] = [];
  let streak = 0;
  for (let i = 1; i < values.length; i++) {
    const delta = values[i] - values[i - 1];
    if (delta > 0) streak = streak >= 0 ? streak + 1 : 1;
    else if (delta < 0) streak = streak <= 0 ? streak - 1 : -1;
    else streak = 0;
    streaks.push(streak);
  }
  return streaks;
}

/** Percent rank of the most recent return within a lookback window. */
export function computePercentRank(values: number[], period: number): number | null {
  if (values.length < period + 1) return null;

  const returns: number[] = [];
  for (let i = 1; i < values.length; i++) {
    returns.push(values[i] - values[i - 1]);
  }

  if (returns.length < period) return null;
  const window = returns.slice(-period);
  const current = window[window.length - 1];
  const count = window.filter(r => r <= current).length;
  return (count / window.length) * 100;
}

/** ConnorsRSI = average(priceRSI, streakRSI, percentRank). */
export function computeConnorsRsi(values: number[], rsiPeriod: number, streakRsiPeriod: number, rankPeriod: number): number | null {
  const priceRsi = computeRsi(values, rsiPeriod);
  if (priceRsi === null) return null;

  const streaks = computeStreaks(values);
  const streakRsi = computeRsi(streaks, streakRsiPeriod);
  if (streakRsi === null) return null;

  const rank = computePercentRank(values, rankPeriod);
  if (rank === null) return null;

  return (priceRsi + streakRsi + rank) / 3;
}

/** Simple Moving Average. NaN for first (period-1) elements. */
export function computeSma(values: number[], period: number): number[] {
  const result: number[] = new Array(values.length).fill(NaN);
  if (values.length < period) return result;

  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  result[period - 1] = sum / period;

  for (let i = period; i < values.length; i++) {
    sum += values[i] - values[i - period];
    result[i] = sum / period;
  }
  return result;
}

/** Exponential Moving Average. SMA-seeded. */
export function computeEma(values: number[], period: number): number[] {
  const result: number[] = new Array(values.length).fill(NaN);
  if (values.length < period) return result;

  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  result[period - 1] = sum / period;

  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    result[i] = values[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

/** MACD with signal line and histogram. */
export function computeMacd(
  values: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9
): { macd: number[]; signal: number[]; histogram: number[] } {
  const emaFast = computeEma(values, fastPeriod);
  const emaSlow = computeEma(values, slowPeriod);
  const macdLine = emaFast.map((f, i) => f - emaSlow[i]);

  const validStart = slowPeriod - 1;
  const validMacd = macdLine.slice(validStart);
  const signalRaw = computeEma(validMacd, signalPeriod);

  const signal = new Array(validStart).fill(NaN).concat(signalRaw);
  const histogram = macdLine.map((m, i) => m - signal[i]);

  return { macd: macdLine, signal, histogram };
}

/** Bollinger Bands. */
export function computeBollingerBands(
  values: number[],
  period = 20,
  multiplier = 2
): { upper: number[]; middle: number[]; lower: number[]; width: number[] } {
  const middle = computeSma(values, period);
  const upper: number[] = new Array(values.length).fill(NaN);
  const lower: number[] = new Array(values.length).fill(NaN);
  const width: number[] = new Array(values.length).fill(NaN);

  for (let i = period - 1; i < values.length; i++) {
    const window = values.slice(i - period + 1, i + 1);
    const mean = middle[i];
    const variance = window.reduce((sum, v) => sum + (v - mean) ** 2, 0) / period;
    const std = Math.sqrt(variance);
    upper[i] = mean + multiplier * std;
    lower[i] = mean - multiplier * std;
    width[i] = mean > 0 ? (upper[i] - lower[i]) / mean : 0;
  }

  return { upper, middle, lower, width };
}

/** Average True Range with Wilder smoothing. */
export function computeAtr(
  highs: number[],
  lows: number[],
  closes: number[],
  period = 14
): number[] {
  const len = highs.length;
  const result: number[] = new Array(len).fill(NaN);
  if (len < 2) return result;

  const tr: number[] = [highs[0] - lows[0]];
  for (let i = 1; i < len; i++) {
    tr.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }

  if (tr.length < period) return result;
  let atr = tr.slice(0, period).reduce((s, v) => s + v, 0) / period;
  result[period - 1] = atr;
  for (let i = period; i < len; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
    result[i] = atr;
  }
  return result;
}

/** VWAP proxy using pricePoints as volume weight. */
export function computeVwapProxy(
  candles: { close: number; high: number; low: number; pricePoints: number }[]
): number[] {
  const result: number[] = [];
  let cumVP = 0;
  let cumV = 0;
  for (const c of candles) {
    const typical = (c.high + c.low + c.close) / 3;
    cumVP += typical * c.pricePoints;
    cumV += c.pricePoints;
    result.push(cumV > 0 ? cumVP / cumV : typical);
  }
  return result;
}

/** OBV proxy using pricePoints as volume. */
export function computeObvProxy(closes: number[], volumes: number[]): number[] {
  const result: number[] = [0];
  for (let i = 1; i < closes.length; i++) {
    const dir = closes[i] > closes[i - 1] ? 1 : closes[i] < closes[i - 1] ? -1 : 0;
    result.push(result[i - 1] + dir * volumes[i]);
  }
  return result;
}

/** Average Directional Index (ADX) — measures trend strength (0-100).
 *  ADX < 25 = ranging/weak trend, ADX > 25 = strong trend. */
export function computeAdx(
  highs: number[],
  lows: number[],
  closes: number[],
  period = 14
): number[] {
  const len = highs.length;
  const result: number[] = new Array(len).fill(NaN);
  if (len < 2 * period + 1) return result;

  // True Range, +DM, -DM
  const tr: number[] = [highs[0] - lows[0]];
  const plusDM: number[] = [0];
  const minusDM: number[] = [0];

  for (let i = 1; i < len; i++) {
    tr.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  // Initial sums for Wilder smoothing
  let smoothTr = 0, smoothPlusDM = 0, smoothMinusDM = 0;
  for (let i = 1; i <= period; i++) {
    smoothTr += tr[i];
    smoothPlusDM += plusDM[i];
    smoothMinusDM += minusDM[i];
  }

  // DX series
  const dx: number[] = new Array(len).fill(NaN);
  for (let i = period; i < len; i++) {
    if (i > period) {
      smoothTr = smoothTr - smoothTr / period + tr[i];
      smoothPlusDM = smoothPlusDM - smoothPlusDM / period + plusDM[i];
      smoothMinusDM = smoothMinusDM - smoothMinusDM / period + minusDM[i];
    }
    const plusDI = smoothTr > 0 ? (smoothPlusDM / smoothTr) * 100 : 0;
    const minusDI = smoothTr > 0 ? (smoothMinusDM / smoothTr) * 100 : 0;
    const diSum = plusDI + minusDI;
    dx[i] = diSum > 0 ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0;
  }

  // ADX = Wilder-smoothed DX
  let adxSum = 0;
  for (let i = period; i < 2 * period; i++) adxSum += dx[i];
  result[2 * period - 1] = adxSum / period;

  for (let i = 2 * period; i < len; i++) {
    result[i] = (result[i - 1] * (period - 1) + dx[i]) / period;
  }

  return result;
}

/** Rolling RSI series — returns value at every candle position. */
export function computeRsiSeries(values: number[], period: number): (number | null)[] {
  const result: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period + 1) return result;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const delta = values[i] - values[i - 1];
    if (delta >= 0) avgGain += delta;
    else avgLoss -= delta;
  }
  avgGain /= period;
  avgLoss /= period;

  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < values.length; i++) {
    const delta = values[i] - values[i - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return result;
}

/** Rolling ConnorsRSI series. */
export function computeConnorsRsiSeries(
  values: number[],
  rsiP: number,
  streakRsiP: number,
  rankP: number
): (number | null)[] {
  const priceRsi = computeRsiSeries(values, rsiP);

  const streakValues: number[] = [0];
  let streak = 0;
  for (let i = 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) streak = streak >= 0 ? streak + 1 : 1;
    else if (d < 0) streak = streak <= 0 ? streak - 1 : -1;
    else streak = 0;
    streakValues.push(streak);
  }
  const streakRsi = computeRsiSeries(streakValues, streakRsiP);

  const returns: number[] = [0];
  for (let i = 1; i < values.length; i++) {
    returns.push(values[i] - values[i - 1]);
  }
  const percentRank: (number | null)[] = new Array(values.length).fill(null);
  for (let i = rankP; i < returns.length; i++) {
    const window = returns.slice(i - rankP + 1, i + 1);
    const current = window[window.length - 1];
    const count = window.filter(r => r <= current).length;
    percentRank[i] = (count / window.length) * 100;
  }

  const result: (number | null)[] = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    if (priceRsi[i] !== null && streakRsi[i] !== null && percentRank[i] !== null) {
      result[i] = (priceRsi[i]! + streakRsi[i]! + percentRank[i]!) / 3;
    }
  }
  return result;
}
