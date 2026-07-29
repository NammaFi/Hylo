// Primary Exponent data source — Exponent's own site API, found 2026-07-28.
// `https://app.exponent.finance/api/markets` is the exact JSON the live site itself reads to
// render the Yield Markets table: one GET, no auth, no browser, no Vercel bot-checkpoint (that
// checkpoint gates the HTML pages — this JSON endpoint answered a plain fetch() with no bypass
// needed). It directly supplies fields we were otherwise deriving or missing entirely:
//   - underlyingApy: cross-checked against a live screenshot (hyloSOL 5.8699...% vs. the site's
//     own displayed 5.87%) — solves the Underlying APY problem our own on-chain
//     exchange-rate/days-since-inception formula got wrong (computed 25.14%, 4.3x too high).
//   - impliedApy: matches our independently-derived CLMM formula ((currentSpotPrice - 1) * 100)
//     almost exactly (hyloSOL: API 12.085% vs. our RPC-derived 12.09%) — good cross-validation
//     of both sources.
//   - yieldExposure: answers "Yield Exposure"/leverage, previously unverified and left null.
//   - pointsBoost.points_per_day: answers "points per day", previously planned as 100%
//     hand-maintained in asset-registry.json.
//   - orderbookAddresses[] / legacyMarketAddresses[]: direct venue addresses, no PDA derivation
//     needed as the primary path (PDA derivation, already built in fetch-exponent-rpc.js, remains
//     useful for the RPC fallback below).
//
// Caveat: this is an undocumented, reverse-engineered endpoint, not part of the official SDK —
// it could change shape or go down without notice. Per your call, the RPC path
// (fetch-exponent-rpc.js) is only used as a whole-response fallback: when the endpoint itself
// fails or comes back with zero active markets. Individual known assets missing from an otherwise
// healthy response (observed once: kUSDC-10AUG26, USD.tel-05DEC26, srONyc-14NOV26 absent from a
// 12-entry response, alongside one new asset the registry didn't have, fragSOL) are not
// backfilled — not needed, per your call. See IMPLEMENTATION_PHASES.md for the full writeup.
import fs from 'fs';
import { calculateYtMetrics, calculateMaturesIn, calculateDaysToMaturity } from './scraper.js';
import { fetchAllExponentAssetsRpc } from './fetch-exponent-rpc.js';

const API_URL = 'https://app.exponent.finance/api/markets';
const REGISTRY_PATH = new URL('./asset-registry.json', import.meta.url);

// Maps the API's `platform` field to the exact project-bucket name StrategyDashboard.tsx's
// FILTER_PROJECTS expects. Confirmed live 2026-07-29: projectName was previously set to the
// token's own display name (e.g. "hyloSOL"), which silently failed the frontend's exact-match
// filter (`getProjectForAsset(asset) === 'Hylo'`) — assets showed up under "All" but vanished
// from their own project's filter. ONyc/srONyc happened to still work via an unrelated
// substring special-case in the frontend ("srONyc".includes("ONyc")), not because their
// projectName was ever correct. Anything not in this map (raiku, solstice, bulk, fragmetric, …)
// has no FILTER_PROJECTS bucket anyway and correctly falls into "Others", same as an
// unrecognized RateX project already does.
const PLATFORM_TO_PROJECT = {
  hylo: 'Hylo',
  onrefinance: 'Onre',
};

function loadRegistry() {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function formatMaturityCode(maturityDate) {
  const day = String(maturityDate.getUTCDate()).padStart(2, '0');
  const month = maturityDate.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }).toUpperCase();
  const year = String(maturityDate.getUTCFullYear()).slice(-2);
  return `${day}${month}${year}`;
}

/**
 * Build one Gist-schema asset record directly from one Exponent API market entry — no RPC call
 * needed. Field mapping matches fetch-exponent-rpc.js's buildAssetRecord() so both paths produce
 * an identical shape for scrape-once.js to merge.
 */
