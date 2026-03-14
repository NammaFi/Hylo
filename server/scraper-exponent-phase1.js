import puppeteerCore from 'puppeteer-core';

const puppeteer = puppeteerCore;

/**
 * Parse Exponent date format (ddMMMyy) to UTC timestamp
 * @param {string} dateStr - Date string like "10DEC25" or "26NOV25"
 * @returns {string|null} - UTC timestamp like "2025-12-10 00:00:00 UTC"
 */
function parseExponentDate(dateStr) {
  if (!dateStr || dateStr.length < 7) return null;
  
  try {
    // Extract components: "10DEC25" -> day=10, month=DEC, year=25
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
    
    // Convert 2-digit year to 4-digit (assume 20xx)
    const year = `20${yearStr}`;
    
    // Construct UTC timestamp
    return `${year}-${month}-${dayStr} 00:00:00 UTC`;
  } catch (error) {
    console.warn('Error parsing Exponent date:', error.message);
    return null;
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
 * Scrape all YT assets from Exponent Finance farm page (Phase 1 only)
 * @param {Object} options - Configuration options
 * @param {string} options.executablePath - Path to browser executable (Edge or Chrome)
 * @param {boolean} options.headless - Run in headless mode (default: true)
 * @param {Array} options.ratexAssets - Array of RateX assets for APY validation (optional)
 * @returns {Promise<Array>} Array of asset data
 */
export async function scrapeExponentPhase1(options = {}) {
  const {
    executablePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless = true,
    ratexAssets = []
  } = options;
  
  let browser;
  
  try {
    console.log('🚀 Starting Exponent Phase 1 scraper...');
    console.log(`Browser: ${executablePath}`);
    console.log(`Headless: ${headless}`);
    
    browser = await puppeteer.launch({
      executablePath: executablePath,
      headless: headless,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      defaultViewport: { width: 1920, height: 1080 }
    });
    
    const page = await browser.newPage();
    
    console.log('📡 Navigating to Exponent Finance farm page...');
    await page.goto('https://v1.exponent.finance/farm', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    
    // Wait for content to load
    console.log('⏳ Waiting for content to load...');
    await page.waitForTimeout(3000);
    
    // Scroll to load all cards
    console.log('📜 Scrolling to load all cards...');
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => {
        window.scrollBy(0, 1500);
      });
      await page.waitForTimeout(1000);
    }
    
    // Wait for skeleton loaders to disappear (Implied APY loads dynamically)
    console.log('⏳ Waiting for Implied APY to load (skeleton loaders)...');
    try {
      await page.waitForFunction(
        () => {
          const skeletons = document.querySelectorAll('.skeleton-gray');
          return skeletons.length === 0;
        },
        { timeout: 10000 }
      );
      console.log('✅ Implied APY data loaded!');
    } catch (e) {
      console.warn('⚠️  Timeout waiting for skeleton loaders, proceeding anyway...');
    }
    
    // Wait for leverage values to load (should show numbers like 10x, 200x, not ∞x)
    console.log('⏳ Waiting for leverage values to load properly...');
    try {
      await page.waitForFunction(
        () => {
          const bodyText = document.body.textContent;
          // Check if we have actual numeric leverage values (not just ∞x everywhere)
          const numericLeverageMatches = bodyText.match(/Effective\s+Exposure[\s\S]{0,20}[\d.]+x/gi);
          // Should have at least a few numeric leverage values
          return numericLeverageMatches && numericLeverageMatches.length >= 5;
        },
        { timeout: 15000 }
      );
      console.log('✅ Leverage data loaded!');
    } catch (e) {
      console.warn('⚠️  Timeout waiting for leverage data, proceeding anyway...');
    }
    
    // Additional wait to ensure all data is rendered
    await page.waitForTimeout(2000);
    
    console.log('🔍 Extracting asset data...');
    
    // Extract all asset data
    const assets = await page.evaluate(() => {
      const results = [];
      const processedAssets = new Set();
      
      // Find all text nodes that match YT-{asset}-{date} pattern
      const allElements = Array.from(document.querySelectorAll('*'));
      
      for (const element of allElements) {
        const text = element.textContent || '';
        
        // Match pattern: YT-{asset}-{ddMMMyy}
        // Example: YT-hyloSOL-10DEC25, YT-xSOL-26NOV25
        const assetMatch = text.match(/YT-([A-Za-z0-9*+\-]+)-(\d{2}[A-Z]{3}\d{2})/);
        
        if (assetMatch) {
          const fullAssetName = assetMatch[0];  // "YT-hyloSOL-10DEC25"
          const baseAsset = assetMatch[1];       // "hyloSOL"
          const dateStr = assetMatch[2];         // "10DEC25"
          
          // Skip if already processed
          if (processedAssets.has(fullAssetName)) continue;
          
          // Find parent card containing all data
          let current = element;
          let bestCard = null;
          let smallestLevel = 999;
          
          for (let i = 0; i < 15; i++) {
            if (!current.parentElement) break;
            current = current.parentElement;
            
            const cardText = current.textContent;
            
            // Check if this is a complete card
            const hasEffectiveExposure = cardText.includes('Effective Exposure') || cardText.includes('Yield Exposure');
            const hasUnderlyingAPY = cardText.includes('Underlying APY');
            const hasImpliedAPY = cardText.includes('Implied APY') || cardText.includes('Implied Yield');
            const hasAssetName = cardText.includes(fullAssetName);
            
            // Check it's an individual card (not the entire page)
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
            // Pattern: "Effective Exposure∞x" or "209.21x" or "1,413.84x"
            // Note: ∞x means data hasn't loaded yet, should always be a number
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
            // Pattern: "Underlying APY7.53%" (may have no space)
            const apyMatch = cardText.match(/Underlying\s+APY\s*([\d.]+)\s*%/i);
            if (apyMatch) {
              result.apy = parseFloat(apyMatch[1]);
            }
            
            // Extract Implied APY
            // Pattern: "Implied APY11.57%" (may have no space between label and value)
            // Look for percentage value immediately after "Implied APY" text
            const impliedMatch = cardText.match(/Implied\s+APY\s*([\d.]+)\s*%/i);
            if (impliedMatch) {
              result.impliedYield = parseFloat(impliedMatch[1]);
            }
            
            // Extract Points Per Day (may not be on farm page cards)
            // Pattern: "1234 pts/Day" or "∞ pts/Day"
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
    
    console.log(`✅ Found ${assets.length} assets`);
    
    // Create baseAsset lookup map from RateX data (case-insensitive)
    const ratexLookup = new Map();
    if (ratexAssets && ratexAssets.length > 0) {
      ratexAssets.forEach(ratexAsset => {
        const baseAssetLower = ratexAsset.baseAsset.toLowerCase();
        ratexLookup.set(baseAssetLower, ratexAsset);
      });
      console.log(`📊 Loaded ${ratexLookup.size} RateX assets for APY validation`);
    }
    
    // Process dates and calculate maturity days
    for (const asset of assets) {
      asset.maturity = parseExponentDate(asset.dateStr);
      asset.maturityDays = calculateMaturityDays(asset.maturity);
      
      // APY Validation: Check if this asset exists in RateX data
      const baseAssetLower = asset.baseAsset.toLowerCase();
      const ratexMatch = ratexLookup.get(baseAssetLower);
      
      if (ratexMatch) {
        // Match found - use RateX APY (more reliable)
        console.log(`  🔄 ${asset.asset}: Using RateX APY ${ratexMatch.apy}% (was ${asset.apy}%)`);
        asset.apy = ratexMatch.apy;
        asset.rangeLower = ratexMatch.apy; // Use RateX APY as rangeLower
      } else {
        // No match - use Exponent APY as fallback
        asset.rangeLower = asset.apy; // Use Exponent's underlying APY as rangeLower
      }
      
      // Set Exponent-specific field mappings
      asset.assetBoost = asset.pointsPerDay; // Points/Day maps to assetBoost
      asset.ratexBoost = null; // Exponent doesn't have RateX boost
      asset.rangeUpper = null; // Exponent doesn't have upper range
    }
    
    await browser.close();
    
    console.log('🎉 Scraping complete!');
    return assets;
    
  } catch (error) {
    console.error('❌ Error scraping Exponent:', error);
    if (browser) {
      await browser.close();
    }
    throw error;
  }
}
