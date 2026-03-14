import puppeteerCore from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import { chmod } from 'fs/promises';

const puppeteer = puppeteerCore;

/**
 * Parse Exponent date format (ddMMMyy) to UTC timestamp
 * @param {string} dateStr - Date string like "10DEC25" or "26NOV25"
 * @returns {string|null} - UTC timestamp like "2025-12-10 00:00:00 UTC"
 */
function parseExponentDate(dateStr) {
  if (!dateStr || dateStr.length < 7) return null;
  
  try {
    const dayStr = dateStr.substring(0, 2);
    const monthStr = dateStr.substring(2, 5).toUpperCase();
    const yearStr = dateStr.substring(5, 7);
    
    const monthMap = {
      'JAN': '01', 'FEB': '02', 'MAR': '03', 'APR': '04',
      'MAY': '05', 'JUN': '06', 'JUL': '07', 'AUG': '08',
      'SEP': '09', 'OCT': '10', 'NOV': '11', 'DEC': '12'
    };
    
    const month = monthMap[monthStr];
    if (!month) return null;
    
    const year = `20${yearStr}`;
    return `${year}-${month}-${dayStr} 00:00:00 UTC`;
  } catch (error) {
    console.warn('Error parsing Exponent date:', error.message);
    return null;
  }
}

/**
 * Extract maturity date from asset name and calculate days until maturity
 * @param {string} fullAssetName - Full asset name (e.g., "YT-eUSX-11MAR26")
 * @returns {Object} - { maturity: "2026-03-11 00:00:00 UTC", maturityDays: 106 }
 */
function extractMaturityFromAssetName(fullAssetName) {
  try {
    // Extract date from asset name: "YT-eUSX-11MAR26" → "11MAR26"
    const parts = fullAssetName.split('-');
    const dateStr = parts[parts.length - 1]; // Last part is the date
    
    // Parse the date string
    const maturity = parseExponentDate(dateStr);
    if (!maturity) {
      return { maturity: null, maturityDays: null };
    }
    
    // Calculate days until maturity
    const maturityDate = new Date(maturity);
    const now = new Date();
    const diffMs = maturityDate - now;
    const maturityDays = diffMs > 0 ? Math.floor(diffMs / (1000 * 60 * 60 * 24)) : 0;
    
    return { maturity, maturityDays };
  } catch (error) {
    console.warn('Error extracting maturity from asset name:', error.message);
    return { maturity: null, maturityDays: null };
  }
}

/**
 * Calculate days until maturity from date string
 * @param {string} maturityUTC - UTC timestamp
 * @returns {number|null} - Days until maturity
 */
function calculateMaturityDays(maturityUTC) {
  if (!maturityUTC) return null;
  
  try {
    const maturityDate = new Date(maturityUTC);
    const now = new Date();
    const diffMs = maturityDate - now;
    
    if (diffMs <= 0) return 0;
    
    const days = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    return days;
  } catch (error) {
    console.warn('Error calculating maturity days:', error.message);
    return null;
  }
}

/**
 * Calculate time until maturity from maturity date
 * @param {string} maturityUTC - Maturity date string (e.g., "2025-11-29 00:00:00 UTC")
 * @returns {string} Time until maturity (e.g., "23d 10h")
 */
export function calculateMaturesIn(maturityUTC) {
  try {
    const maturityDate = new Date(maturityUTC);
    const now = new Date();
    const diffMs = maturityDate - now;
    
    if (diffMs <= 0) return "Expired";
    
    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    
    return `${days}d ${hours}h`;
  } catch (error) {
    console.warn('Error calculating maturesIn:', error.message);
    return null;
  }
}

/**
 * Scrape all YT assets from Exponent Finance farm page (Phase 1 - Production)
 * @returns {Promise<Array>} Array of asset data with source: "exponent"
 */
