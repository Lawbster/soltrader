import { PublicKey } from '@solana/web3.js';
import { getConnection, createLogger } from '../utils';
import { TokenData } from './types';

const log = createLogger('token-data');

// Cache mint creation timestamps — never changes for a given mint
const mintCreationCache = new Map<string, number>(); // mint → epoch ms

async function getMintCreationTime(mint: string): Promise<number | null> {
  const cached = mintCreationCache.get(mint);
  if (cached) return cached;

  try {
    const conn = getConnection();
    const mintPubkey = new PublicKey(mint);

    // Single RPC call: fetch one page of signatures (newest-first).
    // The last entry in this batch is a good lower bound for age.
    // For tokens with <1000 total txs, this IS the creation tx.
    // For busy tokens with 1000+ txs, the oldest in this page gives a
    // conservative age estimate (actual age >= this). Good enough for
    // the 60-360min filter — if a token has 1000+ txs it's definitely
    // old enough to pass the minimum age gate.
    const sigs = await conn.getSignaturesForAddress(
      mintPubkey,
      { limit: 1000 },
      'confirmed'
    );

    if (sigs.length === 0) return null;

    const oldest = sigs[sigs.length - 1];
    if (oldest?.blockTime) {
      const creationMs = oldest.blockTime * 1000;
      mintCreationCache.set(mint, creationMs);
      return creationMs;
    }

    return null;
  } catch (err) {
    log.debug('Failed to get mint creation time, using fallback', { mint, error: err });
    return null;
  }
}

// Cache mint metadata — decimals, supply, authority flags barely change for established tokens
const MINT_METADATA_TTL = 30 * 60_000; // 30 minutes
interface MintMetadata {
  decimals: number;
  totalSupply: number;
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  fetchedAt: number;
}
const mintMetadataCache = new Map<string, MintMetadata>();

async function getMintMetadata(mint: string): Promise<MintMetadata | null> {
  const cached = mintMetadataCache.get(mint);
  if (cached && Date.now() - cached.fetchedAt < MINT_METADATA_TTL) {
    return cached;
  }

  try {
    const conn = getConnection();
    const mintPubkey = new PublicKey(mint);
    const mintInfo = await conn.getParsedAccountInfo(mintPubkey);
    const mintData = mintInfo.value?.data;
    if (!mintData || !('parsed' in mintData)) {
      log.warn('Could not parse mint account', { mint });
      return null;
    }

    const info = mintData.parsed.info;
    const decimals: number = info.decimals;
    const totalSupply = parseFloat(info.supply) / Math.pow(10, decimals);
    const meta: MintMetadata = {
      decimals,
      totalSupply,
      mintAuthorityRevoked: info.mintAuthority === null,
      freezeAuthorityRevoked: info.freezeAuthority === null,
      fetchedAt: Date.now(),
    };
    mintMetadataCache.set(mint, meta);
    log.debug('Mint metadata refreshed', { mint, decimals, totalSupply: Math.round(totalSupply) });
    return meta;
  } catch (err) {
    // Return stale cache on error rather than failing
    if (cached) {
      log.debug('Mint metadata RPC failed, using stale cache', { mint });
      return cached;
    }
    log.error('Failed to fetch mint metadata', { mint, error: err });
    return null;
  }
}

const SOL_PRICE_CACHE = { price: 0, fetchedAt: 0 };
const SOL_PRICE_TTL = 30_000; // 30s
const TOKEN_PRICE_TTL = 30_000; // 30s
const LIQUIDITY_TTL = 5 * 60_000; // 5 min — liquidity depth doesn't change fast for position sizing
const LIQUIDITY_FAIL_TTL = 60_000; // 1 min negative cache on failures to avoid hammering Jupiter

const tokenPriceCache = new Map<string, { priceSol: number; priceUsd: number; fetchedAt: number }>();
const liquidityCache = new Map<string, { liquidityUsd: number; fetchedAt: number }>();

/** Wrapper with 429 backoff for all Jupiter API calls */
async function jupiterFetch(url: string, maxRetries = 2): Promise<Response> {
  let lastRes: Response | undefined;
  for (let i = 0; i <= maxRetries; i++) {
    lastRes = await fetch(url);
    if (lastRes.status === 429) {
      const retryAfter = parseInt(lastRes.headers.get('retry-after') || '2', 10);
      const backoffMs = Math.min(retryAfter * 1000, 10_000);
      log.warn('Jupiter rate limited, backing off', { backoffMs, attempt: i + 1 });
      await new Promise(r => setTimeout(r, backoffMs));
      continue;
    }
    return lastRes;
  }
  // Return last 429 response so caller can handle it — no extra fetch
  return lastRes!;
}

function extractUsdPrice(entry: any): number {
  if (!entry) return 0;
  if (typeof entry.usdPrice === 'number') return entry.usdPrice;
  if (typeof entry.price === 'number') return entry.price;
  if (typeof entry.price === 'string') return parseFloat(entry.price);
  return 0;
}

