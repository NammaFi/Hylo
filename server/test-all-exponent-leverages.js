import puppeteerCore from 'puppeteer-core';

const puppeteer = puppeteerCore;

/**
 * Test script to check all Exponent assets and their leverage values
 * This will show which assets have null leverage and why
 */
async function testAllExponentLeverages() {
  let browser;
  
  try {
    console.log('🧪 Testing All Exponent Asset Leverage Values\n');
    console.log('='.repeat(60));
    
    browser = await puppeteer.launch({
      executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      headless: false, // Show browser
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      defaultViewport: { width: 1920, height: 1080 }
    });
    
    const page = await browser.newPage();
    
    console.log('\n📡 Navigating to Exponent Finance farm page...');
    const startTime = Date.now();
    await page.goto('https://v1.exponent.finance/farm', {
      waitUntil: 'networkidle0',
      timeout: 60000
    });
    
    console.log('⏳ Waiting for page to fully load...');
    await page.waitForTimeout(5000);
    
    // Scroll to load all cards
    console.log('📜 Scrolling to load all cards...');
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => {
        window.scrollBy(0, 1500);
      });
      await page.waitForTimeout(1000);
    }
    
    // Wait for skeleton loaders
    console.log('⏳ Waiting for skeleton loaders to clear...');
    try {
      await page.waitForFunction(
        () => {
          const skeletons = document.querySelectorAll('.skeleton-gray');
          return skeletons.length === 0;
        },
        { timeout: 15000 }
      );
      console.log('✅ Skeleton loaders cleared');
    } catch (e) {
      console.warn('⚠️  Some skeleton loaders still present, proceeding...');
    }
    
    // Wait for leverage values
    console.log('⏳ Waiting for leverage values to load...');
    try {
      await page.waitForFunction(
        () => {
          const bodyText = document.body.textContent;
          const numericLeverageMatches = bodyText.match(/Effective\s+Exposure[\s\S]{0,20}[\d.]+x/gi);
          return numericLeverageMatches && numericLeverageMatches.length >= 5;
        },
        { timeout: 20000 }
      );
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`✅ Leverage values loaded (${elapsed}s from page load)`);
    } catch (e) {
      console.warn('⚠️  Timeout waiting for leverage values');
    }
    
    console.log('\n🔍 Extracting all asset cards...\n');
    
    // Extract all assets
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
          
          // Find parent card
          let current = element;
          let bestCard = null;
          let smallestLevel = 999;
          
          for (let i = 0; i < 15; i++) {
            if (!current.parentElement) break;
            current = current.parentElement;
            
            const cardText = current.textContent;
            const hasEffectiveExposure = cardText.includes('Effective Exposure');
            const hasAPY = cardText.includes('Underlying APY');
            const hasAssetName = cardText.includes(fullAssetName);
            const assetPatterns = cardText.match(/YT-[A-Za-z0-9*+\-]+-\d{2}[A-Z]{3}\d{2}/g);
            const isIndividualCard = assetPatterns && assetPatterns.length === 1;
            
            if (hasEffectiveExposure && hasAPY && hasAssetName && isIndividualCard) {
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
              leverageRaw: null,
              apy: null,
              impliedYield: null,
              cardSnippet: cardText.substring(0, 200).replace(/\s+/g, ' ')
            };
            
            // Try to extract leverage with multiple patterns (including commas)
            const leveragePatterns = [
              /Effective\s+Exposure[^\d∞]*([\d,.]+|∞)\s*x/i,
              /Effective\s+Exposure[\s\S]{0,50}?([\d,.]+|∞)\s*x/i,
              /Effective[\s\S]{0,20}Exposure[\s\S]{0,50}?([\d,.]+|∞)x/i
            ];
            
            for (const pattern of leveragePatterns) {
              const leverageMatch = cardText.match(pattern);
              if (leverageMatch) {
                const leverageStr = leverageMatch[1];
                result.leverageRaw = leverageStr;
                
                if (leverageStr === '∞') {
                  result.leverage = null;
                } else {
                  // Remove commas before parsing (e.g., "1,413.84" -> "1413.84")
                  result.leverage = parseFloat(leverageStr.replace(/,/g, ''));
                }
                break;
              }
            }
            
            // Extract APY
            const apyMatch = cardText.match(/Underlying\s+APY\s*([\d.]+)\s*%/i);
            if (apyMatch) {
              result.apy = parseFloat(apyMatch[1]);
            }
            
            // Extract Implied APY
            const impliedMatch = cardText.match(/Implied\s+APY\s*([\d.]+)\s*%/i);
            if (impliedMatch) {
              result.impliedYield = parseFloat(impliedMatch[1]);
            }
            
            results.push(result);
            processedAssets.add(fullAssetName);
          }
        }
      }
      
      return results;
    });
    
    console.log('─'.repeat(60));
    console.log(`\n📊 RESULTS: Found ${assets.length} assets\n`);
    
    // Categorize assets
    const withLeverage = assets.filter(a => a.leverage !== null);
    const withoutLeverage = assets.filter(a => a.leverage === null);
    const withInfinity = assets.filter(a => a.leverageRaw === '∞');
    const highLeverage = withLeverage.filter(a => a.leverage > 100);
    const extremeLeverage = withLeverage.filter(a => a.leverage > 1000);
    
    console.log('📈 Leverage Statistics:');
    console.log(`  ✅ With leverage: ${withLeverage.length}/${assets.length} (${(withLeverage.length / assets.length * 100).toFixed(1)}%)`);
    console.log(`  ❌ Without leverage (null): ${withoutLeverage.length}/${assets.length}`);
    console.log(`  ∞  Showing infinity: ${withInfinity.length}/${assets.length}`);
    console.log(`  🚀 High leverage (>100x): ${highLeverage.length}`);
    console.log(`  🌟 Extreme leverage (>1000x): ${extremeLeverage.length}`);
    
    if (extremeLeverage.length > 0) {
      console.log('\n🌟 Extreme Leverage Assets (>1000x):');
      extremeLeverage.forEach(asset => {
        console.log(`  • ${asset.asset}: ${asset.leverage}x (APY: ${asset.apy}%, Implied: ${asset.impliedYield}%)`);
      });
    }
    
    if (withoutLeverage.length > 0) {
      console.log('\n❌ Assets WITHOUT Leverage (null):');
      withoutLeverage.forEach(asset => {
        console.log(`  • ${asset.asset}: leverageRaw="${asset.leverageRaw}" (APY: ${asset.apy}%, Implied: ${asset.impliedYield}%)`);
        if (asset.leverageRaw === '∞') {
          console.log(`    └─ Reason: Data still loading (infinity symbol)`);
        } else {
          console.log(`    └─ Reason: Regex pattern didn't match`);
        }
      });
    }
    
    // Show all assets sorted by leverage
    console.log('\n📋 All Assets (sorted by leverage):');
    console.log('─'.repeat(60));
    const sorted = assets.filter(a => a.leverage !== null).sort((a, b) => b.leverage - a.leverage);
    sorted.forEach((asset, idx) => {
      const leverageDisplay = asset.leverage !== null ? `${asset.leverage.toFixed(2)}x` : 'null';
      const apyDisplay = asset.apy !== null ? `${asset.apy}%` : 'N/A';
      const impliedDisplay = asset.impliedYield !== null ? `${asset.impliedYield}%` : 'N/A';
      
      console.log(`${(idx + 1).toString().padStart(2)}. ${asset.asset.padEnd(25)} | Leverage: ${leverageDisplay.padEnd(10)} | APY: ${apyDisplay.padEnd(6)} | Implied: ${impliedDisplay}`);
    });
    
    // Show assets without leverage separately
    if (withoutLeverage.length > 0) {
      console.log('\n❌ Assets without leverage:');
      withoutLeverage.forEach((asset, idx) => {
        const apyDisplay = asset.apy !== null ? `${asset.apy}%` : 'N/A';
        const impliedDisplay = asset.impliedYield !== null ? `${asset.impliedYield}%` : 'N/A';
        console.log(`${(idx + 1).toString().padStart(2)}. ${asset.asset.padEnd(25)} | Leverage: null (raw: ${asset.leverageRaw}) | APY: ${apyDisplay.padEnd(6)} | Implied: ${impliedDisplay}`);
      });
    }
    
    console.log('\n─'.repeat(60));
    console.log('\n⏸️  Browser will stay open for 20 seconds for manual inspection...\n');
    
    await page.waitForTimeout(20000);
    
    await browser.close();
    console.log('✅ Test complete!');
    
    return assets;
    
  } catch (error) {
    console.error('❌ Error during test:', error);
    if (browser) {
      await browser.close();
    }
    throw error;
  }
}

// Run the test
testAllExponentLeverages();
