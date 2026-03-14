import puppeteer from 'puppeteer-core';

/**
 * Convert fullAssetName to Exponent detail page URL slug
 * @param {string} fullAssetName - e.g., "YT-eUSX-11MAR26" or "YT-hyloSOL+-15DEC25"
 * @returns {string} - e.g., "eusx-11Mar26" or "hylosolplus-15Dec25"
 */
function assetNameToUrlSlug(fullAssetName) {
  // Remove "YT-" prefix
  const withoutPrefix = fullAssetName.replace(/^YT-/i, '');
  
  // Split by last dash to get baseAsset and date
  const lastDashIndex = withoutPrefix.lastIndexOf('-');
  let baseAsset = withoutPrefix.substring(0, lastDashIndex).toLowerCase();
  const dateStr = withoutPrefix.substring(lastDashIndex + 1);
  
  // Handle special characters in baseAsset
  // hyloSOL+ → hylosolplus
  // USD* → usdstar (if needed)
  baseAsset = baseAsset
    .replace(/\+/g, 'plus')
    .replace(/\*/g, 'star');
  
  // Format date: "11MAR26" → "11Mar26"
  // First 2 chars are day (lowercase), next 3 are month (capitalize), last 2 are year (lowercase)
  const day = dateStr.substring(0, 2);
  const month = dateStr.substring(2, 5);
  const year = dateStr.substring(5, 7);
  
  const formattedDate = day + month.charAt(0).toUpperCase() + month.substring(1).toLowerCase() + year;
  
  return `${baseAsset}-${formattedDate}`;
}

/**
 * Scrape Exponent Finance detail page for assetBoost
 * @param {Object} options - Configuration options
 * @param {string} options.fullAssetName - Full asset name (e.g., "YT-eUSX-11MAR26")
 * @param {string} options.executablePath - Path to browser executable
 * @param {boolean} options.headless - Run in headless mode
 * @returns {Promise<Object>} Detail page data
 */
