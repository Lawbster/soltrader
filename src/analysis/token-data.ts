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

const SOL_PRICE_CACHE = { price: 0, fetchedAt: 0 };
const SOL_PRICE_TTL = 30_000; // 30s
const TOKEN_PRICE_TTL = 30_000; // 30s
const LIQUIDITY_TTL = 30_000; // 30s

const tokenPriceCache = new Map<string, { priceSol: number; priceUsd: number; fetchedAt: number }>();
const liquidityCache = new Map<string, { liquidityUsd: number; fetchedAt: number }>();

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
    const res = await fetch(`https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`);
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

/** Lightweight price fetch — Jupiter only, no RPC calls */
export async function fetchTokenPrice(mint: string): Promise<{ priceSol: number; priceUsd: number }> {
  const cached = tokenPriceCache.get(mint);
  if (cached && Date.now() - cached.fetchedAt < TOKEN_PRICE_TTL) {
    return { priceSol: cached.priceSol, priceUsd: cached.priceUsd };
  }

  try {
    const res = await fetch(`https://lite-api.jup.ag/price/v3?ids=${mint}`);
    const json = await res.json() as any;
    const entry = json.data?.[mint] ?? json[mint];
    const priceUsd = extractUsdPrice(entry);
    const solPrice = await getSolPrice();
    const priceSol = solPrice > 0 ? priceUsd / solPrice : 0;
    tokenPriceCache.set(mint, { priceSol, priceUsd, fetchedAt: Date.now() });
    return { priceSol, priceUsd };
  } catch (err) {
    log.error('Failed to fetch token price', { mint, error: err });
    return { priceSol: 0, priceUsd: 0 };
  }
}

export async function fetchTokenData(
  mint: string,
  detectedAt: number
): Promise<TokenData | null> {
  const conn = getConnection();

  try {
    const mintPubkey = new PublicKey(mint);

    // Fetch mint info (authority checks) and token accounts in parallel
    const [mintInfo, largestAccounts, priceData] = await Promise.all([
      conn.getParsedAccountInfo(mintPubkey),
      conn.getTokenLargestAccounts(mintPubkey),
      fetchTokenPrice(mint),
    ]);

    // Parse mint account data
    const mintData = mintInfo.value?.data;
    if (!mintData || !('parsed' in mintData)) {
      log.warn('Could not parse mint account', { mint });
      return null;
    }

    const parsed = mintData.parsed;
    const info = parsed.info;
    const decimals: number = info.decimals;
    const totalSupply = parseFloat(info.supply) / Math.pow(10, decimals);
    const mintAuthorityRevoked = info.mintAuthority === null;
    const freezeAuthorityRevoked = info.freezeAuthority === null;

    // Holder distribution from top accounts — excluding LP, burn, and system wallets
    const EXCLUDED_ADDRESSES = new Set([
      '1111111111111111111111111111111111', // System program
      '11111111111111111111111111111111',   // System program (short)
      '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', // Raydium authority
      'So11111111111111111111111111111111111111112',     // Wrapped SOL
    ]);
    // Also exclude known burn address
    const BURN_PATTERN = /^1{20,}$/;

    let top10HolderPct = 0;
    let holderCount = 0;
    const LP_PROGRAMS = new Set([
      '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM
      '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', // Raydium authority
      '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',  // pump.fun
    ]);

    if (totalSupply > 0) {
      // Pre-filter by address, then batch-resolve owners in ONE RPC call
      const candidates = largestAccounts.value.filter(acc => {
        if ((acc.uiAmount || 0) <= 0) return false;
        const addr = acc.address.toBase58();
        return !EXCLUDED_ADDRESSES.has(addr) && !BURN_PATTERN.test(addr);
      });

      // Single batch RPC call to resolve all token account owners
      const filteredAccounts: { amount: number; address: string }[] = [];
      try {
        const accountInfos = await conn.getMultipleParsedAccounts(
          candidates.map(c => c.address)
        );
        for (let i = 0; i < candidates.length; i++) {
          const accData = accountInfos.value[i]?.data;
          if (accData && 'parsed' in accData) {
            const owner = accData.parsed.info.owner as string;
            if (EXCLUDED_ADDRESSES.has(owner) || BURN_PATTERN.test(owner)) continue;
            if (LP_PROGRAMS.has(owner)) continue;
          }
          filteredAccounts.push({
            amount: candidates[i].uiAmount || 0,
            address: candidates[i].address.toBase58(),
          });
        }
      } catch {
        // Fallback: include all candidates without owner filtering
        for (const c of candidates) {
          filteredAccounts.push({ amount: c.uiAmount || 0, address: c.address.toBase58() });
        }
      }

      holderCount = filteredAccounts.length;
      const top10Amount = filteredAccounts
        .slice(0, 10)
        .reduce((sum, acc) => sum + acc.amount, 0);
      top10HolderPct = (top10Amount / totalSupply) * 100;
    }

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
      top10HolderPct,
      holderCount,
      tokenAgeMins,
      fetchedAt: Date.now(),
    };

    log.debug('Token data fetched', {
      mint,
      mcapUsd: Math.round(mcapUsd),
      top10HolderPct: Math.round(top10HolderPct),
      mintRevoked: mintAuthorityRevoked,
      freezeRevoked: freezeAuthorityRevoked,
    });

    return data;
  } catch (err) {
    log.error('Failed to fetch token data', { mint, error: err });
    return null;
  }
}

export async function fetchPoolLiquidity(mint: string): Promise<number> {
  // Query Jupiter for route to estimate liquidity depth
  try {
    const cached = liquidityCache.get(mint);
    if (cached && Date.now() - cached.fetchedAt < LIQUIDITY_TTL) {
      return cached.liquidityUsd;
    }

    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    // Get a quote for a small amount to check if pool exists and has depth
    const amountLamports = 1_000_000_000; // 1 SOL
    const res = await fetch(
      `https://lite-api.jup.ag/swap/v1/quote?inputMint=${SOL_MINT}&outputMint=${mint}&amount=${amountLamports}&slippageBps=300`
    );
    const json = await res.json() as {
      outAmount?: string;
      priceImpactPct?: string;
      error?: string;
    };

    if (json.error || !json.outAmount) {
      return 0;
    }

    // Estimate liquidity from price impact
    // If 1 SOL causes X% impact, liquidity ≈ 1 SOL / (impact% / 100)
    const impact = parseFloat(json.priceImpactPct || '0');
    if (impact <= 0) return 0;

    const solPrice = await getSolPrice();
    const estimatedLiquidityUsd = (solPrice / (impact / 100)) * 2; // x2 for both sides
    liquidityCache.set(mint, { liquidityUsd: estimatedLiquidityUsd, fetchedAt: Date.now() });
    return estimatedLiquidityUsd;
  } catch (err) {
    log.error('Failed to fetch pool liquidity', { mint, error: err });
    return 0;
  }
}
