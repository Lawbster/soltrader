import type { RouteProtectionConfig } from './live-strategy-map';

function formatNumericValue(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value)) return String(value);
  return Number(value.toFixed(6)).toString();
}

export function buildNumericRecordKey(
  record?: Record<string, number>,
): string | undefined {
  if (!record) return undefined;

  const entries = Object.entries(record)
    .filter(([, value]) => Number.isFinite(value))
    .sort(([a], [b]) => a.localeCompare(b));

  if (entries.length === 0) return undefined;
  return entries.map(([key, value]) => `${key}=${formatNumericValue(value)}`).join(' ');
}

export function buildProtectionKey(
  protection?: RouteProtectionConfig,
): string | undefined {
  if (!protection) return undefined;

  const normalized: Record<string, number> = {};
  for (const [key, value] of Object.entries(protection)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      normalized[key] = value;
    }
  }

  return buildNumericRecordKey(normalized);
}
