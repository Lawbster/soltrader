/// <reference types="node" />
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

type Row = Record<string, string>;

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const DEFAULT_OUT_ROOT = path.join(DATA_DIR, 'strategy-review-runs');

function utcDateToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function safeStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function writeText(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf8');
}

function getArg(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  return idx >= 0 ? argv[idx + 1] : undefined;
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

function parseCsvList(value: string | undefined, fallback: number[]): number[] {
  if (!value) return fallback;
  const out = value
    .split(',')
    .map(v => Number(v.trim()))
    .filter(v => Number.isFinite(v) && v > 0)
    .map(v => Math.round(v));
  return out.length > 0 ? Array.from(new Set(out)) : fallback;
}

function parseNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseArgs(argv: string[]) {
  const reviewDate = getArg(argv, '--review-date') ?? getArg(argv, '--date') ?? utcDateToday();
  const runId = getArg(argv, '--run-id') ?? `review-${safeStamp()}`;
  return {
    recentFrom: getArg(argv, '--recent-from') ?? '2026-03-14',
    fullFrom: getArg(argv, '--full-from') ?? '2026-02-18',
    to: getArg(argv, '--to') ?? reviewDate,
    reviewDate,
    runId,
    outRoot: path.resolve(getArg(argv, '--out-root') ?? path.join(DEFAULT_OUT_ROOT, runId)),
    timeframes: parseCsvList(getArg(argv, '--timeframes'), [1, 5, 15]),
    recentRobustnessTimeframes: parseCsvList(getArg(argv, '--recent-robustness-timeframes'), [1, 5, 15]),
    fullRobustnessTimeframes: parseCsvList(getArg(argv, '--full-robustness-timeframes'), [1, 5, 15]),
    cost: getArg(argv, '--cost') ?? 'empirical',
    exitParity: getArg(argv, '--exit-parity') ?? 'both',
    windowDays: getArg(argv, '--window-days') ?? '3,5',
    stepDays: parseNumber(getArg(argv, '--step-days'), 2),
    candidateTop: parseNumber(getArg(argv, '--candidate-top'), 2000),
    candidateTopPerToken: parseNumber(getArg(argv, '--candidate-top-per-token'), 300),
    minWorstOtherRegime: parseNumber(getArg(argv, '--min-worst-other-regime'), -10),
    robustnessTop: parseNumber(getArg(argv, '--robustness-top'), 500),
    robustnessTopPerToken: parseNumber(getArg(argv, '--robustness-top-per-token'), 300),
    robustnessReportTop: parseNumber(getArg(argv, '--robustness-report-top'), 30),
    templateHealthTop: parseNumber(getArg(argv, '--template-health-top'), 30),
    slippageTop: parseNumber(getArg(argv, '--slippage-top'), 12),
    dryRun: hasFlag(argv, '--dry-run'),
  };
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map(v => v.trim());
}

function readCsv(filePath: string): Row[] {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map(line => {
    const cells = parseCsvLine(line);
    const row: Row = {};
    headers.forEach((header, index) => {
      row[header] = cells[index] ?? '';
    });
    return row;
  });
}

function toNum(value: string | undefined): number | null {
  if (value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeParams(input: string): string {
  const parts = input.trim().replace(/^"+|"+$/g, '').split(/\s+/).filter(Boolean);
  const kv = new Map<string, number>();
  for (const part of parts) {
    const [key, raw] = part.split('=');
    if (!key || raw === undefined) continue;
    const num = Number(raw.replace(/^"+|"+$/g, ''));
    if (Number.isFinite(num)) kv.set(key.replace(/^"+|"+$/g, ''), num);
  }
  return Array.from(kv.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `${k}=${v}`).join(' ');
}

function exactKey(token: string, regime: string, template: string, timeframe: string | number, params: string): string {
  return [token, regime, template, String(timeframe), normalizeParams(params)].join('|');
}

function familyKey(token: string, regime: string, template: string, timeframe: string | number): string {
  return [token, regime, template, String(timeframe)].join('|');
}

function latestRunDir(rootDir: string): string {
  const dirs = fs.existsSync(rootDir)
    ? fs.readdirSync(rootDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && entry.name.startsWith('run-'))
        .map(entry => path.join(rootDir, entry.name))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    : [];
  if (dirs.length === 0) throw new Error(`No run-* robustness directory found in ${rootDir}`);
  return dirs[0];
}

async function runNpmScript(scriptName: string, args: string[], logFile: string, dryRun: boolean): Promise<void> {
  ensureDir(path.dirname(logFile));
  const displayCommand = `npm run ${scriptName} -- ${args.join(' ')}`.trim();
  const command = process.platform === 'win32' ? 'cmd.exe' : 'npm';
  const fullArgs = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'npm.cmd', 'run', scriptName, '--', ...args]
    : ['run', scriptName, '--', ...args];
  const header = `# ${new Date().toISOString()}\n${displayCommand}\n\n`;
  if (dryRun) {
    writeText(logFile, `${header}[dry-run]\n`);
    console.log(`[dry-run] ${displayCommand}`);
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const stream = fs.createWriteStream(logFile, { flags: 'w' });
    stream.write(header);
    const child = spawn(command, fullArgs, { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => { process.stdout.write(chunk); stream.write(chunk); });
    child.stderr.on('data', chunk => { process.stderr.write(chunk); stream.write(chunk); });
    child.on('error', err => { stream.end(); reject(err); });
    child.on('close', code => {
      stream.end();
      if (code === 0) resolve();
      else reject(new Error(`${scriptName} failed with exit code ${code}`));
    });
  });
}

function createBundle(baseRoot: string, id: string, reviewDate: string, from: string, to: string, timeframes: number[], robustnessTimeframes: number[]) {
  const rootDir = path.join(baseRoot, id);
  const sweepDir = path.join(rootDir, 'sweeps');
  const candidateDir = path.join(rootDir, 'candidates');
  const reportsDir = path.join(rootDir, 'reports');
  const logsDir = path.join(rootDir, 'logs');
  const robustnessRootDir = path.join(rootDir, 'window-robustness');
  const sweepFiles: Record<string, string> = {};
  for (const tf of timeframes) {
    sweepFiles[String(tf)] = path.join(sweepDir, `${reviewDate}-${tf}min.csv`);
  }
  return {
    id,
    from,
    to,
    timeframes,
    robustnessTimeframes,
    rootDir,
    sweepDir,
    candidateDir,
    reportsDir,
    logsDir,
    robustnessRootDir,
    sweepFiles,
    liveSummaryCsv: path.join(reportsDir, `${reviewDate}.live-candidate-summary.csv`),
    liveSummaryMd: path.join(reportsDir, `${reviewDate}.live-candidate-summary.md`),
    robustnessReport: path.join(reportsDir, `${reviewDate}.robustness-report.txt`),
    templateHealthDir: path.join(reportsDir, 'template-health'),
  };
}

async function runBundle(args: ReturnType<typeof parseArgs>, bundle: ReturnType<typeof createBundle>): Promise<string | null> {
  ensureDir(bundle.sweepDir);
  ensureDir(bundle.candidateDir);
  ensureDir(bundle.reportsDir);
  ensureDir(bundle.logsDir);
  ensureDir(bundle.robustnessRootDir);

  for (const tf of bundle.timeframes) {
    await runNpmScript('sweep', [
      '--timeframe', String(tf),
      '--cost', args.cost,
      '--from', bundle.from,
      '--to', bundle.to,
      '--exit-parity', args.exitParity,
      '--out-file', bundle.sweepFiles[String(tf)],
    ], path.join(bundle.logsDir, `sweep-${tf}min.log`), args.dryRun);
  }

  for (const tf of bundle.timeframes) {
    await runNpmScript('sweep-candidates', [
      '--file', bundle.sweepFiles[String(tf)],
      '--top', String(args.candidateTop),
      '--top-per-token', String(args.candidateTopPerToken),
      '--min-worst-other-regime', String(args.minWorstOtherRegime),
      '--out-dir', bundle.candidateDir,
    ], path.join(bundle.logsDir, `candidates-${tf}min.log`), args.dryRun);
  }

  await runNpmScript('sweep-robustness', [
    '--from', bundle.from,
    '--to', bundle.to,
    '--window-days', args.windowDays,
    '--step-days', String(args.stepDays),
    '--timeframes', bundle.robustnessTimeframes.join(','),
    '--cost', args.cost,
    '--exit-parity', args.exitParity,
    '--rank-exit-parity', 'indicator',
    '--top', String(args.robustnessTop),
    '--top-per-token', String(args.robustnessTopPerToken),
    '--out-dir', bundle.robustnessRootDir,
  ], path.join(bundle.logsDir, 'robustness.log'), args.dryRun);

  const robustnessRunDir = args.dryRun ? null : latestRunDir(bundle.robustnessRootDir);

  await runNpmScript('robustness-report', [
    '--run-dir', robustnessRunDir ?? bundle.robustnessRootDir,
    '--top', String(args.robustnessReportTop),
  ], bundle.robustnessReport, args.dryRun);

  await runNpmScript('template-health', [
    '--files', bundle.timeframes.map(tf => bundle.sweepFiles[String(tf)]).join(','),
    '--exit-parity', args.exitParity,
    '--top', String(args.templateHealthTop),
    '--out-dir', bundle.templateHealthDir,
  ], path.join(bundle.logsDir, 'template-health.log'), args.dryRun);

  await runNpmScript('live-candidate-summary', [
    '--sweep-date', args.reviewDate,
    '--candidate-dir', bundle.candidateDir,
    '--sweep-dir', bundle.sweepDir,
    '--out-dir', bundle.reportsDir,
  ], path.join(bundle.logsDir, 'live-candidate-summary.log'), args.dryRun);

  return robustnessRunDir;
}

async function runSupportReports(args: ReturnType<typeof parseArgs>, outRoot: string) {
  const reportsDir = path.join(outRoot, 'support-reports');
  ensureDir(reportsDir);
  const dailyQaMd = path.join(reportsDir, `${args.reviewDate}.daily-qa-report.md`);
  const dailyQaJson = path.join(reportsDir, `${args.reviewDate}.daily-qa-report.json`);
  const slippageTxt = path.join(reportsDir, `${args.reviewDate}.slippage-report.txt`);

  await runNpmScript('daily-qa-report', [
    '--from', args.recentFrom,
    '--to', args.to,
    '--out', dailyQaMd,
    '--json-out', dailyQaJson,
  ], path.join(reportsDir, 'daily-qa-report.log'), args.dryRun);

  await runNpmScript('slippage-report', [
    '--from', args.recentFrom,
    '--to', args.to,
    '--top', String(args.slippageTop),
  ], slippageTxt, args.dryRun);

  return { dailyQaMd, dailyQaJson, slippageTxt };
}

function volumeSensitive(template: string): boolean {
  const value = template.toLowerCase();
  return value.includes('volume') || value.includes('obv') || value.includes('vwap');
}

function topExactRows(runDir: string | null): Row[] {
  if (!runDir) return [];
  return readCsv(path.join(runDir, 'stability-exact-ranked.csv')).filter(row => row.exitParity === 'indicator').slice(0, 12);
}

function topFamilyRows(runDir: string | null): Row[] {
  if (!runDir) return [];
  return readCsv(path.join(runDir, 'stability-family-ranked.csv')).filter(row => row.exitParity === 'indicator').slice(0, 12);
}

function summarizeSuggestions(reviewDate: string, recentBundle: ReturnType<typeof createBundle>, fullBundle: ReturnType<typeof createBundle>, recentRunDir: string | null, fullRunDir: string | null) {
  const recentExact = topExactRows(recentRunDir);
  const fullExact = topExactRows(fullRunDir);
  const recentFamily = new Map(topFamilyRows(recentRunDir).map(row => [familyKey(row.token, row.trendRegime, row.template, row.timeframe), row]));
  const fullFamily = new Map(topFamilyRows(fullRunDir).map(row => [familyKey(row.token, row.trendRegime, row.template, row.timeframe), row]));
  const recentCandidateFiles = recentBundle.timeframes.map(tf => path.join(recentBundle.candidateDir, `${reviewDate}-${tf}min.core-ranked.csv`));
  const fullCandidateFiles = fullBundle.timeframes.map(tf => path.join(fullBundle.candidateDir, `${reviewDate}-${tf}min.core-ranked.csv`));
  const recentCandidates = new Map(recentCandidateFiles.flatMap(readCsv).map(row => [exactKey(row.token, row.trendRegime, row.template, row.timeframe, row.params), row]));
  const fullCandidates = new Map(fullCandidateFiles.flatMap(readCsv).map(row => [exactKey(row.token, row.trendRegime, row.template, row.timeframe, row.params), row]));
  const fullExactMap = new Map(fullExact.map(row => [exactKey(row.token, row.trendRegime, row.template, row.timeframe, row.params), row]));

  const rows = recentExact.map(row => {
    const key = exactKey(row.token, row.trendRegime, row.template, row.timeframe, row.params);
    const full = fullExactMap.get(key);
    const recentCandidate = recentCandidates.get(key);
    const fullCandidate = fullCandidates.get(key);
    const recentFamilyRow = recentFamily.get(familyKey(row.token, row.trendRegime, row.template, row.timeframe));
    const fullFamilyRow = fullFamily.get(familyKey(row.token, row.trendRegime, row.template, row.timeframe));
    const recentStrong = (toNum(row.worstPnlPct) ?? -999) > 0 && (toNum(row.consistencyScore) ?? 0) > 0 && !!recentCandidate;
    const fullStrong = !!full && (toNum(full.worstPnlPct) ?? -999) > 0 && (toNum(full.consistencyScore) ?? 0) > 0 && !!fullCandidate;
    const familyStrong = !!recentFamilyRow && !!fullFamilyRow && (toNum(recentFamilyRow.worstPnlPct) ?? -999) > 0 && (toNum(fullFamilyRow.worstPnlPct) ?? -999) > 0;
    let disposition = 'investigate';
    if (recentStrong && fullStrong && familyStrong) disposition = 'promote candidate';
    else if (volumeSensitive(row.template) && recentStrong && !fullStrong) disposition = 'need more data';
    const reason = disposition === 'promote candidate'
      ? 'positive exact and family robustness in both windows'
      : full
        ? 'cross-window disagreement or weak family support'
        : 'recent strength not confirmed by full-history exact robustness';
    return {
      disposition,
      token: row.token,
      regime: row.trendRegime,
      template: row.template,
      timeframe: row.timeframe,
      params: normalizeParams(row.params),
      recentConsistency: toNum(row.consistencyScore) ?? 0,
      fullConsistency: toNum(full?.consistencyScore) ?? 0,
      recentWorstPnlPct: toNum(row.worstPnlPct),
      fullWorstPnlPct: toNum(full?.worstPnlPct),
      reason,
    };
  }).sort((a, b) => ((b.recentConsistency * 2 + b.fullConsistency) - (a.recentConsistency * 2 + a.fullConsistency)));

  return {
    topRecentExact: recentExact,
    topFullExact: fullExact,
    topRecentFamily: Array.from(recentFamily.values()).slice(0, 12),
    topFullFamily: Array.from(fullFamily.values()).slice(0, 12),
    suggestions: rows.slice(0, 20),
    liveRoutesRecent: readCsv(recentBundle.liveSummaryCsv),
    liveRoutesFull: readCsv(fullBundle.liveSummaryCsv),
  };
}

function writeSummary(runRoot: string, manifestPath: string, summaryPath: string, summaryJsonPath: string, summary: ReturnType<typeof summarizeSuggestions>, support: Awaited<ReturnType<typeof runSupportReports>>) {
  writeText(summaryJsonPath, JSON.stringify(summary, null, 2));
  const fullMap = new Map(summary.liveRoutesFull.map(row => [row.routeId, row]));
  const liveRouteLines = summary.liveRoutesRecent.length === 0
    ? ['No live route summary rows found.']
    : [
        '| Route | Token | Regime | TF | Template | Recent | Full |',
        '| --- | --- | --- | ---: | --- | --- | --- |',
        ...summary.liveRoutesRecent.map(row => {
          const full = fullMap.get(row.routeId);
          const recentState = row.candidateRank ? 'exact-match' : row.sweepFound === 'yes' ? 'sweep-only' : 'missing';
          const fullState = full ? (full.candidateRank ? 'exact-match' : full.sweepFound === 'yes' ? 'sweep-only' : 'missing') : 'missing';
          return `| \`${row.routeId}\` | ${row.token} | ${row.regime} | ${row.timeframeMinutes}m | ${row.templateId} | ${recentState} | ${fullState} |`;
        }),
      ];
  const suggestionLines = summary.suggestions.length === 0
    ? ['No suggestion rows generated.']
    : [
        '| Disposition | Token | Regime | Template | TF | Recent Consistency | Full Consistency | Recent Worst PnL | Full Worst PnL | Reason |',
        '| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |',
        ...summary.suggestions.map(row => `| ${row.disposition} | ${row.token} | ${row.regime} | ${row.template} | ${row.timeframe}m | ${row.recentConsistency.toFixed(3)} | ${row.fullConsistency.toFixed(3)} | ${row.recentWorstPnlPct?.toFixed(2) ?? '-'}% | ${row.fullWorstPnlPct?.toFixed(2) ?? '-'}% | ${row.reason} |`),
      ];
  writeText(summaryPath, [
    '# Strategy Review Run Summary',
    '',
    `- Manifest: \`${manifestPath}\``,
    `- Support reports: \`${path.dirname(support.dailyQaMd)}\``,
    '',
    '## Live Route Status',
    '',
    ...liveRouteLines,
    '',
    '## Suggested Route Outcomes',
    '',
    ...suggestionLines,
  ].join('\n') + '\n');
}

function writeAgentPrompts(runRoot: string, manifestPath: string, summaryPath: string, support: Awaited<ReturnType<typeof runSupportReports>>) {
  const promptDir = path.join(runRoot, 'agent-prompts');
  ensureDir(promptDir);
  const shared = [
    `Manifest JSON: ${manifestPath}`,
    `Summary MD: ${summaryPath}`,
    `Daily QA: ${support.dailyQaMd}`,
    `Slippage report: ${support.slippageTxt}`,
    '',
    'Rubric order:',
    '1. Recent real-volume viability',
    '2. Longer-history sanity',
    '3. Exact robustness inside each window',
    '4. Family robustness inside each window',
    '5. Live expressibility and parity',
    '6. Data quality and sample quality',
    '',
    'Allowed dispositions: keep, trim, disable, investigate, promote candidate, need more data',
    'Cross-window labels: cross-window, recent-only, full-history-only, volume-sensitive',
    '',
  ].join('\n');
  const prompts: Record<string, string> = {
    'stale-route-cutter.md': `${shared}Role:\nReview currently enabled live routes only and return keep/trim/disable/investigate for each route.\n`,
    'new-family-finder.md': `${shared}Role:\nFind the strongest new family opportunities from the evidence pack. Prefer cross-window support over single-window noise.\n`,
    'parity-live-feasibility-auditor.md': `${shared}Role:\nAudit research winners for live translation risk using recent-window behavior, slippage, QA, and live-route exact-match drift.\n`,
    'data-sufficiency-auditor.md': `${shared}Role:\nIdentify exact missing fields or logging gaps that block confident route decisions. Name the field and the decision it unlocks.\n`,
    'candle-ideation.md': `${shared}Role:\nOnly use after the first four passes on shortlisted families. Generate hypotheses, not promotions.\n`,
  };
  for (const [fileName, content] of Object.entries(prompts)) {
    writeText(path.join(promptDir, fileName), content);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  ensureDir(args.outRoot);

  const recentBundle = createBundle(args.outRoot, 'recent-real-volume', args.reviewDate, args.recentFrom, args.to, args.timeframes, args.recentRobustnessTimeframes);
  const fullBundle = createBundle(args.outRoot, 'full-history', args.reviewDate, args.fullFrom, args.to, args.timeframes, args.fullRobustnessTimeframes);
  const manifestPath = path.join(args.outRoot, 'evidence-manifest.json');
  const summaryPath = path.join(args.outRoot, 'strategy-review-summary.md');
  const summaryJsonPath = path.join(args.outRoot, 'strategy-review-summary.json');

  writeText(manifestPath, JSON.stringify({
    runId: args.runId,
    createdAt: new Date().toISOString(),
    reviewDate: args.reviewDate,
    recentFrom: args.recentFrom,
    fullFrom: args.fullFrom,
    to: args.to,
    outRoot: args.outRoot,
    recentBundle,
    fullBundle,
  }, null, 2));

  console.log(`\n== Strategy review run: ${args.runId} ==`);
  console.log(`Output root: ${args.outRoot}`);

  const recentRunDir = await runBundle(args, recentBundle);
  const fullRunDir = await runBundle(args, fullBundle);
  const support = await runSupportReports(args, args.outRoot);

  writeText(manifestPath, JSON.stringify({
    runId: args.runId,
    createdAt: new Date().toISOString(),
    reviewDate: args.reviewDate,
    recentFrom: args.recentFrom,
    fullFrom: args.fullFrom,
    to: args.to,
    outRoot: args.outRoot,
    recentBundle: { ...recentBundle, robustnessRunDir: recentRunDir },
    fullBundle: { ...fullBundle, robustnessRunDir: fullRunDir },
    support,
  }, null, 2));

  if (!args.dryRun) {
    const summary = summarizeSuggestions(args.reviewDate, recentBundle, fullBundle, recentRunDir, fullRunDir);
    writeSummary(args.outRoot, manifestPath, summaryPath, summaryJsonPath, summary, support);
  }
  writeAgentPrompts(args.outRoot, manifestPath, summaryPath, support);

  console.log('\nCompleted strategy review run.');
  console.log(`Manifest: ${manifestPath}`);
  if (!args.dryRun) console.log(`Summary: ${summaryPath}`);
}

main().catch((err) => {
  console.error(`strategy-review-run failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
