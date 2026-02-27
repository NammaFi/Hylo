import { scrapeAllAssets, scrapeDetailPages, scrapeExponentDetailPages, fetchExistingGistData, calculateMaturesIn, calculateYtMetrics, calculateDaysToMaturity } from './scraper.js';
import { scrapeAllExponentAssets } from './scraper-exponent.js';
import { fetchXSolMetricsPhase0 } from './scraper-xsol-phase0.js';
import { checkCRAndAlert } from './cr-monitor.js';
import puppeteerCore from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import { chmod } from 'fs/promises';

const puppeteer = puppeteerCore;
const GIST_ID = process.env.GIST_ID;
const GIST_TOKEN = process.env.GIST_TOKEN;
const YIELD_BOT_TOKEN = process.env.YIELD_BOT_TOKEN;
const ALERTS_GIST_ID = process.env.ALERTS_GIST_ID;
const TELEGRAM_API = 'https://api.telegram.org';

// ─── Yield Alert Check ──────────────────────────────────────────────────────

async function fetchAlertsGistForYield() {
  if (!ALERTS_GIST_ID || !GIST_TOKEN) return null;
  try {
    const res = await fetch(`https://api.github.com/gists/${ALERTS_GIST_ID}`, {
      headers: {
        'Authorization': `token ${GIST_TOKEN}`,
        'User-Agent': 'Hylo-Yield-Monitor',
      },
    });
    if (!res.ok) return null;
    const gist = await res.json();
    const content = gist.files?.['cr-alert-subscribers.json']?.content;
    return content ? JSON.parse(content) : null;
  } catch { return null; }
}

async function persistAlertsGistForYield(data) {
  if (!ALERTS_GIST_ID || !GIST_TOKEN) return;
  try {
    await fetch(`https://api.github.com/gists/${ALERTS_GIST_ID}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `token ${GIST_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Hylo-Yield-Monitor',
      },
      body: JSON.stringify({
        files: {
          'cr-alert-subscribers.json': { content: JSON.stringify(data, null, 2) },
        },
      }),
    });
  } catch (err) {
    console.warn('❌ Failed to persist yield alerts:', err.message);
  }
}