export async function scrapeAllExponentAssets() {
  let browser;
  
  try {
    console.log('🚀 Starting Exponent Phase 1 scraper (PRODUCTION)...');
    
    // Get executable path and ensure it has proper permissions
    const executablePath = await chromium.executablePath();
    
    try {
      await chmod(executablePath, 0o755);
    } catch (chmodError) {
      console.warn('Could not chmod chromium:', chmodError.message);
    }
    
    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        '--single-process',
        '--no-zygote',
        '--disable-blink-features=AutomationControlled', // Hide automation
        '--disable-dev-shm-usage',
        '--no-sandbox'
      ],
      defaultViewport: chromium.defaultViewport,
      executablePath: executablePath,
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });
    
    const page = await browser.newPage();
    
    // Set realistic user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Set extra headers for CORS
    await page.setExtraHTTPHeaders({
      'Origin': 'https://v1.exponent.finance',
      'Referer': 'https://v1.exponent.finance/',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
    });
    
    // ========== FETCH API OVERRIDE: Add CORS headers to Ironforge requests ==========
    await page.evaluateOnNewDocument(() => {
      const originalFetch = window.fetch;
      
      window.fetch = function(...args) {
        let [url, options = {}] = args;
        
        if (typeof url === 'string' && url.includes('rpc.ironforge.network')) {
          if (!options.headers) {
            options.headers = {};
          }
          
          const headers = options.headers instanceof Headers ? options.headers : new Headers(options.headers);
          headers.set('Origin', 'https://v1.exponent.finance');
          headers.set('Referer', 'https://v1.exponent.finance/');
          headers.set('Accept', 'application/json, text/plain, */*');
          headers.set('Accept-Language', 'en-US,en;q=0.9');
          
          options.headers = headers;
        }
        
        return originalFetch(url, options);
      };
    });
    
    // Hide webdriver property
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });
    
    // ========== Network Request Monitoring ==========
    const rpcResponses = { total: 0, success: 0, failed: 0 };
    
    await page.setRequestInterception(true);
    
    page.on('request', request => {
      const url = request.url();
      
      if (url.includes('rpc.ironforge.network')) {
        const headers = {
          ...request.headers(),
          'Origin': 'https://v1.exponent.finance',
          'Referer': 'https://v1.exponent.finance/',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Content-Type': 'application/json',
        };
        
        request.continue({ headers });
      } else {
        request.continue();
      }
    });
    
    // Track RPC response stats
    page.on('response', async response => {
      try {
        const url = response.url();
        const status = response.status();
        
        if (url.includes('rpc.ironforge.network')) {
          rpcResponses.total++;
          if (status === 200) {
            rpcResponses.success++;
          } else {
            rpcResponses.failed++;
          }
        }
      } catch (error) {
        // Ignore response parsing errors
      }
    });
    
    console.log('📡 Navigating to Exponent Finance farm page...');
    const startTime = Date.now();
    await page.goto('https://v1.exponent.finance/farm', {
      waitUntil: 'networkidle0', // Wait until no network activity for 500ms
      timeout: 90000 // 90 seconds for cold starts
    });
    
    // Track when each condition is met
    let leverageTime = null;
    let impliedYieldTime = null;
    let skeletonTime = null;
    let checkRunning = false;
    
    console.log('⏳ Waiting for asset data to appear...');
    
    // Monitor conditions continuously
    const checkStatus = async () => {
      if (checkRunning) return;
      checkRunning = true;
      
      try {
        const status = await page.evaluate(() => {
          const bodyText = document.body.innerText;
          
          // Check for leverage values
          const leverageMatches = bodyText.match(/Effective\s+Exposure[^\d∞]*([\d.]+)\s*x/gi) || [];
          const hasValidLeverage = leverageMatches.length > 0;
          
          // Check for implied yield values
          const impliedMatches = bodyText.match(/Implied\s+APY\s*([\d.]+)\s*%/gi) || [];
          const hasImpliedYield = impliedMatches.length > 0;
          
          // Check if skeleton loaders are gone
          const skeletons = document.querySelectorAll('.skeleton-gray');
          const noSkeletons = skeletons.length === 0;
          
          return {
            hasValidLeverage,
            hasImpliedYield,
            noSkeletons
          };
        });
        
        const currentTime = Date.now();
        const elapsed = ((currentTime - startTime) / 1000).toFixed(1);
        
        if (status.hasValidLeverage && !leverageTime) {
          leverageTime = elapsed;
          console.log(`  ✅ Leverage values appeared at t=${elapsed}s`);
        }
        
        if (status.hasImpliedYield && !impliedYieldTime) {
          impliedYieldTime = elapsed;
          console.log(`  ✅ Implied Yield values appeared at t=${elapsed}s`);
        }
        
        if (status.noSkeletons && !skeletonTime) {
          skeletonTime = elapsed;
          console.log(`  ✅ Skeleton loaders cleared at t=${elapsed}s`);
        }
      } catch (e) {
        // Ignore errors during checking
      }
      
      checkRunning = false;
    };
    
    const checkInterval = setInterval(() => checkStatus(), 1000);
    
    // Wait for all conditions to be met
    try {
      await page.waitForFunction(
        () => {
          const bodyText = document.body.innerText;
          const leverageMatches = bodyText.match(/Effective\s+Exposure[^\d∞]*([\d.]+)\s*x/gi) || [];
          const hasValidLeverage = leverageMatches.length > 0;
          
          const skeletons = document.querySelectorAll('.skeleton-gray');
          const noSkeletons = skeletons.length === 0;
          
          return hasValidLeverage && noSkeletons;
        },
        { timeout: 60000, polling: 1000 }
      );
      
      clearInterval(checkInterval);
      const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`✅ All data loaded in ${totalTime}s (from Exponent page load)`);
    } catch (e) {
      clearInterval(checkInterval);
      console.warn('⚠️  Timeout waiting for data, proceeding with extraction anyway...');
    }
    
    // Log final RPC stats
    console.log(`📊 RPC Requests: ${rpcResponses.success}/${rpcResponses.total} successful`);
    
    console.log('🔍 Extracting asset data...');
    
    // Extract all token images in one batch (fast - single query)
    console.log('🖼️  Extracting asset symbol images...');
    const tokenImages = await page.evaluate(() => {
      const images = {};
      // Search through all token images
      document.querySelectorAll('img[src*="/images/icons/tokens/"]').forEach(img => {
        const card = img.closest('[class*="card"]') || img.closest('div');
        if (card) {
          const text = card.textContent;
          const match = text.match(/YT-([A-Za-z0-9*+\-]+)-\d{2}[A-Z]{3}\d{2}/);
          if (match) {
            images[match[1]] = img.src;
          }
        }
      });
      return images;
    });
    console.log(`   Found ${Object.keys(tokenImages).length} token images`);
    
    // Extract all asset data
    const assets = await page.evaluate(() => {
      const results = [];
      const processedAssets = new Set();
      
      const allElements = Array.from(document.querySelectorAll('*'));
      
      for (const element of allElements) {
        const text = element.textContent || '';
        
        // Match pattern: YT-{asset}-{ddMMMyy}
        const assetMatch = text.match(/YT-([A-Za-z0-9*+\-]+)-(\d{2}[A-Z]{3}\d{2})/);
        
        if (assetMatch) {
          const fullAssetName = assetMatch[0];
          const baseAsset = assetMatch[1];
          const dateStr = assetMatch[2];
          
          if (processedAssets.has(fullAssetName)) continue;
          
          // Find parent card containing all data
          let current = element;
          let bestCard = null;
          let smallestLevel = 999;
          
          for (let i = 0; i < 15; i++) {
            if (!current.parentElement) break;
            current = current.parentElement;
            
            const cardText = current.textContent;
            
            const hasEffectiveExposure = cardText.includes('Effective Exposure') || cardText.includes('Yield Exposure');
            const hasUnderlyingAPY = cardText.includes('Underlying APY');
            const hasImpliedAPY = cardText.includes('Implied APY') || cardText.includes('Implied Yield');
            const hasAssetName = cardText.includes(fullAssetName);
            
            const assetPatterns = cardText.match(/YT-[A-Za-z0-9*+\-]+-\d{2}[A-Z]{3}\d{2}/g);
            const isIndividualCard = assetPatterns && assetPatterns.length === 1;
            
            if (hasEffectiveExposure && hasUnderlyingAPY && hasImpliedAPY && hasAssetName && isIndividualCard) {
              if (i < smallestLevel) {
                bestCard = current;
                smallestLevel = i;
              }
            }
          }
          
          if (bestCard) {
            const cardText = bestCard.textContent;
            
            const result = {
              asset: fullAssetName,
              baseAsset: baseAsset,
              dateStr: dateStr,
              leverage: null,
              apy: null,
              impliedYield: null,
              pointsPerDay: null,
              source: 'exponent'
            };
            
            // Extract Leverage (Effective Exposure)
            // Match numbers with optional commas (e.g., 1,413.84x)
            const leverageMatch = cardText.match(/Effective\s+Exposure[^\d∞]*([\d,.]+|∞)\s*x/i);
            if (leverageMatch) {
              const leverageStr = leverageMatch[1];
              if (leverageStr === '∞') {
                console.warn(`  ⚠️  ${fullAssetName}: Leverage still showing ∞x (data not loaded)`);
                result.leverage = null;
              } else {
                // Remove commas before parsing (e.g., "1,413.84" -> "1413.84")
                result.leverage = parseFloat(leverageStr.replace(/,/g, ''));
              }
            }
            
            // Extract Underlying APY
            const apyMatch = cardText.match(/Underlying\s+APY\s*([\d.]+)\s*%/i);
            if (apyMatch) {
              result.apy = parseFloat(apyMatch[1]);
            }
            
            // Extract Implied APY
            const impliedMatch = cardText.match(/Implied\s+APY\s*([\d.]+)\s*%/i);
            if (impliedMatch) {
              result.impliedYield = parseFloat(impliedMatch[1]);
            }
            
            // Extract Points Per Day (may not be on farm page cards)
            const pointsMatch = cardText.match(/([\d.]+|∞)\s*pts[\s/]*Day/i);
            if (pointsMatch) {
              const pointsStr = pointsMatch[1];
              result.pointsPerDay = pointsStr === '∞' ? null : parseFloat(pointsStr);
            }
            
            // Only add if we got essential data
            if (result.leverage !== null || result.apy !== null) {
              results.push(result);
              processedAssets.add(fullAssetName);
            }
          }
        }
      }
      
      return results;
    });
    
    console.log(`✅ Found ${assets.length} Exponent assets`);
    
    // Process dates and set field mappings
    for (const asset of assets) {
      // Extract maturity from asset name (will be overridden by OLD gist data in scrape-once.js)
      const { maturity, maturityDays } = extractMaturityFromAssetName(asset.asset);
      asset.maturity = maturity;
      asset.maturityDays = maturityDays;
      asset.maturesIn = maturity ? calculateMaturesIn(maturity) : null;
      
      // Set field mappings (APY validation happens externally)
      asset.rangeLower = asset.apy; // Will be overridden by external validation if match found
      asset.rangeUpper = null; // Exponent doesn't have upper range (Phase 1)
      asset.assetBoost = null; // Will be filled from OLD gist or RateX match or Phase 2
      asset.ratexBoost = null; // Exponent doesn't have RateX boost
      
      // Phase 2 fields - not available yet
      asset.ytPriceCurrent = null;
      asset.ytPriceLower = null;
      asset.ytPriceUpper = null;
      asset.upsidePotential = null;
      asset.downsideRisk = null;
      asset.endDayCurrentYield = null;
      asset.endDayLowerYield = null;
      asset.dailyDecayRate = null;
      asset.expectedRecoveryYield = null;
      asset.expectedPointsPerDay = null;
      asset.totalExpectedPoints = null;
      
      // Visual assets - not available on farm page (Phase 1)
      asset.projectBackgroundImage = null;
      asset.projectName = null;
      asset.assetSymbolImage = tokenImages[asset.baseAsset] || null;
    }
    
    await browser.close();
    
    console.log('🎉 Exponent Phase 1 scraping complete!');
    return assets;
    
  } catch (error) {
    console.error('❌ Error scraping Exponent:', error);
    if (browser) {
      await browser.close();
    }
    throw error;
  }
}
