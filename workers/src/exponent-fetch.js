// Workers-compatible port of server/fetch-exponent-api.js's API-primary path.
// Deliberately API-only — no RPC/SDK fallback here. That fallback needs
// @solana/web3.js + @exponent-labs/exponent-sdk, which adds real bundling risk for a first
// Workers cut; server/fetch-exponent-rpc.js's fallback already covers a full API outage on its
// own 5-minute GH Actions cadence (server/scrape-once.js is unchanged and keeps doing both
// RateX + Exponent, API-primary + RPC-fallback, exactly as before) — this Worker exists purely
// to get *fresher* Exponent updates (every 1 minute) in between those GH Actions runs. If the
// API is briefly down, this Worker just skips its update for that minute rather than writing
// worse data; the GH Actions run recovers via RPC fallback as always.
import registry from './asset-registry.json' with { type: 'json' };

const API_URL = 'https://app.exponent.finance/api/markets';

function formatMaturityCode(maturityDate) {
  const day = String(maturityDate.getUTCDate()).padStart(2, '0');
  const month = maturityDate.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }).toUpperCase();
  const year = String(maturityDate.getUTCFullYear()).slice(-2);
  return `${day}${month}${year}`;
}

function mapApiEntryToAssetRecord(entry, registryByVault, calculateYtMetrics, calculateMaturesIn, calculateDaysToMaturity) {
  const maturityDate = new Date(entry.maturityDateUnixTs * 1000);
  const maturityCode = formatMaturityCode(maturityDate);
  const key = `${entry.tokenName}-${maturityCode}`;

  const registryOverride = registryByVault.get(entry.vaultAddress)?.static;

  const impliedYield = entry.impliedApy * 100;
  const apy = typeof entry.underlyingApy === 'number' ? entry.underlyingApy * 100 : null;
  const leverage = typeof entry.yieldExposure === 'number' ? entry.yieldExposure : null;
  const assetBoost = entry.pointsBoost?.points_per_day ?? registryOverride?.pointsPerDay ?? null;
  const displayName = registryOverride?.displayName ?? entry.tokenName;

  const maturityStr = maturityDate.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  const lastUpdated = new Date().toISOString();
  const preciseDays = calculateDaysToMaturity(maturityStr, lastUpdated);
  const maturesIn = calculateMaturesIn(maturityStr);

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
    projectName: displayName,
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
    _source: 'exponent-worker',
  };
}

/**
 * Fetch Exponent's own site API and map to Gist-schema records. Returns `null` (not an empty
 * array) on failure/empty response so the caller can distinguish "API down, skip this run" from
 * "API up, genuinely zero active markets" — the latter would be unusual enough to also skip on,
 * but the two cases are handled the same way by the caller either way (see index.js).
 */
export async function fetchExponentAssets({ calculateYtMetrics, calculateMaturesIn, calculateDaysToMaturity }) {
  let apiEntries = [];
  try {
    const res = await fetch(API_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    apiEntries = data.filter(m => m.marketStatus === 'active');
  } catch (err) {
    console.warn(`Exponent API fetch failed: ${err.message}`);
    return null;
  }

  if (apiEntries.length === 0) {
    console.warn('Exponent API returned no active markets');
    return null;
  }

  const registryByVault = new Map(
    Object.values(registry).map(entry => [entry.maturity.vaultAddress, entry])
  );

  return apiEntries.map(entry =>
    mapApiEntryToAssetRecord(entry, registryByVault, calculateYtMetrics, calculateMaturesIn, calculateDaysToMaturity)
  );
}