async function scrapeExponentDetailPage({ fullAssetName, executablePath, headless = false }) {
  let browser;
  
  try {
    console.log(`\n🔍 Scraping detail page for: ${fullAssetName}`);
    
    // Convert asset name to URL slug
    const baseSlug = assetNameToUrlSlug(fullAssetName);
    
    // Launch browser
    browser = await puppeteer.launch({
      executablePath: executablePath,
      headless: headless,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
    
    // Try multiple URL variations (base, -1, -2, -3)
    const urlVariations = [
      `https://v1.exponent.finance/farm/${baseSlug}`,
      `https://v1.exponent.finance/farm/${baseSlug}-1`,
      `https://v1.exponent.finance/farm/${baseSlug}-2`,
      `https://v1.exponent.finance/farm/${baseSlug}-3`
    ];
    
    let detailData = null;
    let successUrl = null;
    
    for (const url of urlVariations) {
      try {
        console.log(`📍 Trying URL: ${url}`);
        
        // Navigate to detail page
        const response = await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: 30000
        });
        
        // Check if page loaded successfully (not 404)
        if (response.status() === 404) {
          console.log('  ⚠️  404 Not Found, trying next variation...');
          continue;
        }
        
        // Wait for content to load
        await page.waitForTimeout(2000);
        
        // Check if we need to click the Details tab
        console.log('  🔍 Checking if Details tab needs to be clicked...');
        const needsDetailsClick = await page.evaluate(() => {
          const bodyText = document.body.innerText || document.body.textContent || '';
          // Check if maturity text is already visible
          const hasMaturityText = bodyText.includes('This market expires on');
          return !hasMaturityText;
        });
        
        if (needsDetailsClick) {
          console.log('  🖱️  Attempting to click Details tab...');
          
          try {
            // Method 1: Try to find and click using XPath for text content
            const detailsElements = await page.$x("//button[contains(text(), 'Details')] | //div[contains(text(), 'Details')] | //a[contains(text(), 'Details')]");
            
            if (detailsElements.length > 0) {
              console.log(`  🔍 Found ${detailsElements.length} element(s) with "Details" text`);
              
              // Click the first one
              await detailsElements[0].click();
              console.log('  ✅ Clicked Details element using XPath');
            } else {
              // Method 2: Try finding by visible text using evaluate
              console.log('  ⚠️  No XPath match, trying alternative method...');
              await page.evaluate(() => {
                // Find all clickable elements
                const elements = Array.from(document.querySelectorAll('button, div, span, a, [role="button"], [role="tab"]'));
                const detailsElement = elements.find(el => {
                  const text = el.textContent || '';
                  return text.trim().toLowerCase() === 'details';
                });
                if (detailsElement) {
                  // Try multiple click methods
                  detailsElement.click();
                  detailsElement.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                }
              });
              console.log('  ✅ Attempted click with dispatchEvent');
            }
          } catch (e) {
            console.log('  ❌ Click failed:', e.message);
          }
          
          // Wait for Details tab content to load
          console.log('  ⏳ Waiting for Details content to load...');
          await page.waitForTimeout(3000);
          
        } else {
          console.log('  ✅ Details already visible');
        }
        
        // Validate page contains asset name (base or full)
        const hasAssetName = await page.evaluate((fullName, baseName) => {
          const text = document.body.innerText || document.body.textContent || '';
          // Check if page contains fullAssetName (YT-eUSX-11MAR26) or baseAsset (YT-eUSX)
          return text.includes(fullName) || text.includes(baseName);
        }, fullAssetName, fullAssetName.replace(/-\d{2}[A-Z]{3}\d{2}$/i, ''));
        
        if (!hasAssetName) {
          console.log('  ⚠️  Page does not contain asset name, trying next variation...');
          continue;
        }
        
        console.log('  🔍 Extracting assetBoost...');
        
        // DEBUG: Check what's actually visible after Details tab click
        const debugInfo = await page.evaluate(() => {
          const bodyText = document.body.innerText || document.body.textContent || '';
          return {
            textLength: bodyText.length,
            hasExpiresText: bodyText.toLowerCase().includes('expires'),
            hasMaturityText: bodyText.toLowerCase().includes('maturity'),
            hasDetailsText: bodyText.toLowerCase().includes('details'),
            textSample: bodyText.substring(0, 2000)
          };
        });
        console.log('  🐛 DEBUG after wait:', JSON.stringify(debugInfo, null, 2));
        
        detailData = await page.evaluate((assetName) => {
          const bodyText = document.body.innerText || document.body.textContent || '';
          
          const result = {
            assetBoost: null,
            boostProgramName: null,
            maturity: null,
            maturityRaw: null,
            hasPointsOnlyText: bodyText.includes('Points-only market'),
            hasExpiresText: bodyText.includes('expires on'),
            rawText: bodyText.substring(0, 3000), // Increased for debugging
            textLength: bodyText.length
          };
          
          // Extract baseAsset without date (e.g., "YT-eUSX" from "YT-eUSX-11MAR26")
          // Remove the date suffix: -ddMMMyy
          const baseAssetMatch = assetName.match(/^(YT-[A-Za-z0-9*+\-]+?)-\d{2}[A-Z]{3}\d{2}$/i);
          if (!baseAssetMatch) return result;
          
          const baseAsset = baseAssetMatch[1]; // "YT-eUSX" without date
          
          // Try to extract maturity - two formats:
          // 1. Full: "This market expires on December 10, 2025 at 10:28 PM GMT+5:30"
          // 2. Simple: "This market expires on 11 Mar 26"
          
          // Try full format first
          const fullMaturityPattern = /This market expires on ([A-Za-z]+\s+\d+,\s+\d{4})\s+at\s+(\d{1,2}:\d{2}\s+[AP]M)\s+(GMT[+-]\d{1,2}:\d{2})/i;
          const fullMatch = bodyText.match(fullMaturityPattern);
          
          // Try simple format if full doesn't match
          const simpleMaturityPattern = /This market expires on (\d{1,2})\s+([A-Za-z]{3})\s+(\d{2})/i;
          const simpleMatch = bodyText.match(simpleMaturityPattern);
          
          if (fullMatch) {
            // Full format with time and timezone
            const datePart = fullMatch[1]; // "December 10, 2025"
            const timePart = fullMatch[2]; // "10:28 PM"
            const timezone = fullMatch[3]; // "GMT+5:30"
            
            result.maturityRaw = `${datePart} at ${timePart} ${timezone}`;
            
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
              
              // Convert to 24-hour format
              if (ampm === 'PM' && hours !== 12) hours += 12;
              if (ampm === 'AM' && hours === 12) hours = 0;
              
              // Parse timezone offset (GMT+5:30 → +5.5 hours)
              const tzMatch = timezone.match(/GMT([+-])(\d{1,2}):(\d{2})/);
              if (tzMatch) {
                const tzSign = tzMatch[1];
                const tzHours = parseInt(tzMatch[2]);
                const tzMinutes = parseInt(tzMatch[3]);
                const tzOffsetMinutes = (tzSign === '+' ? -1 : 1) * (tzHours * 60 + tzMinutes);
                
                // Convert to UTC
                const localDate = new Date(`${year}-${monthStr}-${day}T${hours.toString().padStart(2, '0')}:${minutes}:00`);
                const utcDate = new Date(localDate.getTime() + tzOffsetMinutes * 60000);
                
                result.maturity = `${utcDate.getUTCFullYear()}-${(utcDate.getUTCMonth() + 1).toString().padStart(2, '0')}-${utcDate.getUTCDate().toString().padStart(2, '0')} ${utcDate.getUTCHours().toString().padStart(2, '0')}:${utcDate.getUTCMinutes().toString().padStart(2, '0')}:00 UTC`;
              }
            }
          } else if (simpleMatch) {
            // Simple format - date only, default to 4 PM GMT+5:30
            const day = simpleMatch[1].padStart(2, '0');
            const monthAbbr = simpleMatch[2]; // "Mar", "Dec", etc.
            const yearShort = simpleMatch[3]; // "26" for 2026
            
            const monthMap = {
              'jan': '01', 'feb': '02', 'mar': '03', 'apr': '04',
              'may': '05', 'jun': '06', 'jul': '07', 'aug': '08',
              'sep': '09', 'oct': '10', 'nov': '11', 'dec': '12'
            };
            
            const monthStr = monthMap[monthAbbr.toLowerCase()];
            const year = '20' + yearShort; // "26" → "2026"
            
            result.maturityRaw = `${day} ${monthAbbr} ${year} at 4:00 PM GMT+5:30 (default)`;
            
            if (monthStr) {
              // Set time to 4 PM (16:00) GMT+5:30
              const hours = 16;
              const minutes = '00';
              
              // GMT+5:30 offset: subtract 5h 30m to get UTC
              const tzOffsetMinutes = -(5 * 60 + 30);
              
              // Convert to UTC
              const localDate = new Date(`${year}-${monthStr}-${day}T${hours}:${minutes}:00`);
              const utcDate = new Date(localDate.getTime() + tzOffsetMinutes * 60000);
              
              result.maturity = `${utcDate.getUTCFullYear()}-${(utcDate.getUTCMonth() + 1).toString().padStart(2, '0')}-${utcDate.getUTCDate().toString().padStart(2, '0')} ${utcDate.getUTCHours().toString().padStart(2, '0')}:${utcDate.getUTCMinutes().toString().padStart(2, '0')}:00 UTC`;
            }
          }
          
          // Look for pattern: "{baseAsset} {any_word} {number}x"
          // Examples:
          //   "YT-eUSX receives 15x Solstice Flares"
          //   "YT-hyloSOL earns 2x Hylo XP Points"
          //   "YT-xSOL gets 10x Something" (any verb works)
          // Escape special regex characters in baseAsset (+ and *)
          const escapedBaseAsset = baseAsset.replace(/[+*]/g, '\\$&');
          const boostPattern = new RegExp(`${escapedBaseAsset}\\s+\\w+\\s+(\\d+)x\\s+([^.\\n]+)`, 'i');
          const boostMatch = bodyText.match(boostPattern);
          
          if (boostMatch) {
            result.assetBoost = parseInt(boostMatch[1]); // Group 1 is the number
            result.boostProgramName = boostMatch[2].trim();
          }
          
          return result;
        }, fullAssetName);
        
        successUrl = url;
        console.log(`  ✅ Success! Data extracted from: ${url}`);
        
        // ============================================================
        // INVESTIGATION: Navigate to Overview tab and extract price
        // ============================================================
        console.log('\n  🔬 INVESTIGATING PRICE EXTRACTION...');
        
        try {
          // Step 1: Click Overview tab to go back
          console.log('  📍 Step 1: Clicking Overview tab...');
          const overviewElements = await page.$x("//button[contains(text(), 'Overview')] | //div[contains(text(), 'Overview')]");
          if (overviewElements.length > 0) {
            await overviewElements[0].click();
            console.log('  ✅ Clicked Overview tab');
            await page.waitForTimeout(2000);
          } else {
            console.log('  ⚠️  Overview tab not found, might already be visible');
          }
          
          // Step 2: Check for Effective Exposure on Overview tab
          console.log('  📍 Step 2: Checking for Effective Exposure...');
          try {
            await page.waitForFunction(
              () => {
                const bodyText = document.body.innerText || document.body.textContent || '';
                const exposureMatch = bodyText.match(/Effective\s+Exposure\s+([\d.]+)x/i);
                return exposureMatch !== null;
              },
              { timeout: 10000 }
            );
            console.log('  ✅ Effective Exposure loaded on Overview tab');
          } catch (e) {
            console.log('  ⚠️  Effective Exposure not found or timeout');
          }
          
          // Step 3: Scroll to Historical Data section (mid-page, not bottom)
          console.log('  📍 Step 3: Scrolling to Historical Data section...');
          await page.evaluate(() => {
            // Look for "Historical Data" text and scroll to it
            const allText = Array.from(document.querySelectorAll('*')).find(el => 
              el.textContent && el.textContent.includes('Historical Data')
            );
            if (allText) {
              allText.scrollIntoView({ behavior: 'smooth', block: 'center' });
            } else {
              // Fallback: scroll to middle of page
              window.scrollTo(0, document.body.scrollHeight / 2);
            }
          });
          // Reduced wait time - chart will load when Price tab is clicked
          await page.waitForTimeout(500);
          
          // Step 4: Look for "Historical Data" section and price tab
          console.log('  📍 Step 4: Looking for Historical Data section...');
          const historicalDataInfo = await page.evaluate(() => {
            const bodyText = document.body.innerText || document.body.textContent || '';
            return {
              hasHistoricalData: bodyText.includes('Historical Data'),
              hasImpliedAPY: bodyText.includes('Implied APY'),
              hasPrice: bodyText.includes('Price'),
              pageBottom: bodyText.substring(bodyText.length - 1000)
            };
          });
          console.log('  🔍 Historical Data check:', JSON.stringify(historicalDataInfo, null, 2));
          
          // Step 5: Try to click on "YT-{asset} Price" tab
          console.log('  📍 Step 5: Looking for YT-asset Price tab to click...');
          
          // Extract base asset name from fullAssetName (e.g., "YT-eUSX" from "YT-eUSX-11MAR26")
          const baseAssetForPrice = fullAssetName.replace(/-\d{2}[A-Z]{3}\d{2}$/i, '');
          const priceTabText = `${baseAssetForPrice} Price`;
          console.log(`  🔍 Looking for tab with text: "${priceTabText}"`);
          
          // Try to find and click the Price tab by exact text match
          const priceTabClicked = await page.evaluate((targetText) => {
            // Find all elements that might be tabs
            const allElements = Array.from(document.querySelectorAll('button, div, span, a, [role="tab"]'));
            const priceTab = allElements.find(el => {
              const text = el.textContent || '';
              return text.trim() === targetText;
            });
            
            if (priceTab) {
              priceTab.click();
              // Also try dispatching click event
              priceTab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
              return { success: true, text: priceTab.textContent, tagName: priceTab.tagName, className: priceTab.className };
            }
            return { success: false };
          }, priceTabText);
          
          console.log('  🎯 Price tab click result:', JSON.stringify(priceTabClicked, null, 2));
          
          if (priceTabClicked.success) {
            console.log('  ✅ Clicked Price tab successfully');
            await page.waitForTimeout(3000); // Wait longer for chart to load
          } else {
            console.log('  ⚠️  Could not find exact Price tab, trying partial match...');
            
            // Try partial match with "Price"
            const partialMatch = await page.evaluate(() => {
              const allElements = Array.from(document.querySelectorAll('button, div, span, a, [role="tab"]'));
              const priceTab = allElements.find(el => {
                const text = el.textContent || '';
                return text.includes('Price') && text.includes('YT-');
              });
              
              if (priceTab) {
                priceTab.click();
                priceTab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                return { success: true, text: priceTab.textContent.trim() };
              }
              return { success: false };
            });
            console.log('  🎯 Partial match result:', JSON.stringify(partialMatch, null, 2));
            
            if (partialMatch.success) {
              await page.waitForTimeout(3000);
            }
          }
          
          // Step 6: Investigate chart elements and tooltip structure
          console.log('  📍 Step 6: Investigating chart structure...');
          const chartInfo = await page.evaluate(() => {
            const result = {
              svgElements: document.querySelectorAll('svg').length,
              canvasElements: document.querySelectorAll('canvas').length,
              chartContainers: [],
              tooltipElements: [],
              dataAttributes: []
            };
            
            // Look for common chart container classes
            const chartClasses = ['chart', 'graph', 'historical', 'recharts', 'chartjs', 'highcharts'];
            chartClasses.forEach(cls => {
              const elements = document.querySelectorAll(`[class*="${cls}"]`);
              if (elements.length > 0) {
                result.chartContainers.push({ class: cls, count: elements.length });
              }
            });
            
            // Look for tooltip elements
            const tooltipClasses = ['tooltip', 'hover', 'popup', 'overlay'];
            tooltipClasses.forEach(cls => {
              const elements = document.querySelectorAll(`[class*="${cls}"]`);
              if (elements.length > 0) {
                result.tooltipElements.push({ class: cls, count: elements.length });
              }
            });
            
            // Look for data attributes
            const allElements = document.querySelectorAll('[data-value], [data-price], [data-point]');
            result.dataAttributes = Array.from(allElements).slice(0, 3).map(el => ({
              tag: el.tagName,
              class: el.className,
              dataAttrs: Object.keys(el.dataset)
            }));
            
            return result;
          });
          console.log('  📊 Chart structure:', JSON.stringify(chartInfo, null, 2));
          
          // Step 7: Extract chart data directly from SVG elements
          console.log('  📍 Step 7: Extracting chart data from SVG elements...');
          
          // Take screenshot before extraction
          await page.screenshot({ path: 'before-extraction.png', fullPage: false });
          console.log('  📸 Screenshot saved: before-extraction.png');
          
          // Try multiple extraction methods for Recharts
          const chartDataExtraction = await page.evaluate(() => {
            const result = {
              method: null,
              success: false,
              rightmostValue: null,
              allDataPoints: [],
              debug: {}
            };
            
            // Method 1: Look for Recharts line chart data points (circles or dots)
            const rechartsWrapper = document.querySelector('.recharts-wrapper');
            const svg = rechartsWrapper ? rechartsWrapper.querySelector('svg') : document.querySelector('svg');
            
            if (!svg) {
              result.debug.error = 'No SVG found';
              return result;
            }
            
            result.debug.svgFound = true;
            
            // Method 1a: Try to find circle elements (typical Recharts data points)
            const circles = svg.querySelectorAll('circle');
            if (circles.length > 0) {
              result.debug.circlesFound = circles.length;
              
              // Extract all circle positions and attributes
              const circleData = Array.from(circles).map(circle => {
                const cx = parseFloat(circle.getAttribute('cx') || circle.getAttribute('cx'));
                const cy = parseFloat(circle.getAttribute('cy') || circle.getAttribute('cy'));
                const r = parseFloat(circle.getAttribute('r') || '0');
                
                // Try to find associated text or data attributes
                let value = null;
                
                // Check for data-* attributes
                const dataValue = circle.getAttribute('data-value') || circle.getAttribute('data-price');
                if (dataValue) {
                  value = parseFloat(dataValue);
                }
                
                return { cx, cy, r, value, element: 'circle' };
              }).filter(d => !isNaN(d.cx) && !isNaN(d.cy));
              
              if (circleData.length > 0) {
                // Sort by X position and get rightmost
                circleData.sort((a, b) => b.cx - a.cx);
                result.allDataPoints = circleData;
                result.method = 'circles';
                
                // If we have a value attribute, use it
                if (circleData[0].value !== null) {
                  result.rightmostValue = circleData[0].value;
                  result.success = true;
                }
              }
            }
            
            // Method 1b: Look for path elements with data (line charts)
            if (!result.success) {
              const paths = svg.querySelectorAll('path.recharts-line-curve, path[stroke], path.recharts-area-curve');
              result.debug.pathsFound = paths.length;
              
              if (paths.length > 0) {
                // Try to parse path d attribute to get coordinates
                const pathData = Array.from(paths).map(path => {
                  const d = path.getAttribute('d');
                  const dataValue = path.getAttribute('data-value') || path.getAttribute('data-price');
                  
                  // Extract coordinates from path (simple regex for M, L commands)
                  const coords = [];
                  if (d) {
                    // Match M or L followed by numbers
                    const matches = d.matchAll(/[ML]\s*([\d.]+)[,\s]+([\d.]+)/g);
                    for (const match of matches) {
                      coords.push({ x: parseFloat(match[1]), y: parseFloat(match[2]) });
                    }
                  }
                  
                  return { coords, dataValue: dataValue ? parseFloat(dataValue) : null };
                });
                
                // Get rightmost coordinate
                let allCoords = [];
                pathData.forEach(pd => allCoords = allCoords.concat(pd.coords));
                
                if (allCoords.length > 0) {
                  allCoords.sort((a, b) => b.x - a.x);
                  result.allDataPoints = allCoords;
                  result.method = 'path-coords';
                  // Note: We have coordinates but no direct value mapping yet
                }
              }
            }
            
            // Method 2: Look for text elements near data points (axis labels, tooltip content)
            const textElements = svg.querySelectorAll('text');
            result.debug.textElementsFound = textElements.length;
            
            if (textElements.length > 0) {
              const textData = Array.from(textElements).map(text => {
                const x = parseFloat(text.getAttribute('x') || '0');
                const y = parseFloat(text.getAttribute('y') || '0');
                const content = text.textContent.trim();
                
                // Try to parse as number
                const numValue = parseFloat(content.replace(/[^0-9.]/g, ''));
                
                return { x, y, content, numValue: isNaN(numValue) ? null : numValue };
              }).filter(d => d.content.length > 0);
              
              result.debug.textData = textData.slice(0, 10); // First 10 for debugging
              
              // Look for text elements that might be Y-axis labels (price values)
              // These typically have small X values (left side of chart)
              const yAxisLabels = textData.filter(d => 
                d.numValue !== null && 
                d.numValue > 0 && 
                d.numValue < 1 && // Assuming price is between 0 and 1
                d.x < 100 // Left side of chart
              );
              
              if (yAxisLabels.length > 0) {
                result.debug.yAxisLabels = yAxisLabels;
              }
            }
            
            // Method 3: Look for hidden data in attributes or child elements
            const allElements = svg.querySelectorAll('*');
            const dataAttributes = [];
            
            allElements.forEach(el => {
              // Check all attributes for data-* or value-like patterns
              Array.from(el.attributes).forEach(attr => {
                if (attr.name.includes('data') || attr.name.includes('value') || attr.name.includes('price')) {
                  dataAttributes.push({
                    element: el.tagName,
                    attr: attr.name,
                    value: attr.value,
                    x: el.getAttribute('x') || el.getAttribute('cx'),
                    y: el.getAttribute('y') || el.getAttribute('cy')
                  });
                }
              });
            });
            
            if (dataAttributes.length > 0) {
              result.debug.dataAttributes = dataAttributes.slice(0, 10);
            }
            
            // Method 4: Check if there's a visible tooltip or price display
            const bodyText = document.body.textContent || '';
            
            // Look for price patterns that look like decimal values (0.xxxxx format)
            const priceMatches = bodyText.match(/0\.\d{4,}/g);
            if (priceMatches && priceMatches.length > 0) {
              // Get unique values
              const uniquePrices = [...new Set(priceMatches)].map(p => parseFloat(p));
              result.debug.visiblePrices = uniquePrices;
              
              // If we found a likely price value and don't have one yet
              if (!result.success && uniquePrices.length > 0) {
                // Take the first one as a guess (might be visible in tooltip or label)
                result.rightmostValue = uniquePrices[0];
                result.method = 'text-pattern';
                result.success = true;
              }
            }
            
            // Method 5: Map rightmost coordinate to actual price value using Y-axis scale
            if (result.allDataPoints.length > 0 && result.debug.yAxisLabels && result.debug.yAxisLabels.length >= 2) {
              // We have path coordinates and Y-axis labels
              // Get the rightmost point
              const rightmostPoint = result.allDataPoints[0]; // Already sorted by X desc
              
              // Get Y-axis scale from labels (sorted by Y coordinate)
              const yAxisSorted = result.debug.yAxisLabels.sort((a, b) => b.y - a.y);
              
              // Linear interpolation between Y-axis points
              // Find the two Y-axis labels that bracket our point's Y coordinate
              let lower = null;
              let upper = null;
              
              for (let i = 0; i < yAxisSorted.length - 1; i++) {
                if (rightmostPoint.y >= yAxisSorted[i + 1].y && rightmostPoint.y <= yAxisSorted[i].y) {
                  upper = yAxisSorted[i];
                  lower = yAxisSorted[i + 1];
                  break;
                }
              }
              
              if (upper && lower) {
                // Linear interpolation: price = lower.value + (upper.value - lower.value) * (point.y - lower.y) / (upper.y - lower.y)
                const ratio = (rightmostPoint.y - lower.y) / (upper.y - lower.y);
                const interpolatedPrice = lower.numValue + (upper.numValue - lower.numValue) * ratio;
                
                result.rightmostValueMapped = interpolatedPrice;
                result.mappingDebug = {
                  rightmostY: rightmostPoint.y,
                  lowerLabel: { y: lower.y, value: lower.numValue },
                  upperLabel: { y: upper.y, value: upper.numValue },
                  ratio: ratio,
                  interpolated: interpolatedPrice
                };
                
                // Use mapped value if we have it
                if (!isNaN(interpolatedPrice) && interpolatedPrice > 0) {
                  result.rightmostValue = interpolatedPrice;
                  result.method = 'coordinate-mapping';
                  result.success = true;
                }
              }
            }
            
            return result;
          });
          console.log('  📊 Chart data extraction:', JSON.stringify(chartDataExtraction, null, 2));
          
          // Step 8: If extraction didn't work, try hovering to trigger tooltip
          if (!chartDataExtraction.success) {
            console.log('  📍 Step 8: Direct extraction failed, trying hover method...');
            
            // Use Puppeteer's mouse API for more reliable hovering
            try {
              const hoverTarget = await page.evaluate(() => {
                const svg = document.querySelector('svg');
                if (svg) {
                  const rect = svg.getBoundingClientRect();
                  return {
                    x: rect.left + rect.width - 50, // 50px from right
                    y: rect.top + rect.height / 2,
                    found: true
                  };
                }
                return { found: false };
              });
              
              if (hoverTarget.found) {
                console.log(`  🖱️  Moving mouse to (${hoverTarget.x}, ${hoverTarget.y})...`);
                await page.mouse.move(hoverTarget.x, hoverTarget.y);
                await page.waitForTimeout(1000);
                
                // Check for tooltip after hover
                const tooltipData = await page.evaluate(() => {
                  const bodyText = document.body.textContent || '';
                  
                  // Look for price patterns
                  const priceMatches = bodyText.match(/0\.\d{4,}/g);
                  if (priceMatches && priceMatches.length > 0) {
                    const uniquePrices = [...new Set(priceMatches)].map(p => parseFloat(p));
                    return { found: true, prices: uniquePrices };
                  }
                  
                  return { found: false };
                });
                
                console.log('  💰 Tooltip data after hover:', JSON.stringify(tooltipData, null, 2));
                
                if (tooltipData.found && tooltipData.prices.length > 0) {
                  chartDataExtraction.rightmostValue = tooltipData.prices[0];
                  chartDataExtraction.method = 'hover-tooltip';
                  chartDataExtraction.success = true;
                }
              }
            } catch (hoverError) {
              console.log('  ⚠️  Hover failed:', hoverError.message);
            }
          }
          
          // Take screenshot after extraction
          await page.screenshot({ path: 'after-extraction.png', fullPage: false });
          console.log('  📸 Screenshot saved: after-extraction.png');
          
          // Step 9: Brief pause for manual inspection (reduced for production)
          console.log('\n  ⏸️  PAUSING FOR 5 SECONDS - Check browser if needed');
          console.log('  👀 Screenshots saved: before-extraction.png, after-extraction.png');
          console.log(`  🎯 Extracted value: ${chartDataExtraction.rightmostValue || 'NONE'}`);
          console.log(`  📝 Method used: ${chartDataExtraction.method || 'NONE'}`);
          await page.waitForTimeout(5000);
          
        } catch (investigationError) {
          console.log('  ❌ Investigation error:', investigationError.message);
        }
        
        console.log('  🔬 Investigation complete!\n');
        // ============================================================
        
        break; // Success - exit loop
        
      } catch (error) {
        console.log(`  ⚠️  Error with ${url}: ${error.message}`);
        continue; // Try next variation
      }
    }
    
    await browser.close();
    
    if (!detailData) {
      throw new Error('All URL variations failed - page not found');
    }
    
    detailData.url = successUrl;
    return detailData;
    
  } catch (error) {
    console.error('❌ Error scraping detail page:', error.message);
    if (browser) {
      await browser.close();
    }
    throw error;
  }
}

