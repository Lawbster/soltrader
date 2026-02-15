export {
  computeRsi,
  computeStreaks,
  computePercentRank,
  computeConnorsRsi,
} from '../analysis/indicators';

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
