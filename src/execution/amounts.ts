export function rawToBigInt(raw: string | bigint): bigint {
  if (typeof raw === 'bigint') return raw;
  return BigInt(raw);
}

export function rawToHumanAmount(raw: string | bigint, decimals: number): number {
  const value = rawToBigInt(raw);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fraction = abs % base;
  const fractionDigits = decimals > 0
    ? fraction.toString().padStart(decimals, '0').replace(/0+$/, '')
    : '';
  const text = `${negative ? '-' : ''}${whole.toString()}${fractionDigits ? `.${fractionDigits}` : ''}`;
  return Number(text);
}

export function scaleRawAmount(
  raw: string | bigint,
  factor: number,
  precision = 1_000_000,
): bigint {
  if (!Number.isFinite(factor) || factor <= 0) return 0n;
  const scaled = Math.floor(factor * precision);
  if (scaled <= 0) return 0n;
  return (rawToBigInt(raw) * BigInt(scaled)) / BigInt(precision);
}
