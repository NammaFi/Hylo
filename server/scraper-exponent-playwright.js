/**
 * Exponent Finance scraper using Playwright (bypasses Vercel checkpoint)
 * Replaces the Puppeteer-based scraper-exponent.js
 * 
 * Playwright runs a real Chromium browser that executes JS challenges natively,
 * so Vercel's security checkpoint is handled automatically.
 */

import { chromium } from 'playwright';

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
    const parts = fullAssetName.split('-');
    const dateStr = parts[parts.length - 1];
    const maturity = parseExponentDate(dateStr);
    if (!maturity) {
      return { maturity: null, maturityDays: null };
    }
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
 * Calculate time until maturity
 * @param {string} maturityUTC - Maturity date string
 * @returns {string} Time until maturity (e.g., "23d 10h")
 */
function calculateMaturesIn(maturityUTC) {
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
 * Scrape all YT assets from Exponent Finance farm page using Playwright
 * @returns {Promise<Array>} Array of asset data with source: "exponent"
 */
export async function scrapeAllExponentAssets() {
  let browser;
  
  try {
    console.log('🚀 Starting Exponent Playwright scraper...');
    
    browser = await chromium.launch({
      headless: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--no-sandbox',
      ],
    });
    
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    // Hide webdriver property
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    const page = await context.newPage();
    
    // Track RPC stats
    const rpcResponses = { total: 0, success: 0, failed: 0 };
    
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
      } catch (_) {
        // Ignore response parsing errors
      }
    });
    
    console.log('📡 Navigating to Exponent Finance farm page...');
    const startTime = Date.now();
    
    await page.goto('https://v1.exponent.finance/farm', {
      waitUntil: 'networkidle',
      timeout: 90000,
    });
    
    // Track when conditions are met
    let leverageTime = null;
    let impliedYieldTime = null;
    let skeletonTime = null;
    
    console.log('⏳ Waiting for asset data to appear...');
    
    // Monitor conditions with polling
    const checkInterval = setInterval(async () => {
      try {
        const status = await page.evaluate(() => {
          const bodyText = document.body.innerText;
          const leverageMatches = bodyText.match(/Effective\s+Exposure[^\d∞]*([\d.]+)\s*x/gi) || [];
          const impliedMatches = bodyText.match(/Implied\s+APY\s*([\d.]+)\s*%/gi) || [];
          const skeletons = document.querySelectorAll('.skeleton-gray');
          return {
            hasValidLeverage: leverageMatches.length > 0,
            hasImpliedYield: impliedMatches.length > 0,
            noSkeletons: skeletons.length === 0,
          };
        });
        
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        
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
      } catch (_) {
        // Ignore errors during checking
      }
    }, 1000);
    
    // Wait for leverage values and skeleton loaders to clear
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
      console.log(`✅ All data loaded in ${totalTime}s`);
    } catch (e) {
      clearInterval(checkInterval);
      console.warn('⚠️  Timeout waiting for data, proceeding with extraction anyway...');
    }
    
    console.log(`📊 RPC Requests: ${rpcResponses.success}/${rpcResponses.total} successful`);
    console.log('🔍 Extracting asset data...');
    
    // Extract token images in one batch
    console.log('🖼️  Extracting asset symbol images...');
    const tokenImages = await page.evaluate(() => {
      const images = {};
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
            
            // Extract Leverage (Effective Exposure) — handle commas
            const leverageMatch = cardText.match(/Effective\s+Exposure[^\d∞]*([\d,.]+|∞)\s*x/i);
            if (leverageMatch) {
              const leverageStr = leverageMatch[1];
              if (leverageStr === '∞') {
                result.leverage = null;
              } else {
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
            
            // Extract Points Per Day
            const pointsMatch = cardText.match(/([\d.]+|∞)\s*pts[\s/]*Day/i);
            if (pointsMatch) {
              const pointsStr = pointsMatch[1];
              result.pointsPerDay = pointsStr === '∞' ? null : parseFloat(pointsStr);
            }
            
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
      const { maturity, maturityDays } = extractMaturityFromAssetName(asset.asset);
      asset.maturity = maturity;
      asset.maturityDays = maturityDays;
      asset.maturesIn = maturity ? calculateMaturesIn(maturity) : null;
      
      asset.rangeLower = asset.apy;
      asset.rangeUpper = null;
      asset.assetBoost = null;
      asset.ratexBoost = null;
      
      // Phase 2 fields — not available yet
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
      
      // Visual assets
      asset.projectBackgroundImage = null;
      asset.projectName = null;
      asset.assetSymbolImage = tokenImages[asset.baseAsset] || null;
    }
    
    await browser.close();
    
    console.log('🎉 Exponent Playwright scraping complete!');
    return assets;
    
  } catch (error) {
    console.error('❌ Error scraping Exponent with Playwright:', error);
    if (browser) {
      await browser.close();
    }
    throw error;
  }
}

/**
 * Scrape Exponent detail pages using a Playwright page instance (Phase 2)
 * @param {import('playwright').Page} page - Playwright page instance
 * @param {Array} assets - Assets to scrape detail pages for
 * @param {Object} existingGistData - Existing Gist data for fallback
 * @param {Function} calculateYtMetricsFn - YT metrics calculation function
 * @param {Function} calculateDaysToMaturityFn - Days to maturity calculation function
 * @returns {Promise<Array>} Assets with Phase 2 data
 */
export async function scrapeExponentDetailPagesPlaywright(page, assets, existingGistData, calculateYtMetricsFn, calculateDaysToMaturityFn) {
  console.log(`\n🔍 Scraping ${assets.length} Exponent detail pages (Playwright)...`);
  const lastUpdated = new Date().toISOString();
  
  for (const asset of assets) {
    try {
      console.log(`\n📄 Processing ${asset.asset}...`);
      
      const baseSlug = assetNameToUrlSlug(asset.asset);
      const urlVariations = [
        `https://v1.exponent.finance/farm/${baseSlug}`,
        `https://v1.exponent.finance/farm/${baseSlug}-1`,
        `https://v1.exponent.finance/farm/${baseSlug}-2`,
        `https://v1.exponent.finance/farm/${baseSlug}-3`
      ];
      
      let detailData = null;
      let attemptNumber = 1;
      let startTime = null;
      
      for (const url of urlVariations) {
        try {
          console.log(`    [Exponent] Attempt ${attemptNumber}/${urlVariations.length}: ${url}`);
          attemptNumber++;
          startTime = Date.now();
          
          const response = await page.goto(url, {
            waitUntil: 'networkidle',
            timeout: 45000
          });
          
          if (response && response.status() === 404) {
            console.log(`      ↳ URL returned 404, trying next variation`);
            continue;
          }
          
          // Wait longer for SPA to render tabs
          await page.waitForTimeout(4000);
          
          // Dump page title for debugging
          const pageTitle = await page.title();
          const bodySnippet = await page.evaluate(() => document.body.innerText.substring(0, 300));
          console.log(`      ↳ Page title: "${pageTitle}"`);
          console.log(`      ↳ Body snippet: ${bodySnippet.replace(/\n/g, ' ').substring(0, 150)}`);
          
          // Try multiple selector strategies for the Details tab
          // Strategy 1: exact button text
          let detailsButton = await page.$('button:has-text("Details")');
          
          // Strategy 2: role=tab with Details text
          if (!detailsButton) {
            detailsButton = await page.$('[role="tab"]:has-text("Details")');
          }
          
          // Strategy 3: any clickable element with exactly "Details" text
          if (!detailsButton) {
            detailsButton = await page.locator('button, [role="tab"], li, a').filter({ hasText: /^Details$/ }).first().elementHandle().catch(() => null);
          }
          
          // Strategy 4: xpath fallback (equivalent to old Puppeteer logic)
          if (!detailsButton) {
            const xpathResult = await page.$('xpath=//button[contains(text(), "Details")] | //div[@role="tab" and contains(text(), "Details")]');
            if (xpathResult) detailsButton = xpathResult;
          }
          
          if (!detailsButton) {
            // Log all tab-like elements to help debug selector
            const tabTexts = await page.evaluate(() => {
              const els = document.querySelectorAll('button, [role="tab"]');
              return Array.from(els).map(e => e.textContent.trim()).filter(t => t.length > 0 && t.length < 40);
            });
            console.log(`      ↳ Tabs/buttons found: ${JSON.stringify(tabTexts)}`);
            throw new Error('Details tab button not found');
          }
          
          await detailsButton.click();
          console.log(`      ↳ Clicked Details tab, waiting for content...`);
          
          // Wait for Details content
          let detailsLoaded = false;
          for (let i = 0; i < 5; i++) {
            await page.waitForTimeout(1000);
            detailsLoaded = await page.evaluate(() => {
              const bodyText = document.body.innerText || document.body.textContent || '';
              return bodyText.includes('This market expires on');
            });
            if (detailsLoaded) {
              console.log(`      ↳ Details content loaded in ${i + 1}s`);
              break;
            }
          }
          
          if (!detailsLoaded) {
            throw new Error('Details tab content did not load after 5s');
          }
          
          // Extract maturity and assetBoost from Details tab
          detailData = await page.evaluate((assetName) => {
            const bodyText = document.body.innerText || document.body.textContent || '';
            
            const result = {
              assetBoost: null,
              maturity: null,
              debugInfo: null
            };
            
            const baseAssetMatch = assetName.match(/^(YT-[A-Za-z0-9*+\-]+?)-\d{2}[A-Z]{3}\d{2}$/i);
            if (!baseAssetMatch) {
              result.debugInfo = `Asset name pattern didn't match: ${assetName}`;
              return result;
            }
            
            const baseAsset = baseAssetMatch[1];
            
            // Extract maturity
            const fullMaturityPattern = /This market expires on ([A-Za-z]+\s+\d+,\s+\d{4})\s+at\s+(\d{1,2}:\d{2}\s+[AP]M)\s*\.?\s*(GMT[+-]\d{1,2}(?::\d{2})?)/i;
            const fullMatch = bodyText.match(fullMaturityPattern);
            
            const simpleMaturityPattern = /This market expires on (\d{1,2})\s+([A-Za-z]{3})\s+(\d{2})/i;
            const simpleMatch = bodyText.match(simpleMaturityPattern);
            
            if (fullMatch) {
              const datePart = fullMatch[1];
              const timePart = fullMatch[2];
              const timezone = fullMatch[3];
              
              const dateMatch = datePart.match(/([A-Za-z]+)\s+(\d+),\s+(\d{4})/);
              const timeMatch = timePart.match(/(\d{1,2}):(\d{2})\s+([AP]M)/i);
              
              if (dateMatch && timeMatch) {
                const monthNames = {
                  'january': '01', 'february': '02', 'march': '03', 'april': '04',
                  'may': '05', 'june': '06', 'july': '07', 'august': '08',
                  'september': '09', 'october': '10', 'november': '11', 'december': '12'
                };
                
                const monthStr = monthNames[dateMatch[1].toLowerCase()];
                const day = dateMatch[2].padStart(2, '0');
                const year = dateMatch[3];
                let hours = parseInt(timeMatch[1]);
                const minutes = timeMatch[2];
                const ampm = timeMatch[3].toUpperCase();
                
                if (ampm === 'PM' && hours !== 12) hours += 12;
                if (ampm === 'AM' && hours === 12) hours = 0;
                
                const tzMatch = timezone.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
                if (tzMatch) {
                  const tzSign = tzMatch[1];
                  const tzHours = parseInt(tzMatch[2]);
                  const tzMinutes = tzMatch[3] ? parseInt(tzMatch[3]) : 0;
                  const tzOffsetMinutes = (tzSign === '+' ? -1 : 1) * (tzHours * 60 + tzMinutes);
                  
                  const localDate = new Date(`${year}-${monthStr}-${day}T${hours.toString().padStart(2, '0')}:${minutes}:00`);
                  const utcDate = new Date(localDate.getTime() + tzOffsetMinutes * 60000);
                  
                  result.maturity = `${utcDate.getUTCFullYear()}-${(utcDate.getUTCMonth() + 1).toString().padStart(2, '0')}-${utcDate.getUTCDate().toString().padStart(2, '0')} ${utcDate.getUTCHours().toString().padStart(2, '0')}:${utcDate.getUTCMinutes().toString().padStart(2, '0')}:00 UTC`;
                }
              }
            } else if (simpleMatch) {
              const day = simpleMatch[1].padStart(2, '0');
              const monthAbbr = simpleMatch[2];
              const yearShort = simpleMatch[3];
              
              const monthMap = {
                'jan': '01', 'feb': '02', 'mar': '03', 'apr': '04',
                'may': '05', 'jun': '06', 'jul': '07', 'aug': '08',
                'sep': '09', 'oct': '10', 'nov': '11', 'dec': '12'
              };
              
              const monthStr = monthMap[monthAbbr.toLowerCase()];
              const year = '20' + yearShort;
              
              if (monthStr) {
                const hours = 10;
                const minutes = '30';
                const tzOffsetMinutes = -(5 * 60 + 30);
                
                const localDate = new Date(`${year}-${monthStr}-${day}T${hours}:${minutes}:00`);
                const utcDate = new Date(localDate.getTime() + tzOffsetMinutes * 60000);
                
                result.maturity = `${utcDate.getUTCFullYear()}-${(utcDate.getUTCMonth() + 1).toString().padStart(2, '0')}-${utcDate.getUTCDate().toString().padStart(2, '0')} ${utcDate.getUTCHours().toString().padStart(2, '0')}:${utcDate.getUTCMinutes().toString().padStart(2, '0')}:00 UTC`;
              }
            }
            
            // Extract assetBoost
            const escapedBaseAsset = baseAsset.replace(/[+*]/g, '\\$&');
            const boostPattern = new RegExp(`${escapedBaseAsset}\\s+\\w+\\s+(\\d+)x\\s+([^.\\n]+)`, 'i');
            const boostMatch = bodyText.match(boostPattern);
            
            if (boostMatch) {
              result.assetBoost = parseInt(boostMatch[1]);
            }
            
            return result;
          }, asset.asset);
          
          if (detailData && detailData.debugInfo) {
            console.log(`      ↳ Debug: ${detailData.debugInfo}`);
          }
          
          if (detailData && detailData.maturity) {
            asset.maturity = detailData.maturity;
            
            const preciseDays = calculateDaysToMaturityFn(asset.maturity, lastUpdated);
            asset.maturityDays = Math.floor(preciseDays);
            asset.maturesIn = calculateMaturesIn(asset.maturity);
            
            if (detailData.assetBoost) {
              asset.assetBoost = detailData.assetBoost;
            }
            
            asset.rangeLower = asset.apy;
            asset.rangeUpper = null;
            
            const ytMetrics = calculateYtMetricsFn(
              asset.maturity,
              asset.impliedYield,
              asset.rangeLower,
              asset.rangeUpper,
              lastUpdated,
              asset.leverage,
              asset.apy,
              preciseDays,
              asset.assetBoost,
              'exponent'
            );
            
            Object.assign(asset, ytMetrics);
            
            console.log(`  ✅ ${asset.asset}: Maturity ${asset.maturity}, Boost ${asset.assetBoost}x, YT Current ${ytMetrics.ytPriceCurrent}`);
            break;
          }
        } catch (urlError) {
          const elapsedTime = startTime ? ((Date.now() - startTime) / 1000).toFixed(1) : '0.0';
          console.warn(`  ⚠️ Failed at ${elapsedTime}s - ${urlError.message}`);
          continue;
        }
      }
      
      if (!detailData || !detailData.maturity) {
        console.warn(`  ⚠️ Failed to fetch ${asset.asset}, using fallback data`);
        
        const oldAsset = existingGistData[asset.asset];
        if (oldAsset && oldAsset.maturity) {
          asset.maturity = oldAsset.maturity;
          asset.maturityDays = Math.floor(calculateDaysToMaturityFn(asset.maturity, lastUpdated));
          asset.maturesIn = calculateMaturesIn(asset.maturity);
          asset.rangeLower = asset.apy;
          asset.rangeUpper = null;
          
          if (oldAsset.assetBoost) {
            asset.assetBoost = oldAsset.assetBoost;
          }
          
          const ytMetrics = calculateYtMetricsFn(
            asset.maturity,
            asset.impliedYield,
            asset.rangeLower,
            asset.rangeUpper,
            lastUpdated,
            asset.leverage,
            asset.apy,
            asset.maturityDays,
            asset.assetBoost,
            'exponent'
          );
          
          Object.assign(asset, ytMetrics);
          console.log(`  📊 Using cached data for ${asset.asset}`);
        }
      }
      
    } catch (error) {
      console.error(`  ❌ Error processing ${asset.asset}:`, error.message);
    }
  }
  
  console.log('✅ Exponent Phase 2 (Playwright) complete');
  return assets;
}

/**
 * Convert Exponent asset name to URL slug
 * "YT-xSOL-12AUG26" → "xsol-12Aug26" (base lowercase, month title-cased)
 * @param {string} assetName
 * @returns {string}
 */
function assetNameToUrlSlug(assetName) {
  const withoutPrefix = assetName.replace(/^YT-/i, '');
  const lastDashIndex = withoutPrefix.lastIndexOf('-');
  let baseAsset = withoutPrefix.substring(0, lastDashIndex).toLowerCase();
  const dateStr = withoutPrefix.substring(lastDashIndex + 1);

  baseAsset = baseAsset
    .replace(/\+/g, 'plus')
    .replace(/\*/g, 'star');

  const day = dateStr.substring(0, 2);
  const month = dateStr.substring(2, 5);
  const year = dateStr.substring(5, 7);

  const formattedDate = day + month.charAt(0).toUpperCase() + month.substring(1).toLowerCase() + year;

  return `${baseAsset}-${formattedDate}`;
}
