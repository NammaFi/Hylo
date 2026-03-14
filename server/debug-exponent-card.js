import puppeteerCore from 'puppeteer-core';

const puppeteer = puppeteerCore;

/**
 * Debug script to inspect the actual HTML structure of Exponent cards
 */
async function debugExponentCard() {
  let browser;
  
  try {
    console.log('🔍 Debugging Exponent card structure...\n');
    
    browser = await puppeteer.launch({
      executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      headless: false,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      defaultViewport: { width: 1920, height: 1080 }
    });
    
    const page = await browser.newPage();
    
    console.log('📡 Navigating to Exponent Finance...');
    await page.goto('https://v1.exponent.finance/farm', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    
    await page.waitForTimeout(3000);
    
    // Scroll to load all cards
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, 1500));
      await page.waitForTimeout(1000);
    }
    
    console.log('🔍 Extracting card HTML for YT-hyloSOL-10DEC25...\n');
    
    // Extract the HTML of a specific card
    const cardInfo = await page.evaluate(() => {
      const allElements = Array.from(document.querySelectorAll('*'));
      
      // Find YT-hyloSOL-10DEC25
      for (const element of allElements) {
        const text = element.textContent || '';
        
        if (text.includes('YT-hyloSOL-10DEC25')) {
          // Find parent card
          let current = element;
          
          for (let i = 0; i < 15; i++) {
            if (!current.parentElement) break;
            current = current.parentElement;
            
            const cardText = current.textContent;
            
            if (cardText.includes('Effective Exposure') && 
                cardText.includes('Underlying APY') && 
                cardText.includes('YT-hyloSOL-10DEC25')) {
              
              // Check if individual card
              const assetPatterns = cardText.match(/YT-[A-Za-z0-9*+\-]+-\d{2}[A-Z]{3}\d{2}/g);
              if (assetPatterns && assetPatterns.length === 1) {
                return {
                  html: current.innerHTML.substring(0, 5000), // First 5000 chars
                  text: cardText.substring(0, 2000), // First 2000 chars
                  outerHTML: current.outerHTML.substring(0, 5000)
                };
              }
            }
          }
        }
      }
      
      return null;
    });
    
    if (cardInfo) {
      console.log('📄 CARD TEXT CONTENT:');
      console.log('='.repeat(80));
      console.log(cardInfo.text);
      console.log('='.repeat(80));
      
      console.log('\n📝 CARD HTML (first 5000 chars):');
      console.log('='.repeat(80));
      console.log(cardInfo.html);
      console.log('='.repeat(80));
      
      // Extract specific values
      console.log('\n🔎 PATTERN MATCHING TESTS:\n');
      
      // Test Effective Exposure pattern
      const leveragePatterns = [
        /Effective\s+Exposure[^\d]*([\d.]+|∞)\s*x/i,
        /Effective\s+Exposure.*?([\d.]+|∞)\s*x/i,
        /Effective\s+Exposure.*?([\d.]+)/i,
        /([\d.]+)\s*x.*?Effective\s+Exposure/i
      ];
      
      console.log('Testing Leverage patterns:');
      leveragePatterns.forEach((pattern, idx) => {
        const match = cardInfo.text.match(pattern);
        console.log(`  Pattern ${idx + 1}: ${match ? match[1] : 'NO MATCH'}`);
      });
      
      // Test Implied APY patterns
      const impliedPatterns = [
        /Implied\s+APY[^\d]*([\d.]+)\s*%/i,
        /Implied\s+Yield[^\d]*([\d.]+)\s*%/i,
        /Implied\s+(?:APY|Yield)[^\d]*([\d.]+)\s*%/i,
        /Implied.*?([\d.]+)\s*%/i
      ];
      
      console.log('\nTesting Implied APY patterns:');
      impliedPatterns.forEach((pattern, idx) => {
        const match = cardInfo.text.match(pattern);
        console.log(`  Pattern ${idx + 1}: ${match ? match[1] : 'NO MATCH'}`);
      });
      
      // Test Points patterns
      const pointsPatterns = [
        /([\d.]+|∞)\s*pts\/Day/i,
        /([\d.]+|∞)\s*pts\s*\/\s*Day/i,
        /pts\/Day.*?([\d.]+|∞)/i
      ];
      
      console.log('\nTesting Points/Day patterns:');
      pointsPatterns.forEach((pattern, idx) => {
        const match = cardInfo.text.match(pattern);
        console.log(`  Pattern ${idx + 1}: ${match ? match[1] : 'NO MATCH'}`);
      });
      
      // List all percentage values
      console.log('\n📊 ALL PERCENTAGE VALUES FOUND:');
      const percentages = cardInfo.text.match(/[\d.]+\s*%/g);
      if (percentages) {
        percentages.forEach((pct, idx) => {
          console.log(`  ${idx + 1}. ${pct}`);
        });
      }
      
      // List all multiplier values
      console.log('\n📊 ALL MULTIPLIER VALUES FOUND:');
      const multipliers = cardInfo.text.match(/([\d.]+|∞)\s*x/gi);
      if (multipliers) {
        multipliers.forEach((mult, idx) => {
          console.log(`  ${idx + 1}. ${mult}`);
        });
      }
      
    } else {
      console.log('❌ Could not find YT-hyloSOL-10DEC25 card');
    }
    
    console.log('\n✅ Debug complete! Browser will stay open for 10 seconds...');
    await page.waitForTimeout(10000);
    
    await browser.close();
    
  } catch (error) {
    console.error('❌ Error:', error);
    if (browser) {
      await browser.close();
    }
  }
}

debugExponentCard();