/**
 * Test Exponent Phase 2 scraper on multiple assets
 */
async function testExponentPhase2() {
  console.log('🧪 Testing Exponent Phase 2 Detail Page Scraper\n');
  console.log('='.repeat(70));
  
  // Test assets with known assetBoost values
  const testAssets = [
    { name: 'YT-eUSX-11MAR26', expectedBoost: 15, expectedUrl: 'base' },
    // { name: 'YT-hyloSOL-10DEC25', expectedBoost: 2, expectedUrl: 'base' },
    // { name: 'YT-xSOL-26NOV25', expectedBoost: 25, expectedUrl: 'base' },
    // { name: 'YT-hyloSOL+-15DEC25', expectedBoost: 8, expectedUrl: 'base', note: 'Has 8x boost!' },
    // { name: 'YT-CRT-06JAN26', expectedBoost: null, expectedUrl: 'varies', note: 'May need versioned URL' }
  ];
  
  console.log('\n📋 Test Assets:');
  testAssets.forEach((asset, idx) => {
    const note = asset.note ? ` (${asset.note})` : '';
    const boost = asset.expectedBoost !== null ? `${asset.expectedBoost}x` : 'null';
    console.log(`  ${idx + 1}. ${asset.name} (expected: ${boost})${note}`);
  });
  
  console.log('\n' + '='.repeat(70));
  
  for (const testAsset of testAssets) {
    try {
      const result = await scrapeExponentDetailPage({
        fullAssetName: testAsset.name,
        executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        headless: false
      });
      
      console.log('\n✅ Result:');
      console.log(`  Success URL:     ${result.url}`);
      console.log(`  Text Length:     ${result.textLength} chars`);
      console.log(`  Has "expires on" text: ${result.hasExpiresText ? 'Yes' : 'No'}`);
      console.log(`  Asset Boost:     ${result.assetBoost !== null ? result.assetBoost + 'x' : 'null (not found)'}`);
      console.log(`  Boost Program:   ${result.boostProgramName || 'N/A'}`);
      console.log(`  Maturity (Raw):  ${result.maturityRaw || 'N/A'}`);
      console.log(`  Maturity (UTC):  ${result.maturity || 'N/A'}`);
      console.log(`  Points-Only:     ${result.hasPointsOnlyText ? 'Yes' : 'No'}`);
      
      // Debug: Show page text preview for first asset only
      if (testAsset === testAssets[0]) {
        console.log(`\n  🔍 DEBUG - Full page text (first 1500 chars):`);
        console.log(`  ${result.rawText.substring(0, 1500).replace(/\s+/g, ' ')}...`);
      }
      
      // Validation
      if (result.assetBoost === testAsset.expectedBoost) {
        const boostStr = testAsset.expectedBoost !== null ? `${testAsset.expectedBoost}x` : 'null';
        console.log(`  ✅ PASS: Matches expected value (${boostStr})`);
      } else {
        console.log(`  ❌ FAIL: Expected ${testAsset.expectedBoost}x, got ${result.assetBoost}x`);
      }
      
      console.log('\n' + '─'.repeat(70));
      
    } catch (error) {
      console.error(`\n❌ Error testing ${testAsset.name}:`, error.message);
      console.log('─'.repeat(70));
    }
  }
  
  console.log('\n🎉 Phase 2 testing complete!');
}

// Run test
testExponentPhase2().catch(error => {
  console.error('\n❌ Test failed:', error);
  process.exit(1);
});
