// RPC-based replacement for scraper-exponent-playwright.js — reads Exponent's on-chain state
// directly instead of scraping the website. See IMPLEMENTATION_PHASES.md for the full design
// and verification history behind every formula used here.
//
// Discovery: bulk-fetch CLMM markets, filter to live (non-expired + active), derive vault ->
// legacy AMM / OrderBook addresses via PDA (see SDK_INTRODUCTION.md Section 9).
// Naming: mintPt Metaplex metadata (mintYt has none — confirmed).
// Implied APY: (Ticks.currentSpotPrice - 1) * 100 — verified 2026-07-28 against ONYC's legacy
// AMM (14.11% vs 14.14%) and against bot-engine.ts's own proven SIMULATE formula.
import fs from 'fs';
import { PublicKey } from '@solana/web3.js';
import { Vault, Market, MarketThree, LOCAL_ENV } from '@exponent-labs/exponent-sdk';
import { fetchProgramAccountsMarketThree, EXPONENTCLMM_PROGRAM_ID } from '@exponent-labs/exponent-sdk/client/clmm';
import { ExponentPDA, ExponentOrderbookPDA } from '@exponent-labs/exponent-pda';
import { createReadRotator, getPrimaryConnection } from './rpcRotator.js';
import { calculateYtMetrics, calculateMaturesIn, calculateDaysToMaturity } from './scraper.js';

const METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const marketPda = new ExponentPDA();
const orderbookPda = new ExponentOrderbookPDA();

const REGISTRY_PATH = new URL('./asset-registry.json', import.meta.url);

function loadRegistry() {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveRegistry(registry) {
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + '\n');
}

function deriveMetadataPda(mint) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    METADATA_PROGRAM_ID
  );
  return pda;
}

// Metaplex metadata layout: key(1) + update_authority(32) + mint(32) + name(4+len) +
// symbol(4+len) + uri(4+len) + ... — name, symbol, and uri are each a u32 length prefix
// followed by the UTF-8 bytes, back to back, so reading uri just means walking past name
// and symbol first.
function parseMetadataNameAndUri(buf) {
  let offset = 1 + 32 + 32;
  const nameLen = buf.readUInt32LE(offset); offset += 4;
  const name = buf.slice(offset, offset + nameLen).toString('utf8').replace(/\0/g, '').trim();
  offset += nameLen;
  const symbolLen = buf.readUInt32LE(offset); offset += 4;
  offset += symbolLen; // symbol itself unused here
  const uriLen = buf.readUInt32LE(offset); offset += 4;
  const uri = buf.slice(offset, offset + uriLen).toString('utf8').replace(/\0/g, '').trim();
  return { name, uri };
}

/**
 * One on-chain read for a PT mint's Metaplex metadata, resolving both its display name and its
 * real Exponent icon. The icon chain: metadata's `uri` points to a JSON file (hosted on
 * github.com/valentinmadrid/exponent-icons — a third-party account, not Exponent's own domain, a
 * known small dependency risk) whose `image` field is the actual SVG. Confirmed 2026-07-29: NOT
 * guessable from the token symbol alone (only 5/10 assets matched a naive `PT-{symbol}.svg`
 * pattern) — has to be resolved per-asset via the real metadata/URI chain. `icon` comes back
 * null on any failure (missing metadata, network error, malformed JSON) — it's cosmetic, never
 * worth failing discovery over; `name` failures are likewise non-fatal (existing callers already
 * treat a null name as "use the fallback naming path").
 */
async function getPtMetadata(connection, mintPt) {
  let name = null;
  let icon = null;
  try {
    const pda = deriveMetadataPda(mintPt);
    const info = await connection.getAccountInfo(pda);
    if (!info) return { name, icon };
    const parsed = parseMetadataNameAndUri(info.data);
    name = parsed.name;
    if (parsed.uri) {
      try {
        const res = await fetch(parsed.uri);
        if (res.ok) {
          const json = await res.json();
          icon = json.image ?? null;
        }
      } catch {
        // icon stays null — cosmetic only
      }
    }
  } catch {
    // name/icon stay null — existing callers handle this gracefully
  }
  return { name, icon };
}

