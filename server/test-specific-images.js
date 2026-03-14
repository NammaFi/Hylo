/**
 * Test script to extract and verify specific asset images (hyloSOL and xSOL)
 * Run with: node server/test-specific-images.js
 */

import puppeteerCore from 'puppeteer-core';

const puppeteer = puppeteerCore;

async function testSpecificAssetImages() {
  let browser;
  
  try {
    console.log('🚀 Testing image extraction for hyloSOL and xSOL...\n');
    
    // Use Edge on Windows
    const executablePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    
    browser = await puppeteer.launch({
      executablePath: executablePath,
      headless: false,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      ignoreHTTPSErrors: true,
    });
    
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    console.log('📡 Navigating to Exponent Finance farm page...');
    await page.goto('https://v1.exponent.finance/farm', {
      waitUntil: 'networkidle0',
      timeout: 90000
    });
    
    console.log('⏳ Waiting for data to load...');
    await page.waitForFunction(
      () => {
        const bodyText = document.body.innerText;
        const leverageMatches = bodyText.match(/Effective\s+Exposure[^\d∞]*([\d.]+)\s*x/gi) || [];
        return leverageMatches.length > 0;
      },
      { timeout: 60000, polling: 1000 }
    );
    
    console.log('✅ Page loaded!\n');
    console.log('🔍 Extracting images for hyloSOL and xSOL...\n');
    
    // Extract specific asset images
    const targetAssets = await page.evaluate(() => {
      const results = [];
      
      // Find all elements that might contain asset names
      const allElements = Array.from(document.querySelectorAll('*'));
      
      for (const element of allElements) {
        const text = element.textContent || '';
        
        // Look for hyloSOL or xSOL assets
        const assetMatch = text.match(/YT-(hyloSOL|xSOL)-(\d{2}[A-Z]{3}\d{2})/i);
        
        if (assetMatch) {
          const fullAssetName = assetMatch[0];
          const baseAsset = assetMatch[1];
          
          // Search up the DOM tree to find the card
          let current = element;
          let foundImage = null;
          
          for (let i = 0; i < 15; i++) {
            if (!current.parentElement) break;
            current = current.parentElement;
            
            const cardText = current.textContent;
            
            // Make sure this is an individual card
            const assetPatterns = cardText.match(/YT-[A-Za-z0-9*+\-]+-\d{2}[A-Z]{3}\d{2}/g);
            const isIndividualCard = assetPatterns && assetPatterns.length === 1;
            
            if (!isIndividualCard) continue;
            
            // Look for token images
            const imgs = current.querySelectorAll('img');
            
            for (const img of imgs) {
              const src = img.src;
              
              // Token images are in /images/icons/tokens/
              if (src.includes('/images/icons/tokens/')) {
                foundImage = {
                  src,
                  alt: img.alt || '',
                  width: img.width,
                  height: img.height,
                  className: img.className
                };
                break;
              }
            }
            
            if (foundImage) break;
          }
          
          if (foundImage) {
            results.push({
              asset: fullAssetName,
              baseAsset,
              image: foundImage
            });
          }
        }
      }
      
      return results;
    });
    
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 EXTRACTION RESULTS:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    if (targetAssets.length === 0) {
      console.log('❌ No images found for hyloSOL or xSOL\n');
    } else {
      targetAssets.forEach(asset => {
        console.log(`🎯 Asset: ${asset.asset}`);
        console.log(`   Base Asset: ${asset.baseAsset}`);
        console.log(`   Image URL: ${asset.image.src}`);
        console.log(`   Image Size: ${asset.image.width}x${asset.image.height}px`);
        console.log(`   Alt Text: "${asset.image.alt}"`);
        console.log(`   Class: "${asset.image.className}"`);
        
        // Extract token address
        const match = asset.image.src.match(/\/tokens\/([^/.]+)\.svg/);
        const tokenAddress = match ? match[1] : 'N/A';
        console.log(`   Token Address: ${tokenAddress}`);
        console.log('');
      });
    }
    
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🔗 HOW TO USE IN SCRAPER:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    if (targetAssets.length > 0) {
      console.log('Add this batch extraction code to scraper-exponent.js:');
      console.log('');
      console.log('const tokenImages = await page.evaluate(() => {');
      console.log('  const images = {};');
      console.log('  // Search through cards to find token images');
      console.log('  document.querySelectorAll(\'img[src*="/images/icons/tokens/"]\').forEach(img => {');
      console.log('    const card = img.closest(\'[class*="card"]\') || img.closest(\'div\');');
      console.log('    if (card) {');
      console.log('      const text = card.textContent;');
      console.log('      const match = text.match(/YT-([A-Za-z0-9*+\\-]+)-\\d{2}[A-Z]{3}\\d{2}/);');
      console.log('      if (match) {');
      console.log('        images[match[1]] = img.src;');
      console.log('      }');
      console.log('    }');
      console.log('  });');
      console.log('  return images;');
      console.log('});');
      console.log('');
      console.log('// Then in asset loop:');
      console.log('assetSymbolImage: tokenImages[baseAsset] || null,');
      console.log('');
      
      // Show what would be extracted
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('📦 EXPECTED OUTPUT IN GIST JSON:');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      
      targetAssets.forEach(asset => {
        console.log(`{`);
        console.log(`  "asset": "${asset.asset}",`);
        console.log(`  "baseAsset": "${asset.baseAsset}",`);
        console.log(`  "assetSymbolImage": "${asset.image.src}",`);
        console.log(`  // ... other fields`);
        console.log(`}`);
        console.log('');
      });
    }
    
    await browser.close();
    
    console.log('✅ Test complete!\n');
    
    return targetAssets;
    
  } catch (error) {
    console.error('❌ Error:', error);
    if (browser) {
      await browser.close();
    }
    throw error;
  }
}

// Run the test
testSpecificAssetImages()
  .then(results => {
    if (results.length > 0) {
      console.log(`✅ Successfully extracted ${results.length} image(s) for hyloSOL/xSOL`);
    } else {
      console.log('⚠️  No images found - may need to adjust extraction logic');
    }
    process.exit(0);
  })
  .catch(error => {
    console.error('Test failed:', error);
    process.exit(1);
  });
