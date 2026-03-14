import puppeteerCore from 'puppeteer-core';

const puppeteer = puppeteerCore;

/**
 * Test script to diagnose why YT-hyloSOL-10DEC25 leverage is null
 * This will extract the exact card text and show what the scraper sees
 */
async function testHyloSOLSpecific() {
  let browser;
  
  try {
    console.log('🧪 Testing YT-hyloSOL-10DEC25 Leverage Extraction\n');
    console.log('='.repeat(60));
    
    browser = await puppeteer.launch({
      executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      headless: false, // Show browser to see what's happening
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      defaultViewport: { width: 1920, height: 1080 }
    });
    
    const page = await browser.newPage();
    
    console.log('\n📡 Navigating to Exponent Finance farm page...');
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
    
    // Wait for skeleton loaders to disappear
    console.log('⏳ Waiting for skeleton loaders...');
    try {
      await page.waitForFunction(
        () => {
          const skeletons = document.querySelectorAll('.skeleton-gray');
          return skeletons.length === 0;
        },
        { timeout: 10000 }
      );
      console.log('✅ Skeleton loaders cleared');
    } catch (e) {
      console.warn('⚠️  Skeleton loaders still present');
    }
    
    // Wait for leverage values
    console.log('⏳ Waiting for leverage values...');
    try {
      await page.waitForFunction(
        () => {
          const bodyText = document.body.textContent;
          const numericLeverageMatches = bodyText.match(/Effective\s+Exposure[\s\S]{0,20}[\d.]+x/gi);
          return numericLeverageMatches && numericLeverageMatches.length >= 5;
        },
        { timeout: 20000 }
      );
      console.log('✅ Leverage values loaded');
    } catch (e) {
      console.warn('⚠️  Leverage values may not be fully loaded');
    }
    
    console.log('\n🔍 Searching for YT-hyloSOL-10DEC25 card...\n');
    
    // Extract specific card data
    const cardData = await page.evaluate(() => {
      const targetAsset = 'YT-hyloSOL-10DEC25';
      const results = {
        found: false,
        cardText: null,
        leverageMatch: null,
        leverageValue: null,
        apyMatch: null,
        apyValue: null,
        impliedMatch: null,
        impliedValue: null,
        allLeverageInPage: [],
        cardSnippet: null
      };
      
      // Find all elements
      const allElements = Array.from(document.querySelectorAll('*'));
      
      for (const element of allElements) {
        const text = element.textContent || '';
        
        if (text.includes(targetAsset)) {
          results.found = true;
          
          // Find parent card
          let current = element;
          let bestCard = null;
          
          for (let i = 0; i < 15; i++) {
            if (!current.parentElement) break;
            current = current.parentElement;
            
            const cardText = current.textContent;
            const hasEffectiveExposure = cardText.includes('Effective Exposure');
            const hasAPY = cardText.includes('Underlying APY');
            const hasAssetName = cardText.includes(targetAsset);
            
            const assetPatterns = cardText.match(/YT-[A-Za-z0-9*+\-]+-\d{2}[A-Z]{3}\d{2}/g);
            const isIndividualCard = assetPatterns && assetPatterns.length === 1;
            
            if (hasEffectiveExposure && hasAPY && hasAssetName && isIndividualCard) {
              bestCard = current;
              break;
            }
          }
          
          if (bestCard) {
            const cardText = bestCard.textContent;
            results.cardText = cardText;
            
            // Get a readable snippet (first 500 chars)
            results.cardSnippet = cardText.substring(0, 500).replace(/\s+/g, ' ');
            
            // Try different leverage patterns (including commas)
            const patterns = [
              /Effective\s+Exposure[^\d∞]*([\d,.]+|∞)\s*x/i,
              /Effective\s+Exposure[\s\S]{0,50}?([\d,.]+|∞)\s*x/i,
              /Effective[\s\S]{0,20}Exposure[\s\S]{0,50}?([\d,.]+|∞)x/i,
              /([\d,.]+|∞)\s*x[\s\S]{0,20}Effective\s+Exposure/i
            ];
            
            patterns.forEach((pattern, idx) => {
              const match = cardText.match(pattern);
              if (match) {
                if (!results.leverageMatch) {
                  results.leverageMatch = match[0];
                  results.leverageValue = match[1];
                  results.patternIndex = idx;
                }
              }
            });
            
            // Extract APY
            const apyMatch = cardText.match(/Underlying\s+APY\s*([\d.]+)\s*%/i);
            if (apyMatch) {
              results.apyMatch = apyMatch[0];
              results.apyValue = parseFloat(apyMatch[1]);
            }
            
            // Extract Implied APY
            const impliedMatch = cardText.match(/Implied\s+APY\s*([\d.]+)\s*%/i);
            if (impliedMatch) {
              results.impliedMatch = impliedMatch[0];
              results.impliedValue = parseFloat(impliedMatch[1]);
            }
          }
          
          break;
        }
      }
      
      // Get all leverage values in the page for comparison
      const bodyText = document.body.innerText;
      const allMatches = bodyText.matchAll(/Effective\s+Exposure[\s\S]{0,50}?([\d,.]+|∞)\s*x/gi);
      for (const match of allMatches) {
        results.allLeverageInPage.push(match[1]);
      }
      
      return results;
    });
    
    console.log('─'.repeat(60));
    console.log('\n📊 RESULTS:\n');
    
    if (cardData.found) {
      console.log('✅ Card found!\n');
      
      console.log('Card Snippet (first 500 chars):');
      console.log('─'.repeat(60));
      console.log(cardData.cardSnippet);
      console.log('─'.repeat(60));
      
      console.log('\n📈 Leverage Extraction:');
      if (cardData.leverageMatch) {
        console.log(`  ✅ Match found: "${cardData.leverageMatch}"`);
        console.log(`  ✅ Value extracted: ${cardData.leverageValue}`);
        console.log(`  ✅ Pattern index: ${cardData.patternIndex}`);
        
        if (cardData.leverageValue === '∞') {
          console.log('  ⚠️  WARNING: Leverage showing as ∞ (data not loaded)');
        } else {
          // Remove commas before parsing (e.g., "1,413.84" -> "1413.84")
          const numericValue = parseFloat(cardData.leverageValue.replace(/,/g, ''));
          console.log(`  ✅ Numeric value: ${numericValue}x`);
          if (numericValue > 1000) {
            console.log(`  🚀 HIGH LEVERAGE: ${numericValue}x (expected ~1413.84x)`);
          }
        }
      } else {
        console.log('  ❌ No leverage match found!');
        console.log('  🔍 This is why it\'s showing as null in the gist');
      }
      
      console.log('\n📊 APY Extraction:');
      if (cardData.apyMatch) {
        console.log(`  ✅ Match: "${cardData.apyMatch}"`);
        console.log(`  ✅ Value: ${cardData.apyValue}%`);
      } else {
        console.log('  ❌ No APY match found');
      }
      
      console.log('\n📊 Implied APY Extraction:');
      if (cardData.impliedMatch) {
        console.log(`  ✅ Match: "${cardData.impliedMatch}"`);
        console.log(`  ✅ Value: ${cardData.impliedValue}%`);
      } else {
        console.log('  ❌ No Implied APY match found');
      }
      
      console.log('\n📋 All Leverage Values on Page:');
      console.log(`  Found ${cardData.allLeverageInPage.length} leverage values`);
      const numericLeverages = cardData.allLeverageInPage.filter(v => v !== '∞');
      const infinityCount = cardData.allLeverageInPage.filter(v => v === '∞').length;
      console.log(`  Numeric: ${numericLeverages.length}, Infinity: ${infinityCount}`);
      
      if (numericLeverages.length > 0) {
        console.log(`  Sample values: ${numericLeverages.slice(0, 5).join(', ')}${numericLeverages.length > 5 ? '...' : ''}`);
      }
      
    } else {
      console.log('❌ Card NOT found on page!');
      console.log('   This asset may have expired or been removed.');
    }
    
    console.log('\n─'.repeat(60));
    console.log('\n⏸️  Browser will stay open for 30 seconds for manual inspection...');
    console.log('   Check the page to see if YT-hyloSOL-10DEC25 is visible.\n');
    
    await page.waitForTimeout(30000);
    
    await browser.close();
    console.log('✅ Test complete!');
    
  } catch (error) {
    console.error('❌ Error during test:', error);
    if (browser) {
      await browser.close();
    }
    throw error;
  }
}

// Run the test
testHyloSOLSpecific();