// Widened to allow "." (e.g. "USD.tel") — Exponent's naming isn't perfectly uniform, keep permissive.
function parsePtName(rawName) {
  if (!rawName) return null;
  const match = rawName.match(/PT-([A-Za-z0-9*+.]+)-(\d{2}[A-Z]{3}\d{2})/);
  if (!match) return null;
  return { baseSymbol: match[1], maturityCode: match[2] };
}

/**
 * Discover every live (non-expired, active) CLMM market and everything needed to describe it.
 * Rebuilds the asset-registry.json's "maturity" data fresh each run; "static" fields (logo,
 * category, pointsPerDay) are preserved from the existing registry if already hand-filled,
 * since the SDK has no source for them.
 */
export async function discoverLiveMarkets({ connection, rotator }) {
  const existingRegistry = loadRegistry();
  // Keyed by vault address (known before we've resolved a name/key for this market) so a cached
  // name+icon can be reused without ever calling getPtMetadata again — both are immutable once a
  // PT mint exists, so re-resolving them every run is pure wasted RPC + network calls.
  const existingByVault = new Map(
    Object.entries(existingRegistry).map(([key, entry]) => [entry.maturity.vaultAddress, { key, static: entry.static }])
  );
  const nowUnix = Math.floor(Date.now() / 1000);

  const allClmm = await fetchProgramAccountsMarketThree(connection, EXPONENTCLMM_PROGRAM_ID);
  const live = allClmm.filter(m => {
    const notExpired = Number(m.data.financials.expirationTs) > nowUnix;
    const isActive = m.data.financials.ptBalance > 0n || m.data.financials.syBalance > 0n;
    return notExpired && isActive;
  });

  const registry = {};
  const results = [];

  const nextConn = () => (rotator ? rotator.get() : connection);

  for (const clmmMarket of live) {
    const vaultAddr = clmmMarket.data.vault;
    const clmmAddr = clmmMarket.address;
    const conn = nextConn();
    try {
      const vault = await Vault.load(LOCAL_ENV, conn, vaultAddr);

      const cached = existingByVault.get(vaultAddr.toBase58());
      let rawName, resolvedIcon;
      if (cached?.static?.rawName && cached?.static?.logo) {
        // Already resolved on a previous run — the registry static field is the main source,
        // getPtMetadata() is only the fallback for a vault we haven't seen with a logo yet.
        rawName = cached.static.rawName;
        resolvedIcon = cached.static.logo;
      } else {
        ({ name: rawName, icon: resolvedIcon } = await getPtMetadata(conn, vault.mintPt));
      }

      const parsed = parsePtName(rawName);
      const key = cached?.key ?? (parsed ? `${parsed.baseSymbol}-${parsed.maturityCode}` : `UNKNOWN-${vaultAddr.toBase58().slice(0, 8)}`);

      const [derivedAmm, derivedOb] = [
        marketPda.market({ vault: vaultAddr, seedId: 0 }),
        orderbookPda.orderbook({ vault: vaultAddr, seedId: 0 }),
      ];
      const [ammInfo, obInfo] = await Promise.all([
        conn.getAccountInfo(derivedAmm),
        conn.getAccountInfo(derivedOb),
      ]);

      const existingStatic = cached?.static ?? {};
      const staticFields = {
        displayName: existingStatic.displayName ?? parsed?.baseSymbol ?? null,
        rawName,
        // Hand-set logo always wins if present; otherwise the cached/resolved Exponent icon
        // (Metaplex metadata → uri → image — not guessable, not a website source, see
        // getPtMetadata) is written back here, so it's cached for every future run too.
        logo: existingStatic.logo ?? resolvedIcon ?? null,
        category: existingStatic.category ?? null,
        flavor: vault.flavor.flavor,
        pointsPerDay: existingStatic.pointsPerDay ?? null,
      };
      const maturityFields = {
        vaultAddress: vaultAddr.toBase58(),
        clmmAddress: clmmAddr.toBase58(),
        marketAddress: ammInfo ? derivedAmm.toBase58() : null,
        orderbookAddress: obInfo ? derivedOb.toBase58() : null,
        maturityDate: vault.expirationDate.toISOString().slice(0, 10),
      };

      registry[key] = { static: staticFields, maturity: maturityFields };
      results.push({ key, vault, market: clmmMarket, staticFields, maturityFields, ammAddress: ammInfo ? derivedAmm : null });
    } catch (err) {
      console.warn(`  ⚠️ Skipping vault ${vaultAddr.toBase58()} (market ${clmmAddr.toBase58()}): ${err.message}`);
    }
  }

  saveRegistry(registry);
  return results;
}