async function sendYieldTelegramAlert(chatId, text) {
  if (!YIELD_BOT_TOKEN) return;
  try {
    await fetch(`${TELEGRAM_API}/bot${YIELD_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    console.warn(`  ❌ Failed to send yield alert to ${chatId}:`, err.message);
  }
}

async function checkYieldAlerts(assets) {
  if (!YIELD_BOT_TOKEN || !ALERTS_GIST_ID) {
    console.log('ℹ️ Yield alerts: YIELD_BOT_TOKEN or ALERTS_GIST_ID not set, skipping');
    return;
  }

  const alertsData = await fetchAlertsGistForYield();
  if (!alertsData?.yieldAlerts) {
    console.log('ℹ️ No yield alert subscribers found');
    return;
  }

  const now = new Date().toISOString();
  let anyAlertSent = false;

  for (const [chatId, userData] of Object.entries(alertsData.yieldAlerts)) {
    if (!userData?.assets) continue;

    for (const [assetName, config] of Object.entries(userData.assets)) {
      if (!config.enabled) continue;

      // Find this asset in the scraped data
      const liveAsset = assets.find(a => a.asset === assetName);
      if (!liveAsset || liveAsset.impliedYield == null) continue;

      const iy = parseFloat(liveAsset.impliedYield);
      if (isNaN(iy)) continue;

      let triggered = false;
      let direction = '';

      // Check low threshold: alert when IY ≤ thresholdLow
      if (config.thresholdLow != null && iy <= config.thresholdLow) {
        triggered = true;
        direction = `📉 *Below Low Threshold*\nIY ${iy}% ≤ ${config.thresholdLow}%`;
      }

      // Check high threshold: alert when IY ≥ thresholdHigh
      if (config.thresholdHigh != null && iy >= config.thresholdHigh) {
        triggered = true;
        direction = `📈 *Above High Threshold*\nIY ${iy}% ≥ ${config.thresholdHigh}%`;
      }

      if (triggered) {
        const msg = [
          `🔔 *Yield Alert — ${assetName}*`,
          '',
          direction,
          '',
          `📊 Current Implied Yield: *${iy}%*`,
          `🏷️ Source: ${liveAsset.source || 'N/A'}`,
          `⏰ ${now}`,
        ].join('\n');

        await sendYieldTelegramAlert(chatId, msg);
        config.lastAlert = now;
        config.lastYield = iy;
        anyAlertSent = true;
        console.log(`  📱 Yield alert sent to ${chatId} for ${assetName} (IY=${iy}%)`);
      }
    }
  }

  if (anyAlertSent) {
    await persistAlertsGistForYield(alertsData);
    console.log('✅ Yield alert states persisted');
  }
}
if (!GIST_ID || !GIST_TOKEN) {
  console.error('❌ Missing required environment variables: GIST_ID and GIST_TOKEN');
  process.exit(1);
}

async function updateGist(gistId, data, token) {
  const filename = 'ratex-assets.json';
  
  const response = await fetch(`https://api.github.com/gists/${gistId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `token ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Hylo-RateX-Scraper'
    },
    body: JSON.stringify({
      files: {
        [filename]: {
          content: JSON.stringify(data, null, 2)
        }
      }
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to update gist: ${response.status} ${error}`);
  }

  return await response.json();
}

async function main() {
  let browser;
  let xsolMetricsData = null; // Store Phase 0 data to include in final Gist
  
  try {
    console.log('🚀 Starting RateX scraper (Phase 0 + Two-Phase)...');
    console.log(`⏰ Time: ${new Date().toISOString()}`);
    
    // ========== STEP 1: Fetch Existing Gist Data (BEFORE Phase 0) ==========
    console.log('\n📥 STEP 1: Fetching existing Gist data...');
    const existingGistData = await fetchExistingGistData();
    
    // ========== PHASE 0: xSOL Metrics (runs before browser launch) ==========
    try {
      xsolMetricsData = await fetchXSolMetricsPhase0();
      if (xsolMetricsData) {
        console.log('✅ Phase 0 complete - xSOL metrics ready');
      } else {
        console.warn('⚠️ Phase 0 returned null - preserving existing xSOL metrics from Gist');
        xsolMetricsData = existingGistData?.fullData?.xsolMetrics || null;
      }
    } catch (phase0Error) {
      console.error('⚠️ Phase 0 failed:', phase0Error.message);
      console.log('   Preserving existing xSOL metrics from Gist...');
      xsolMetricsData = existingGistData?.fullData?.xsolMetrics || null;
    }
    
    // ========== CR ALERT CHECK (after Phase 0, non-blocking) ==========
    if (xsolMetricsData && xsolMetricsData.CollateralRatio != null) {
      checkCRAndAlert(xsolMetricsData.CollateralRatio, {
        gistToken: GIST_TOKEN,
        alertsGistId: process.env.ALERTS_GIST_ID,
      }).catch(crError => console.warn('⚠️ CR alert check failed:', crError.message));
    }
    
    // ========== STEP 2: Launch Browser ==========
    console.log('\n🌐 STEP 2: Launching browser...');
    const executablePath = await chromium.executablePath();
    
    try {
      await chmod(executablePath, 0o755);
    } catch (chmodError) {
      console.warn('Could not chmod chromium:', chmodError.message);
    }
    
    browser = await puppeteer.launch({
      args: [...chromium.args, '--single-process', '--no-zygote'],
      defaultViewport: chromium.defaultViewport,
      executablePath: executablePath,
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });
    
    // ========== PHASE 1: Scrape Cards Page (PARALLEL) ==========
    console.log('\n🚀 PHASE 1: Scraping RateX and Exponent in parallel...');
    
    // Run scrapers in parallel for speed
    const [ratexData, exponentData] = await Promise.all([
      scrapeAllAssets(),
      scrapeAllExponentAssets()
    ]);
    
    console.log(`✅ RateX: ${ratexData.length} assets`);
    console.log(`✅ Exponent: ${exponentData.length} assets`);
    
    // Debug: Check hyloSOL leverage and impliedYield from Phase 1 scraping
    const ratexHyloSOL = ratexData.find(a => a.asset.includes('hyloSOL') && a.asset.includes('2511'));
    const exponentHyloSOL = exponentData.find(a => a.asset.includes('hyloSOL') && a.asset.includes('10DEC'));
    console.log('\n🔍 DEBUG - Phase 1 Scraped Values:');
    if (ratexHyloSOL) {
      console.log(`   RateX hyloSOL-2511: leverage=${ratexHyloSOL.leverage}, impliedYield=${ratexHyloSOL.impliedYield}, apy=${ratexHyloSOL.apy}`);
    }
    if (exponentHyloSOL) {
      console.log(`   Exponent YT-hyloSOL-10DEC25: leverage=${exponentHyloSOL.leverage}, impliedYield=${exponentHyloSOL.impliedYield}, apy=${exponentHyloSOL.apy}`);
    }
    
    // Apply APY and assetBoost validation in-memory (no re-scraping!)
    console.log('\n🔄 Applying APY, assetBoost, visual assets, and YT metrics validation...');
    const ratexMap = new Map(
      ratexData.map(asset => [asset.baseAsset.toLowerCase(), asset])
    );
    
    let apyValidatedCount = 0;
    let boostValidatedCount = 0;
    let visualAssetsCount = 0;
    let rangeLowerCount = 0;
    let ytMetricsCount = 0;
    
    exponentData.forEach(exponentAsset => {
      const ratexMatch = ratexMap.get(exponentAsset.baseAsset.toLowerCase());
      const oldAsset = existingGistData[exponentAsset.asset];
      
      // Update APY if RateX has it (more reliable)
      if (ratexMatch && ratexMatch.apy !== null) {
        console.log(`  ✓ ${exponentAsset.asset}: Overriding APY ${exponentAsset.apy}% → ${ratexMatch.apy}%`);
        exponentAsset.apy = ratexMatch.apy;
        apyValidatedCount++;
      }
      
      // Asset Boost Priority: OLD Gist → RateX match → null
      if (oldAsset && oldAsset.assetBoost !== null) {
        console.log(`  ✓ ${exponentAsset.asset}: Using OLD gist assetBoost ${oldAsset.assetBoost}x`);
        exponentAsset.assetBoost = oldAsset.assetBoost;
        boostValidatedCount++;
      } else if (ratexMatch && ratexMatch.assetBoost !== null) {
        console.log(`  ✓ ${exponentAsset.asset}: Using RateX assetBoost ${ratexMatch.assetBoost}x`);
        exponentAsset.assetBoost = ratexMatch.assetBoost;
        boostValidatedCount++;
      }
      // else: keep null (will be filled in Phase 2)
      
      // Visual Assets Priority: RateX match → OLD Gist → null
      if (ratexMatch && ratexMatch.projectBackgroundImage) {
        exponentAsset.projectBackgroundImage = ratexMatch.projectBackgroundImage;
        exponentAsset.projectName = ratexMatch.projectName;
        exponentAsset.assetSymbolImage = ratexMatch.assetSymbolImage;
        console.log(`  ✓ ${exponentAsset.asset}: Copied visual assets from RateX (${ratexMatch.projectName})`);
        visualAssetsCount++;
      } else if (oldAsset && oldAsset.projectBackgroundImage) {
        exponentAsset.projectBackgroundImage = oldAsset.projectBackgroundImage;
        exponentAsset.projectName = oldAsset.projectName;
        exponentAsset.assetSymbolImage = oldAsset.assetSymbolImage;
        console.log(`  ✓ ${exponentAsset.asset}: Using OLD gist visual assets (${oldAsset.projectName})`);
        visualAssetsCount++;
      }
      // else: keep null (will be filled in Phase 2)
      
      // Maturity Priority: OLD Gist → Asset name calculation
      let preciseDaysToUse = exponentAsset.maturityDays; // Default to integer
      
      if (oldAsset && oldAsset.maturity) {
        exponentAsset.maturity = oldAsset.maturity;
        preciseDaysToUse = calculateDaysToMaturity(oldAsset.maturity, new Date().toISOString());
        exponentAsset.maturityDays = Math.floor(preciseDaysToUse);
        exponentAsset.maturesIn = calculateMaturesIn(oldAsset.maturity);
        console.log(`  ✓ ${exponentAsset.asset}: Using old gist maturity, precise days: ${preciseDaysToUse.toFixed(2)}`);
      } else if (exponentAsset.maturity) {
        // Maturity from asset name - recalculate with precise days
        preciseDaysToUse = calculateDaysToMaturity(exponentAsset.maturity, new Date().toISOString());
        exponentAsset.maturityDays = Math.floor(preciseDaysToUse);
        exponentAsset.maturesIn = calculateMaturesIn(exponentAsset.maturity);
        console.log(`  ✓ ${exponentAsset.asset}: Using name-based maturity, precise days: ${preciseDaysToUse.toFixed(2)}`);
      }
      // else: no maturity available (shouldn't happen for Exponent assets)
      
      // Set rangeLower = apy (Underlying APY) for Phase 1 YT metric calculations
      if (exponentAsset.apy !== null) {
        exponentAsset.rangeLower = exponentAsset.apy;
        rangeLowerCount++;
      }
      
      // Calculate YT metrics in Phase 1 (rangeUpper will be null until Phase 2)
      if (exponentAsset.maturity && exponentAsset.impliedYield !== null) {
        const phase1Timestamp = new Date().toISOString();
        const ytMetrics = calculateYtMetrics(
          exponentAsset.maturity,
          exponentAsset.impliedYield,
          exponentAsset.rangeLower, // = apy
          null, // rangeUpper not available in Phase 1
          phase1Timestamp,
          exponentAsset.leverage,
          exponentAsset.apy,
          preciseDaysToUse, // Use precise decimal days
          exponentAsset.assetBoost,
          'exponent' // source
        );
        
        // Copy calculated metrics to asset
        exponentAsset.ytPriceCurrent = ytMetrics.ytPriceCurrent;
        exponentAsset.ytPriceLower = ytMetrics.ytPriceLower;
        exponentAsset.ytPriceUpper = ytMetrics.ytPriceUpper; // Will be null
        exponentAsset.dailyYieldRate = ytMetrics.dailyYieldRate;
        exponentAsset.downsideRisk = ytMetrics.downsideRisk;
        exponentAsset.endDayCurrentYield = ytMetrics.endDayCurrentYield;
        exponentAsset.endDayLowerYield = ytMetrics.endDayLowerYield;
        exponentAsset.dailyDecayRate = ytMetrics.dailyDecayRate;
        exponentAsset.expectedRecoveryYield = ytMetrics.expectedRecoveryYield;
        exponentAsset.expectedPointsPerDay = ytMetrics.expectedPointsPerDay;
        exponentAsset.totalExpectedPoints = ytMetrics.totalExpectedPoints;
        
        ytMetricsCount++;
        console.log(`  ✓ ${exponentAsset.asset}: Calculated Phase 1 YT metrics (ytPriceCurrent=${ytMetrics.ytPriceCurrent}, downsideRisk=${ytMetrics.downsideRisk})`);
      }
    });
    
    console.log(`✅ APY validation: ${apyValidatedCount}/${exponentData.length} assets updated`);
    console.log(`✅ assetBoost validation: ${boostValidatedCount}/${exponentData.length} assets updated`);
    console.log(`✅ Visual assets: ${visualAssetsCount}/${exponentData.length} assets updated`);
    console.log(`✅ rangeLower set: ${rangeLowerCount}/${exponentData.length} assets`);
    console.log(`✅ YT metrics calculated: ${ytMetricsCount}/${exponentData.length} assets`);
    
    // Merge RateX + Exponent assets
    const allAssets = [...ratexData, ...exponentData];
    console.log(`\n📊 Total combined assets: ${allAssets.length} (${ratexData.length} RateX + ${exponentData.length} Exponent)`);
    
    // Merge with existing Gist data and finalize Phase 1
    console.log('\n🔀 Merging and finalizing Phase 1 data...');
    const phase1Timestamp = new Date().toISOString(); // Single timestamp for all Phase 1 calculations
    
    const phase1MergedData = allAssets.map(newAsset => {
      const oldAsset = existingGistData[newAsset.asset];
      
      // For RateX assets: calculate YT metrics (they don't have Phase 1 pre-calculation)
      // For Exponent assets: use pre-calculated values from validation section
      let ytMetrics;
      if (newAsset.source === 'ratex') {
        // RateX: Use old gist ranges or calculate with fresh data
        const rangeLower = oldAsset?.rangeLower ?? null;
        const rangeUpper = oldAsset?.rangeUpper ?? null;
        const maturity = oldAsset?.maturity ?? null;
        
        // Calculate precise daysToUse from old gist maturity
        let preciseDaysToUse = newAsset.maturityDays; // Default to integer
        if (maturity) {
          preciseDaysToUse = calculateDaysToMaturity(maturity, phase1Timestamp);
        }
        
        ytMetrics = calculateYtMetrics(
          maturity,
          newAsset.impliedYield,
          rangeLower,
          rangeUpper,
          phase1Timestamp,
          newAsset.leverage,
          newAsset.apy,
          preciseDaysToUse, // Use precise decimal days
          newAsset.assetBoost,
          'ratex'
        );
      } else {
        // Exponent: Use pre-calculated Phase 1 metrics from validation section
        ytMetrics = {
          ytPriceCurrent: newAsset.ytPriceCurrent ?? null,
          ytPriceLower: newAsset.ytPriceLower ?? null,
          ytPriceUpper: newAsset.ytPriceUpper ?? null,
          dailyYieldRate: newAsset.dailyYieldRate ?? null,
          downsideRisk: newAsset.downsideRisk ?? null,
          endDayCurrentYield: newAsset.endDayCurrentYield ?? null,
          endDayLowerYield: newAsset.endDayLowerYield ?? null,
          dailyDecayRate: newAsset.dailyDecayRate ?? null,
          expectedRecoveryYield: newAsset.expectedRecoveryYield ?? null,
          expectedPointsPerDay: newAsset.expectedPointsPerDay ?? null,
          totalExpectedPoints: newAsset.totalExpectedPoints ?? null
        };
      }
      
      // Recalculate maturesIn to be current
      const maturity = newAsset.maturity ?? oldAsset?.maturity ?? null;
      const maturesIn = maturity 
        ? calculateMaturesIn(maturity)  // If we have maturity date, calculate from it (time-aware)
        : newAsset.maturesIn ?? null;   // Otherwise preserve Phase 1 calculated maturesIn (from maturityDays)
      
      // Preserve old detail page data (rangeUpper from Phase 2)
      const rangeUpper = oldAsset?.rangeUpper ?? null;
      
      return {
        // New data from cards (always update these)
        asset: newAsset.asset,
        baseAsset: newAsset.baseAsset,
        leverage: newAsset.leverage,
        apy: newAsset.apy,
        maturityDays: newAsset.maturityDays,
        assetBoost: newAsset.assetBoost,
        ratexBoost: newAsset.ratexBoost,
        impliedYield: newAsset.impliedYield,
        source: newAsset.source, // 'ratex' or 'exponent'
        
        // Visual assets from Phase 1 (new fields)
        projectBackgroundImage: newAsset.projectBackgroundImage ?? null,
        projectName: newAsset.projectName ?? null,
        assetSymbolImage: newAsset.assetSymbolImage ?? null,
        
        // Range and maturity data
        rangeLower: newAsset.rangeLower ?? oldAsset?.rangeLower ?? null, // For Exponent: set in Phase 1, for RateX: from old gist
        rangeUpper: rangeUpper, // Only from old gist (Phase 2 data)
        maturity: maturity,
        maturesIn: maturesIn,  // Recalculated to be current
        
        // Calculated YT metrics
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
      };
    });
    
    console.log(`✅ Phase 1 complete: ${phase1MergedData.length} assets with calculated metrics`);
    
    // Debug: Check hyloSOL values after Phase 1 merge
    const mergedRatexHyloSOL = phase1MergedData.find(a => a.asset.includes('hyloSOL') && a.asset.includes('2511'));
    const mergedExponentHyloSOL = phase1MergedData.find(a => a.asset.includes('hyloSOL') && a.asset.includes('10DEC'));
    console.log('\n🔍 DEBUG - Phase 1 Merged Values (before Gist update):');
    if (mergedRatexHyloSOL) {
      console.log(`   RateX hyloSOL-2511: leverage=${mergedRatexHyloSOL.leverage}, impliedYield=${mergedRatexHyloSOL.impliedYield}, apy=${mergedRatexHyloSOL.apy}, source=${mergedRatexHyloSOL.source}`);
    }
    if (mergedExponentHyloSOL) {
      console.log(`   Exponent YT-hyloSOL-10DEC25: leverage=${mergedExponentHyloSOL.leverage}, impliedYield=${mergedExponentHyloSOL.impliedYield}, apy=${mergedExponentHyloSOL.apy}, source=${mergedExponentHyloSOL.source}`);
    }
    
    // ========== Update Gist (Phase 1) ==========
    console.log('\n📤 Updating Gist with Phase 1 data...');
    const ratexCount = phase1MergedData.filter(a => a.source === 'ratex').length;
    const exponentCount = phase1MergedData.filter(a => a.source === 'exponent').length;
    console.log(`   📊 Gist will contain: ${ratexCount} RateX + ${exponentCount} Exponent = ${phase1MergedData.length} total`);
    
    const phase1GistData = {
      lastUpdated: phase1Timestamp,
      phase: 1,
      assetsCount: phase1MergedData.length,
      assets: phase1MergedData,
      xsolMetrics: xsolMetricsData || null,
    };
    
    await updateGist(GIST_ID, phase1GistData, GIST_TOKEN);
    console.log('✅ Phase 1 Gist updated - Frontend can use calculator now!');
    
    // ========== PHASE 2: Scrape Detail Pages (Hylo Priority + Parallel) ==========
    console.log('\n🚀 Starting Phase 2: Hylo assets first, then remaining (parallel)...');
    
    // Filter Hylo assets by projectName (for RateX) and matching baseAsset (for Exponent)
    const ratexAssets = phase1MergedData.filter(a => a.source === 'ratex');
    const exponentAssets = phase1MergedData.filter(a => a.source === 'exponent');
    
    // RateX Hylo assets filtered by projectName
    const ratexHylo = ratexAssets.filter(a => a.projectName === 'Hylo');
    
    // Exponent Hylo assets: match baseAsset with RateX Hylo assets
    const hyloBaseAssets = ratexHylo.map(a => a.baseAsset.toLowerCase());
    const exponentHylo = exponentAssets.filter(a => hyloBaseAssets.includes(a.baseAsset.toLowerCase()));
    
    // Remaining (non-Hylo) assets
    const ratexOthers = ratexAssets.filter(a => a.projectName !== 'Hylo');
    const exponentOthers = exponentAssets.filter(a => !hyloBaseAssets.includes(a.baseAsset.toLowerCase()));
    
    console.log(`\n📌 Phase 2A: Scraping Hylo assets first (${ratexHylo.length} RateX + ${exponentHylo.length} Exponent)...`);
    
    // Create single page for sequential execution
    const detailPage = await browser.newPage();
    
    // Scrape Hylo assets sequentially (RateX first, then Exponent)
    console.log('  → Scraping RateX Hylo assets...');
    const phase2AratexData = await scrapeDetailPages(detailPage, ratexHylo, existingGistData);
    
    console.log('  → Scraping Exponent Hylo assets...');
    const phase2AExponentData = await scrapeExponentDetailPages(detailPage, exponentHylo, existingGistData);
    
    const phase2AData = [...phase2AratexData, ...phase2AExponentData];
    
    // Merge Phase 2A (Hylo) with Phase 1 data for all assets
    const phase2AFullData = phase1MergedData.map(asset => {
      const hyloData = phase2AData.find(h => h.asset === asset.asset);
      return hyloData || asset; // Use Hylo Phase 2 data if available, otherwise Phase 1
    });
    
    // Update Gist with Hylo data (quick update for frontend)
    console.log('\n📤 Updating Gist with Hylo data (Phase 2A)...');
    const phase2ATimestamp = {
      lastUpdated: new Date().toISOString(),
      phase: 2,
      phaseStatus: 'hylo-complete',
      assetsCount: phase2AFullData.length,
      assets: phase2AFullData,
      xsolMetrics: xsolMetricsData || null,
    };
    await updateGist(GIST_ID, phase2ATimestamp, GIST_TOKEN);
    console.log('✅ Hylo data now live in Gist!');
    
    // Scrape remaining assets sequentially
    console.log(`\n📌 Phase 2B: Scraping remaining assets (${ratexOthers.length} RateX + ${exponentOthers.length} Exponent)...`);
    
    console.log('  → Scraping RateX remaining assets...');
    const phase2BRatexData = await scrapeDetailPages(detailPage, ratexOthers, existingGistData);
    
    console.log('  → Scraping Exponent remaining assets...');
    const phase2BExponentData = await scrapeExponentDetailPages(detailPage, exponentOthers, existingGistData);
    
    const phase2BData = [...phase2BRatexData, ...phase2BExponentData];
    console.log(`\n✅ Phase 2 scraping complete: ${phase2AData.length} Hylo assets + ${phase2BData.length} other assets`);
    
    // Merge Phase 2B data back into phase2AFullData (which already has Phase 1 + Phase 2A)
    const phase2FinalData = phase2AFullData.map(asset => {
      const phase2BUpdate = phase2BData.find(p => p.asset === asset.asset);
      return phase2BUpdate || asset; // Use Phase 2B data if available, otherwise keep Phase 2A/Phase 1
    });
    
    console.log(`   📊 Final Gist: ${phase2FinalData.length} total assets (${phase2FinalData.filter(a => a.source === 'ratex').length} RateX + ${phase2FinalData.filter(a => a.source === 'exponent').length} Exponent)`);
    
    // Debug: Check hyloSOL values in final Phase 2 data
    const finalRatexHyloSOL = phase2FinalData.find(a => a.asset.includes('hyloSOL') && a.asset.includes('2511'));
    const finalExponentHyloSOL = phase2FinalData.find(a => a.asset.includes('hyloSOL') && a.asset.includes('10DEC'));
    console.log('\n🔍 DEBUG - Phase 2 Final Values (sending to Gist):');
    if (finalRatexHyloSOL) {
      console.log(`   RateX hyloSOL-2511: leverage=${finalRatexHyloSOL.leverage}, impliedYield=${finalRatexHyloSOL.impliedYield}, apy=${finalRatexHyloSOL.apy}, source=${finalRatexHyloSOL.source}`);
    }
    if (finalExponentHyloSOL) {
      console.log(`   Exponent YT-hyloSOL-10DEC25: leverage=${finalExponentHyloSOL.leverage}, impliedYield=${finalExponentHyloSOL.impliedYield}, apy=${finalExponentHyloSOL.apy}, source=${finalExponentHyloSOL.source}`);
    }
    
    // ========== Update Gist (Phase 2 + Phase 0 xSOL Metrics) ==========
    console.log('\n📤 Updating Gist with Phase 2 complete data + xSOL metrics...');
    const phase2Timestamp = {
      lastUpdated: new Date().toISOString(),
      phase: 2,
      assetsCount: phase2FinalData.length,
      assets: phase2FinalData,
      xsolMetrics: xsolMetricsData || null,
    };
    
    await updateGist(GIST_ID, phase2Timestamp, GIST_TOKEN);
    console.log('✅ Phase 2 Gist updated - Complete data available!');
    console.log(`🔗 Raw URL: https://gist.githubusercontent.com/TejSingh24/${GIST_ID}/raw/ratex-assets.json`);
    
    // ========== YIELD ALERT CHECK (after Gist write, non-blocking) ==========
    checkYieldAlerts(phase2FinalData).catch(err =>
      console.warn('⚠️ Yield alert check failed:', err.message)
    );
    
    // Close browser
    await browser.close();
    console.log('\n✨ Scraping complete!');
    
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    console.error(error);
    
    if (browser) {
      await browser.close();
    }
    
    process.exit(1);
  }
}

main();