function mapApiEntryToAssetRecord(entry, registryByVault) {
  const maturityDate = new Date(entry.maturityDateUnixTs * 1000);
  const maturityCode = formatMaturityCode(maturityDate);
  const key = `${entry.tokenName}-${maturityCode}`;

  const registryOverride = registryByVault.get(entry.vaultAddress)?.static;

  const impliedYield = entry.impliedApy * 100;
  const apy = typeof entry.underlyingApy === 'number' ? entry.underlyingApy * 100 : null;
  const leverage = typeof entry.yieldExposure === 'number' ? entry.yieldExposure : null;
  const assetBoost = entry.pointsBoost?.points_per_day ?? registryOverride?.pointsPerDay ?? null;
  const displayName = registryOverride?.displayName ?? entry.tokenName;
  const projectName = PLATFORM_TO_PROJECT[entry.platform] ?? displayName;

  const maturityStr = maturityDate.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  const lastUpdated = new Date().toISOString();
  const preciseDays = calculateDaysToMaturity(maturityStr, lastUpdated);
  const maturesIn = calculateMaturesIn(maturityStr);

  // rangeLower = apy (Underlying APY), matching the existing scraper's Phase-1 convention —
  // same inherited "can go negative if underlying > implied" quirk noted in fetch-exponent-rpc.js.
  const rangeLower = apy;
  const rangeUpper = null;

  const ytMetrics = calculateYtMetrics(
    maturityStr, impliedYield, rangeLower, rangeUpper, lastUpdated,
    leverage, apy, Math.floor(preciseDays), assetBoost, 'exponent'
  );

  return {
    asset: `YT-${key}`,
    baseAsset: displayName,
    leverage,
    apy,
    maturityDays: Math.floor(preciseDays),
    assetBoost,
    ratexBoost: null,
    impliedYield,
    source: 'exponent',

    projectBackgroundImage: registryOverride?.logo ?? null,
    projectName,
    assetSymbolImage: registryOverride?.logo ?? null,

    rangeLower,
    rangeUpper,
    maturity: maturityStr,
    maturesIn,

    ytPriceCurrent: ytMetrics.ytPriceCurrent,
    ytPriceLower: ytMetrics.ytPriceLower,
    ytPriceUpper: ytMetrics.ytPriceUpper,
    dailyYieldRate: ytMetrics.dailyYieldRate,
    downsideRisk: ytMetrics.downsideRisk,
    endDayCurrentYield: ytMetrics.endDayCurrentYield,
    endDayLowerYield: ytMetrics.endDayLowerYield,
    dailyDecayRate: ytMetrics.dailyDecayRate,
    expectedRecoveryYield: ytMetrics.expectedRecoveryYield,
    expectedPointsPerDay: ytMetrics.expectedPointsPerDay,
    totalExpectedPoints: ytMetrics.totalExpectedPoints,

    // Additive fields beyond the current Gist schema — existing consumers ignore unknown fields.
    _vaultAddress: entry.vaultAddress,
    _orderbookAddress: entry.orderbookAddresses?.[0] ?? null,
    _marketAddress: entry.legacyMarketAddresses?.[0] ?? null,
    _hasLegacyAmm: (entry.legacyMarketAddresses?.length ?? 0) > 0,
    _liquidity: entry.liquidity,
    _totalMarketSize: entry.totalMarketSize,
    _categories: entry.categories,
    _underlyingApy1Epoch: typeof entry.underlyingApy1Epoch === 'number' ? entry.underlyingApy1Epoch * 100 : null,
    _underlyingApy7Epoch: typeof entry.underlyingApy7Epoch === 'number' ? entry.underlyingApy7Epoch * 100 : null,
    _underlyingApy30Epoch: typeof entry.underlyingApy30Epoch === 'number' ? entry.underlyingApy30Epoch * 100 : null,
    _source: 'exponent-api',
  };
}

/**
 * Full fetch: Exponent's own API. Falls back to full RPC discovery (fetch-exponent-rpc.js) only
 * when the endpoint itself fails or returns zero active markets — not for individual missing
 * assets, per your call (those three we recovered via RPC last time weren't needed anyway).
 */
export async function fetchAllExponentAssetsWithFallback() {
  let apiEntries = [];
  try {
    const res = await fetch(API_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    apiEntries = data.filter(m => m.marketStatus === 'active');
    console.log(`✅ Exponent API: ${apiEntries.length} active markets`);
  } catch (err) {
    console.warn(`⚠️ Exponent API fetch failed (${err.message})`);
  }

  if (apiEntries.length === 0) {
    console.warn('⚠️ Exponent API returned no markets — falling back to full RPC discovery');
    return fetchAllExponentAssetsRpc();
  }

  const registry = loadRegistry();
  const registryByVault = new Map(
    Object.values(registry).map(entry => [entry.maturity.vaultAddress, entry])
  );

  return apiEntries.map(entry => mapApiEntryToAssetRecord(entry, registryByVault));
}