/**
 * Build one Gist-schema asset record for a discovered live market, matching the exact field
 * shape scrape-once.js's Phase 1 merge produces (see scrape-once.js lines ~323-358).
 */
async function buildAssetRecord({ connection, key, vault, market, staticFields, maturityFields, ammAddress }) {
  const clmmMarket = await MarketThree.load(LOCAL_ENV, connection, new PublicKey(maturityFields.clmmAddress), vault);
  const impliedYield = (clmmMarket.state.ticks.currentSpotPrice - 1) * 100;

  const daysElapsed = (Date.now() / 1000 - vault.state.startTs) / 86400;
  // Underlying APY estimate — genuinely noisy for very young vaults (small daysElapsed amplifies
  // any exchange-rate noise); flagged in IMPLEMENTATION_PHASES.md as a known limitation, not a bug.
  const apy = daysElapsed > 0.5
    ? (Math.pow(vault.currentSyExchangeRate, 365 / daysElapsed) - 1) * 100
    : null;

  const maturityStr = vault.expirationDate.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  const lastUpdated = new Date().toISOString();
  const preciseDays = calculateDaysToMaturity(maturityStr, lastUpdated);
  const maturesIn = calculateMaturesIn(maturityStr);

  // rangeLower = apy (Underlying APY), matching the existing scraper's Phase-1 convention.
  // rangeUpper has no on-chain equivalent yet — left null, same as a fresh Phase-1-only scrape.
  const rangeLower = apy;
  const rangeUpper = null;

  // leverage ("Yield Exposure") — formula not yet independently verified (see
  // IMPLEMENTATION_PHASES.md Section 10 checklist); left null rather than shipping a guess.
  const leverage = null;
  const assetBoost = staticFields.pointsPerDay; // manual, from the registry if hand-filled

  const ytMetrics = calculateYtMetrics(
    maturityStr, impliedYield, rangeLower, rangeUpper, lastUpdated,
    leverage, apy, Math.floor(preciseDays), assetBoost, 'exponent'
  );

  return {
    asset: `YT-${key}`,
    baseAsset: staticFields.displayName,
    leverage,
    apy,
    maturityDays: Math.floor(preciseDays),
    assetBoost,
    ratexBoost: null,
    impliedYield,
    source: 'exponent',

    projectBackgroundImage: staticFields.logo,
    projectName: staticFields.displayName,
    assetSymbolImage: staticFields.logo,

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

    // Extra fields beyond the current Gist schema, additive-only (existing consumers ignore
    // unknown fields) — venue addresses/flags, useful once we build richer displays.
    _clmmAddress: maturityFields.clmmAddress,
    _marketAddress: maturityFields.marketAddress,
    _orderbookAddress: maturityFields.orderbookAddress,
    _hasLegacyAmm: ammAddress !== null,
  };
}

/**
 * Full replacement for scrapeAllExponentAssets() + scrapeExponentDetailPagesPlaywright() combined
 * — no Phase 1/Phase 2 split needed (no browser rendering to wait on), one pass. Used directly by
 * fetch-exponent-api.js as a whole-response fallback when Exponent's own site API is down or
 * returns zero markets (not for backfilling individual assets missing from an otherwise-healthy
 * API response — see IMPLEMENTATION_PHASES.md's "Exponent's own site API" section).
 */
export async function fetchAllExponentAssetsRpc() {
  const connection = getPrimaryConnection();
  const rotator = createReadRotator();

  console.log('🔎 Discovering live CLMM-backed markets...');
  const discovered = await discoverLiveMarkets({ connection, rotator });
  console.log(`✅ ${discovered.length} live markets discovered`);

  const assets = [];
  let i = 0;
  for (const d of discovered) {
    i++;
    try {
      const record = await buildAssetRecord({ connection: rotator.get(), ...d });
      assets.push(record);
      console.log(`  [${i}/${discovered.length}] ${record.asset}: Implied APY=${record.impliedYield.toFixed(2)}% maturesIn=${record.maturesIn}`);
    } catch (err) {
      console.warn(`  ⚠️ [${i}/${discovered.length}] ${d.key}: failed to build record - ${err.message}`);
    }
  }

  return assets;
}
