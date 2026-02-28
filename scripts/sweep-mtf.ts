import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

type CostMode = 'fixed' | 'empirical';
type ExitParityMode = 'indicator' | 'price' | 'both';
type RankExitParityMode = 'indicator' | 'price' | 'both';

interface CliArgs {
  template?: string;
  token?: string;
  from?: string;
  to?: string;
  cost: CostMode;
  exitParity: ExitParityMode;
  maxPositions?: number;
  timeframes: number[];
  sweepDir: string;
  top: number;
  topPerToken: number;
  minWinRate: number;
  minPnl: number;
  rankExitParity: RankExitParityMode;
  requireTimeframes: boolean;
  timeframeSupportMin?: number;
  outDir?: string;
  noCsv: boolean;
  dryRun: boolean;
}

function printHelp(): void {
  const lines = [
    'Usage:',
    '  npm run sweep-mtf -- [template] [token] [options]',
    '',
    'Examples:',
    '  npm run sweep-mtf -- --cost empirical --from 2026-02-18',
    '  npm run sweep-mtf -- rsi PUMP --cost empirical --from 2026-02-18 --to 2026-02-28',
    '  npm run sweep-mtf -- --timeframes 1,5 --require-timeframes --top 300 --top-per-token 75',
    '',
    'Options:',
    '  --from YYYY-MM-DD            Sweep start date',
    '  --to YYYY-MM-DD              Sweep end date',
    '  --cost fixed|empirical       Cost mode for sweep (default: empirical)',
    '  --exit-parity MODE           indicator|price|both (default: both)',
    '  --max-positions N            Max concurrent positions per token in backtest',
    '  --timeframes CSV             Timeframes in minutes, e.g. 1,5,15 (default: 1,5,15)',
    '  --sweep-dir PATH             Sweep output directory (default: data/sweep-results)',
    '  --top N                      Candidate output cap (default: 300)',
    '  --top-per-token N            Candidate cap per token (default: 75)',
    '  --min-win-rate N             Candidates filter (default: 65)',
    '  --min-pnl N                  Candidates filter (default: 0)',
    '  --rank-exit-parity MODE      indicator|price|both (default: indicator)',
    '  --require-timeframes         Require candidates to exist on every selected timeframe (default: enabled)',
    '  --no-require-timeframes      Disable strict cross-timeframe requirement',
    '  --timeframe-support-min N    Minimum timeframe support count (default: all timeframes when strict, else 1)',
    '  --out-dir PATH               Candidates output directory override',
    '  --no-csv                     Do not write candidate CSV files',
    '  --dry-run                    Print commands without executing',
    '  -h, --help                   Show help',
  ];
  console.log(lines.join('\n'));
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parseNumber(flag: string, value: string | undefined): number {
  const parsed = Number(requireValue(flag, value));
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric value for ${flag}: ${value}`);
  }
  return parsed;
}

function parseEnum<T extends string>(flag: string, value: string | undefined, allowed: readonly T[]): T {
  const v = requireValue(flag, value) as T;
  if (!allowed.includes(v)) {
    throw new Error(`Invalid ${flag}: ${v}. Allowed: ${allowed.join(', ')}`);
  }
  return v;
}

function parseTimeframes(csv: string): number[] {
  const parsed = csv
    .split(',')
    .map(v => Number(v.trim()))
    .filter(v => Number.isFinite(v) && v >= 1)
    .map(v => Math.round(v));
  const unique = Array.from(new Set(parsed)).sort((a, b) => a - b);
  if (unique.length === 0) {
    throw new Error(`Invalid --timeframes value: ${csv}`);
  }
  return unique;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    cost: 'empirical',
    exitParity: 'both',
    timeframes: [1, 5, 15],
    sweepDir: 'data/sweep-results',
    top: 300,
    topPerToken: 75,
    minWinRate: 65,
    minPnl: 0,
    rankExitParity: 'indicator',
    requireTimeframes: true,
    noCsv: false,
    dryRun: false,
  };

  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }

    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }

    if (arg === '--from') {
      args.from = requireValue(arg, next);
      i++;
      continue;
    }
    if (arg === '--to') {
      args.to = requireValue(arg, next);
      i++;
      continue;
    }
    if (arg === '--cost') {
      args.cost = parseEnum(arg, next, ['fixed', 'empirical']);
      i++;
      continue;
    }
    if (arg === '--exit-parity') {
      args.exitParity = parseEnum(arg, next, ['indicator', 'price', 'both']);
      i++;
      continue;
    }
    if (arg === '--max-positions') {
      args.maxPositions = Math.max(1, Math.round(parseNumber(arg, next)));
      i++;
      continue;
    }
    if (arg === '--timeframes') {
      args.timeframes = parseTimeframes(requireValue(arg, next));
      i++;
      continue;
    }
    if (arg === '--sweep-dir') {
      args.sweepDir = requireValue(arg, next);
      i++;
      continue;
    }
    if (arg === '--top') {
      args.top = Math.max(1, Math.round(parseNumber(arg, next)));
      i++;
      continue;
    }
    if (arg === '--top-per-token') {
      args.topPerToken = Math.max(1, Math.round(parseNumber(arg, next)));
      i++;
      continue;
    }
    if (arg === '--min-win-rate') {
      args.minWinRate = parseNumber(arg, next);
      i++;
      continue;
    }
    if (arg === '--min-pnl') {
      args.minPnl = parseNumber(arg, next);
      i++;
      continue;
    }
    if (arg === '--rank-exit-parity') {
      args.rankExitParity = parseEnum(arg, next, ['indicator', 'price', 'both']);
      i++;
      continue;
    }
    if (arg === '--require-timeframes') {
      args.requireTimeframes = true;
      continue;
    }
    if (arg === '--no-require-timeframes') {
      args.requireTimeframes = false;
      continue;
    }
    if (arg === '--timeframe-support-min') {
      args.timeframeSupportMin = Math.max(1, Math.round(parseNumber(arg, next)));
      i++;
      continue;
    }
    if (arg === '--out-dir') {
      args.outDir = requireValue(arg, next);
      i++;
      continue;
    }
    if (arg === '--no-csv') {
      args.noCsv = true;
      continue;
    }
    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (positional.length > 2) {
    throw new Error(`Too many positional args: ${positional.join(' ')}. Expected [template] [token].`);
  }
  args.template = positional[0];
  args.token = positional[1];

  return args;
}

function npmBin(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function quoteForCmd(arg: string): string {
  if (arg.length === 0) return '""';
  if (!/[ \t"&^|<>]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

function run(rootDir: string, cmdArgs: string[], dryRun: boolean): void {
  const display = `npm ${cmdArgs.join(' ')}`;
  console.log(`\n$ ${display}`);
  if (dryRun) return;

  const res = process.platform === 'win32'
    ? spawnSync(
        process.env.ComSpec || 'cmd.exe',
        ['/d', '/s', '/c', `${npmBin()} ${cmdArgs.map(quoteForCmd).join(' ')}`],
        { cwd: rootDir, stdio: 'inherit', shell: false },
      )
    : spawnSync(npmBin(), cmdArgs, { cwd: rootDir, stdio: 'inherit', shell: false });

  if (res.error) {
    throw new Error(`Command spawn error: ${res.error.message} (${display})`);
  }
  if (res.status !== 0) {
    throw new Error(`Command failed (${res.status ?? 'unknown'}): ${display}`);
  }
}

function findLatestSweepFileForTimeframe(sweepDirAbs: string, timeframe: number): string {
  if (!fs.existsSync(sweepDirAbs)) {
    throw new Error(`Sweep directory not found: ${sweepDirAbs}`);
  }
  const suffix = `-${timeframe}min.csv`;
  const files = fs.readdirSync(sweepDirAbs, { withFileTypes: true })
    .filter(d => d.isFile() && d.name.endsWith(suffix))
    .map(d => path.join(sweepDirAbs, d.name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (files.length === 0) {
    throw new Error(`No sweep output found for timeframe ${timeframe}m in ${sweepDirAbs}`);
  }
  return files[0];
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const rootDir = path.resolve(__dirname, '..');
  const sweepDirAbs = path.resolve(rootDir, args.sweepDir);

  const sweepFiles: string[] = [];

  for (const tf of args.timeframes) {
    const sweepCmd: string[] = ['run', 'sweep', '--'];
    if (args.template) sweepCmd.push(args.template);
    if (args.token) sweepCmd.push(args.token);
    sweepCmd.push('--timeframe', String(tf));
    sweepCmd.push('--cost', args.cost);
    sweepCmd.push('--exit-parity', args.exitParity);
    if (args.from) sweepCmd.push('--from', args.from);
    if (args.to) sweepCmd.push('--to', args.to);
    if (args.maxPositions !== undefined) sweepCmd.push('--max-positions', String(args.maxPositions));

    run(rootDir, sweepCmd, args.dryRun);

    // In dry-run mode there may be no files generated, so skip lookup.
    if (!args.dryRun) {
      const latest = findLatestSweepFileForTimeframe(sweepDirAbs, tf);
      sweepFiles.push(latest);
      console.log(`Detected output (${tf}m): ${latest}`);
    }
  }

  const filesArg = args.dryRun
    ? args.timeframes.map(tf => path.join(args.sweepDir, `YYYY-MM-DD-${tf}min.csv`)).join(',')
    : sweepFiles.join(',');

  const candidatesCmd: string[] = [
    'run', 'sweep-candidates', '--',
    '--files', filesArg,
    '--top', String(args.top),
    '--top-per-token', String(args.topPerToken),
    '--min-win-rate', String(args.minWinRate),
    '--min-pnl', String(args.minPnl),
    '--rank-exit-parity', args.rankExitParity,
  ];

  if (args.requireTimeframes) {
    candidatesCmd.push('--require-timeframes', args.timeframes.join(','));
  } else if (args.timeframeSupportMin !== undefined) {
    // Explicitly set support requirement only when not strict.
    candidatesCmd.push('--timeframe-support-min', String(args.timeframeSupportMin));
  }

  if (!args.requireTimeframes && args.timeframeSupportMin === undefined) {
    candidatesCmd.push('--timeframe-support-min', '1');
  }

  if (args.outDir) {
    candidatesCmd.push('--out-dir', args.outDir);
  }
  if (args.noCsv) {
    candidatesCmd.push('--no-csv');
  }

  run(rootDir, candidatesCmd, args.dryRun);

  if (args.dryRun) {
    console.log('\nDry run complete.');
    return;
  }

  console.log('\nMTF sweep + candidate extraction complete.');
}

try {
  main();
} catch (err) {
  console.error(`sweep-mtf failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
