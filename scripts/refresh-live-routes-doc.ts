import fs from 'fs';
import path from 'path';

type Regime = 'uptrend' | 'sideways' | 'downtrend';

interface RouteConfig {
  routeId?: string;
  enabled?: boolean;
  templateId?: string;
  timeframeMinutes?: number;
  exitMode?: string;
  params?: Record<string, number>;
  sl?: number;
  tp?: number;
  slAtr?: number;
  tpAtr?: number;
  maxPositionUsdc?: number;
  maxPositionEquityPct?: number;
}

interface RegimeConfigSingle extends RouteConfig {
  enabled: boolean;
}

interface RegimeConfigRoutes {
  enabled: boolean;
  routes: RouteConfig[];
}

interface TokenConfig {
  label: string;
  enabled: boolean;
  maxPositionUsdc?: number;
  maxPositionEquityPct?: number;
  regimes: Record<Regime, RegimeConfigSingle | RegimeConfigRoutes>;
}

interface LiveMap {
  version: string;
  tokens: Record<string, TokenConfig>;
}

const ROOT = path.resolve(__dirname, '..');
const LIVE_MAP_PATH = path.join(ROOT, 'config', 'live-strategy-map.v1.json');
const STRATEGY_DOC_PATH = path.join(ROOT, 'strategy.md');
const START_MARKER = '<!-- LIVE_ROUTES:START -->';
const END_MARKER = '<!-- LIVE_ROUTES:END -->';

function isRouteBlock(config: RegimeConfigSingle | RegimeConfigRoutes): config is RegimeConfigRoutes {
  return Array.isArray((config as RegimeConfigRoutes).routes);
}

function formatStops(route: RouteConfig): string {
  const parts: string[] = [];
  if (Number.isFinite(route.slAtr)) parts.push(`SL ${route.slAtr} ATR`);
  else if (Number.isFinite(route.sl)) parts.push(`SL ${route.sl}`);

  if (Number.isFinite(route.tpAtr)) parts.push(`TP ${route.tpAtr} ATR`);
  else if (Number.isFinite(route.tp)) parts.push(`TP ${route.tp}`);

  return parts.length > 0 ? `\`${parts.join(' / ')}\`` : '`--`';
}

function formatSize(token: TokenConfig, route: RouteConfig): string {
  const eqPct = route.maxPositionEquityPct ?? token.maxPositionEquityPct;
  if (Number.isFinite(eqPct)) return `${eqPct}% equity`;
  const usdc = route.maxPositionUsdc ?? token.maxPositionUsdc;
  if (Number.isFinite(usdc)) return `$${usdc}`;
  return '--';
}

function collectActiveRoutes(map: LiveMap) {
  const active: Array<{
    label: string;
    regime: Regime;
    routeId: string;
    templateId: string;
    timeframeMinutes: number | string;
    exitMode: string;
    stops: string;
    size: string;
  }> = [];
  const disabledLabels: string[] = [];

  for (const token of Object.values(map.tokens)) {
    if (!token.enabled) {
      disabledLabels.push(token.label);
      continue;
    }

    for (const regime of ['uptrend', 'sideways', 'downtrend'] as const) {
      const config = token.regimes[regime];
      if (!config?.enabled) continue;

      if (isRouteBlock(config)) {
        for (const route of config.routes ?? []) {
          if (!route?.enabled || !route.templateId) continue;
          active.push({
            label: token.label,
            regime,
            routeId: route.routeId ?? `${token.label}-${regime}-${route.templateId}`,
            templateId: route.templateId,
            timeframeMinutes: route.timeframeMinutes ?? '--',
            exitMode: route.exitMode ?? 'price',
            stops: formatStops(route),
            size: formatSize(token, route),
          });
        }
        continue;
      }

      if (!config.templateId) continue;
      active.push({
        label: token.label,
        regime,
        routeId: config.routeId ?? `${token.label}-${regime}-${config.templateId}`,
        templateId: config.templateId,
        timeframeMinutes: config.timeframeMinutes ?? '--',
        exitMode: config.exitMode ?? 'price',
        stops: formatStops(config),
        size: formatSize(token, config),
      });
    }
  }

  active.sort((a, b) => {
    if (a.label !== b.label) return a.label.localeCompare(b.label);
    const regimeOrder = { uptrend: 0, sideways: 1, downtrend: 2 };
    if (regimeOrder[a.regime] !== regimeOrder[b.regime]) return regimeOrder[a.regime] - regimeOrder[b.regime];
    return a.routeId.localeCompare(b.routeId);
  });

  disabledLabels.sort((a, b) => a.localeCompare(b));
  return { active, disabledLabels };
}

function buildSection(map: LiveMap): string {
  const { active, disabledLabels } = collectActiveRoutes(map);
  const lines: string[] = [
    START_MARKER,
    'Generated from `config/live-strategy-map.v1.json` by `npm run refresh-live-routes-doc`.',
    '',
    '| Token | Regime | Route | Template | TF | Exit | Stops | Max Size |',
    '|---|---|---|---|---:|---|---|---|',
  ];

  for (const route of active) {
    lines.push(
      `| ${route.label} | ${route.regime} | \`${route.routeId}\` | \`${route.templateId}\` | ${route.timeframeMinutes}m | ${route.exitMode} | ${route.stops} | ${route.size} |`
    );
  }

  lines.push('');
  lines.push('Disabled at the moment:');
  for (const label of disabledLabels) {
    lines.push(`- ${label}`);
  }
  lines.push('- all non-listed regimes');
  lines.push(END_MARKER);

  return lines.join('\n');
}

function main() {
  const map = JSON.parse(fs.readFileSync(LIVE_MAP_PATH, 'utf8')) as LiveMap;
  const doc = fs.readFileSync(STRATEGY_DOC_PATH, 'utf8');

  const start = doc.indexOf(START_MARKER);
  const end = doc.indexOf(END_MARKER);
  if (start < 0 || end < 0 || end < start) {
    throw new Error(`Missing ${START_MARKER} / ${END_MARKER} markers in strategy.md`);
  }

  const section = buildSection(map);
  const updated = `${doc.slice(0, start)}${section}${doc.slice(end + END_MARKER.length)}`;
  fs.writeFileSync(STRATEGY_DOC_PATH, updated);
  console.log(`Updated live-route section in ${path.relative(ROOT, STRATEGY_DOC_PATH)}`);
}

main();