async function getSolPrice(): Promise<number> {
  if (Date.now() - SOL_PRICE_CACHE.fetchedAt < SOL_PRICE_TTL && SOL_PRICE_CACHE.price > 0) {
    return SOL_PRICE_CACHE.price;
  }

  try {
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    const res = await jupiterFetch(`https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`);
    if (!res.ok) return SOL_PRICE_CACHE.price || 150;
    const json = await res.json() as any;
    const entry = json.data?.[SOL_MINT] ?? json[SOL_MINT];
    const price = extractUsdPrice(entry);
    if (price > 0) {
      SOL_PRICE_CACHE.price = price;
      SOL_PRICE_CACHE.fetchedAt = Date.now();
    }
    return price;
  } catch (err) {
    log.error('Failed to fetch SOL price', err);
    return SOL_PRICE_CACHE.price || 150; // Fallback
  }
}

/**
 * Batch price fetch — one Jupiter call for all mints + SOL.
 * Populates tokenPriceCache and SOL_PRICE_CACHE so individual
 * fetchTokenPrice calls hit cache for the rest of the cycle.
 */
export async function fetchTokenPricesBatch(mints: string[]): Promise<void> {
  const SOL_MINT = 'So11111111111111111111111111111111111111112';
  const allIds = new Set(mints);
  allIds.add(SOL_MINT); // Always include SOL for priceSol calculation

  try {
    const ids = Array.from(allIds).join(',');
    const res = await jupiterFetch(`https://lite-api.jup.ag/price/v3?ids=${ids}`);
    if (!res.ok) {
      log.warn('Batch price fetch failed', { status: res.status });
      return;
    }
    const json = await res.json() as any;
    const data = json.data ?? json;

    // Update SOL price first
    const solEntry = data[SOL_MINT];
    const solPrice = extractUsdPrice(solEntry);
    if (solPrice > 0) {
      SOL_PRICE_CACHE.price = solPrice;
      SOL_PRICE_CACHE.fetchedAt = Date.now();
    }
    const effectiveSolPrice = solPrice > 0 ? solPrice : (SOL_PRICE_CACHE.price || 150);

    // Update each token's cache
    const now = Date.now();
    for (const mint of mints) {
      const entry = data[mint];
      const priceUsd = extractUsdPrice(entry);
      const priceSol = effectiveSolPrice > 0 ? priceUsd / effectiveSolPrice : 0;
      tokenPriceCache.set(mint, { priceSol, priceUsd, fetchedAt: now });
    }

    log.debug('Batch price fetch', { tokens: mints.length, solPrice: effectiveSolPrice });
  } catch (err) {
    log.error('Batch price fetch failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

/** Lightweight price fetch — Jupiter only, no RPC calls. Uses cache from batch fetch. */
export async function fetchTokenPrice(mint: string): Promise<{ priceSol: number; priceUsd: number }> {
  const cached = tokenPriceCache.get(mint);
  if (cached && Date.now() - cached.fetchedAt < TOKEN_PRICE_TTL) {
    return { priceSol: cached.priceSol, priceUsd: cached.priceUsd };
  }

  try {
    const res = await jupiterFetch(`https://lite-api.jup.ag/price/v3?ids=${mint}`);
    if (!res.ok) {
      log.warn('Token price fetch HTTP error', { mint, status: res.status });
      return cached ? { priceSol: cached.priceSol, priceUsd: cached.priceUsd } : { priceSol: 0, priceUsd: 0 };
    }
    const json = await res.json() as any;
    const entry = json.data?.[mint] ?? json[mint];
    const priceUsd = extractUsdPrice(entry);
    const solPrice = await getSolPrice();
    const priceSol = solPrice > 0 ? priceUsd / solPrice : 0;
    tokenPriceCache.set(mint, { priceSol, priceUsd, fetchedAt: Date.now() });
    return { priceSol, priceUsd };
  } catch (err) {
    log.error('Failed to fetch token price', { mint, error: err instanceof Error ? err.message : String(err) });
    return cached ? { priceSol: cached.priceSol, priceUsd: cached.priceUsd } : { priceSol: 0, priceUsd: 0 };
  }
}

export async function fetchTokenData(
  mint: string,
  detectedAt: number
): Promise<TokenData | null> {
  try {
    // Mint metadata is cached (30-min TTL) — no RPC call on cache hit
    const [meta, priceData] = await Promise.all([
      getMintMetadata(mint),
      fetchTokenPrice(mint),
    ]);

    if (!meta) return null;

    const { decimals, totalSupply, mintAuthorityRevoked, freezeAuthorityRevoked } = meta;

    // Market cap
    const mcapUsd = totalSupply * priceData.priceUsd;

    // Token age — prefer on-chain creation time, fall back to detection time
    const creationTime = await getMintCreationTime(mint);
    const ageReferenceMs = creationTime || detectedAt;
    const tokenAgeMins = (Date.now() - ageReferenceMs) / 60_000;

    const data: TokenData = {
      mint,
      mintAuthorityRevoked,
      freezeAuthorityRevoked,
      totalSupply,
      decimals,
      priceSol: priceData.priceSol,
      priceUsd: priceData.priceUsd,
      mcapUsd,
      liquidityUsd: 0, // Needs pool query — enriched separately
      volume5mUsd: 0,  // Computed from trade tracker
      top10HolderPct: 0,
      holderCount: 0,
      tokenAgeMins,
      fetchedAt: Date.now(),
    };

    log.debug('Token data fetched', {
      mint,
      mcapUsd: Math.round(mcapUsd),
      mintRevoked: mintAuthorityRevoked,
      freezeRevoked: freezeAuthorityRevoked,
    });

    return data;
  } catch (err) {
    log.error('Failed to fetch token data', { mint, error: err });
    return null;
  }
}

/** Read cached liquidity without triggering API calls (for dashboard) */
export function getPoolLiquidityCached(mint: string): number {
  return liquidityCache.get(mint)?.liquidityUsd ?? 0;
}

/** Read cached price without triggering API calls (for dashboard) */
export function getTokenPriceCached(mint: string): { priceSol: number; priceUsd: number } {
  const cached = tokenPriceCache.get(mint);
  return cached ? { priceSol: cached.priceSol, priceUsd: cached.priceUsd } : { priceSol: 0, priceUsd: 0 };
}

export async function fetchPoolLiquidity(mint: string): Promise<number> {
  // Query Jupiter for route to estimate liquidity depth
  try {
    const cached = liquidityCache.get(mint);
    if (cached && Date.now() - cached.fetchedAt < LIQUIDITY_TTL) {
      return cached.liquidityUsd;
    }

    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

    // For SOL, quote USDC→SOL instead of SOL→SOL (which Jupiter rejects)
    const isSol = mint === SOL_MINT;
    const inputMint = isSol ? USDC_MINT : SOL_MINT;
    const amount = isSol ? 100_000_000 : 1_000_000_000; // 100 USDC (6 dec) or 1 SOL (9 dec)
    const quoteValueUsd = isSol ? 100 : 0; // Will compute from SOL price if not SOL

    const res = await jupiterFetch(
      `https://lite-api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${mint}&amount=${amount}&slippageBps=300`
    );

    if (!res.ok) {
      log.warn('Jupiter liquidity quote HTTP error', { mint, status: res.status });
      // Negative cache: avoid hammering Jupiter on repeated failures
      liquidityCache.set(mint, { liquidityUsd: cached?.liquidityUsd ?? 0, fetchedAt: Date.now() - LIQUIDITY_TTL + LIQUIDITY_FAIL_TTL });
      return cached?.liquidityUsd ?? 0;
    }

    const json = await res.json() as {
      outAmount?: string;
      priceImpactPct?: string;
      swapUsdValue?: string;
      error?: string;
    };

    if (json.error || !json.outAmount) {
      // Negative cache on logical errors to avoid repeated calls
      const staleValue = cached?.liquidityUsd ?? 0;
      liquidityCache.set(mint, { liquidityUsd: staleValue, fetchedAt: Date.now() - LIQUIDITY_TTL + LIQUIDITY_FAIL_TTL });
      return staleValue;
    }

    const impact = parseFloat(json.priceImpactPct || '0');

    // If impact is 0 or negligible, liquidity is very deep — use swapUsdValue as lower bound
    if (impact <= 0) {
      const swapUsd = parseFloat(json.swapUsdValue || '0');
      // 0% impact on $84 trade → liquidity is at least $1M+ (conservative floor)
      const estimatedLiquidityUsd = swapUsd > 0 ? Math.max(swapUsd * 10_000, 1_000_000) : 0;
      liquidityCache.set(mint, { liquidityUsd: estimatedLiquidityUsd, fetchedAt: Date.now() });
      return estimatedLiquidityUsd;
    }

    // Estimate liquidity from price impact
    const tradeUsd = quoteValueUsd || (await getSolPrice());
    const estimatedLiquidityUsd = (tradeUsd / (impact / 100)) * 2; // x2 for both sides
    liquidityCache.set(mint, { liquidityUsd: estimatedLiquidityUsd, fetchedAt: Date.now() });
    return estimatedLiquidityUsd;
  } catch (err) {
    log.error('Failed to fetch pool liquidity', {
      mint,
      error: err instanceof Error ? err.message : String(err),
    });
    // Negative cache: return stale value, don't retry for LIQUIDITY_FAIL_TTL
    const cached = liquidityCache.get(mint);
    liquidityCache.set(mint, { liquidityUsd: cached?.liquidityUsd ?? 0, fetchedAt: Date.now() - LIQUIDITY_TTL + LIQUIDITY_FAIL_TTL });
    return cached?.liquidityUsd ?? 0;
  }
}
