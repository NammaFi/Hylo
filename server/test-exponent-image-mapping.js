/**
 * Test script to correctly map asset symbol images from Exponent Finance
 * Run with: node server/test-exponent-image-mapping.js
 */

import puppeteerCore from 'puppeteer-core';

const puppeteer = puppeteerCore;

async function testExponentImageMapping() {
  let browser;
  
  try {
    console.log('🚀 Starting Exponent image mapping test...\n');
    
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
    console.log('🔍 Extracting asset images with improved logic...\n');
    
    // Extract assets with their token images
    const assetImageMap = await page.evaluate(() => {
      const results = [];
      const processedAssets = new Set();
      
      // Strategy 1: Look for asset cards (the featured cards at top)
      const allElements = Array.from(document.querySelectorAll('*'));
      
      for (const element of allElements) {
        const text = element.textContent || '';
        
        // Match YT-{asset}-{date} pattern
        const assetMatch = text.match(/YT-([A-Za-z0-9*+\-]+)-(\d{2}[A-Z]{3}\d{2})/);
        
        if (assetMatch) {
          const fullAssetName = assetMatch[0];
          const baseAsset = assetMatch[1];
          
          if (processedAssets.has(fullAssetName)) continue;
          
          // Search for the token image near this asset name
          let current = element;
          let foundImage = null;
          
          // Go up the DOM tree to find the card container
          for (let i = 0; i < 15; i++) {
            if (!current.parentElement) break;
            current = current.parentElement;
            
            const cardText = current.textContent;
            
            // Make sure this is the right card (contains this specific asset name)
            const assetPatterns = cardText.match(/YT-[A-Za-z0-9*+\-]+-\d{2}[A-Z]{3}\d{2}/g);
            const isIndividualCard = assetPatterns && assetPatterns.length === 1;
            
            if (!isIndividualCard) continue;
            
            // Look for token images (in /images/icons/tokens/)
            const imgs = current.querySelectorAll('img');
            
            for (const img of imgs) {
              const src = img.src;
              
              // Token images are in /images/icons/tokens/ directory
              if (src.includes('/images/icons/tokens/')) {
                foundImage = {
                  src,
                  alt: img.alt || '',
                  width: img.width,
                  height: img.height
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
            processedAssets.add(fullAssetName);
          }
        }
      }
      
      return results;
    });
    
    console.log(`✅ Found ${assetImageMap.length} assets with token images:\n`);
    
    // Display results
    assetImageMap.forEach((item, index) => {
      console.log(`${index + 1}. ${item.asset} (${item.baseAsset})`);
      console.log(`   Image: ${item.image.src}`);
      console.log(`   Size: ${item.image.width}x${item.image.height}px`);
      console.log('');
    });
    
    // Analyze patterns
    console.log('📊 Analysis:');
    console.log(`   Total assets with images: ${assetImageMap.length}`);
    
    // Check if we can extract token addresses from URLs
    const tokenAddresses = assetImageMap.map(item => {
      const match = item.image.src.match(/\/tokens\/([^/.]+)\.svg/);
      return match ? match[1] : null;
    }).filter(Boolean);
    
    console.log(`   Token addresses extracted: ${tokenAddresses.length}`);
    
    if (tokenAddresses.length > 0) {
      console.log('\n📋 Sample token address mappings:');
      assetImageMap.slice(0, 10).forEach(item => {
        const match = item.image.src.match(/\/tokens\/([^/.]+)\.svg/);
        const tokenAddress = match ? match[1] : 'N/A';
        console.log(`   ${item.baseAsset} → ${tokenAddress}`);
      });
    }
    
    // Test: Can we build a static mapping?
    console.log('\n🔧 Generating static mapping for scraper...\n');
    console.log('const EXPONENT_TOKEN_IMAGES = {');
    assetImageMap.forEach(item => {
      const match = item.image.src.match(/\/tokens\/([^/.]+)\.svg/);
      const tokenAddress = match ? match[1] : null;
      if (tokenAddress) {
        console.log(`  '${item.baseAsset}': 'https://v1.exponent.finance/images/icons/tokens/${tokenAddress}.svg',`);
      }
    });
    console.log('};');
    
    await browser.close();
    
    console.log('\n✅ Test complete!\n');
    
    return assetImageMap;
    
  } catch (error) {
    console.error('❌ Error:', error);
    if (browser) {
      await browser.close();
    }
    throw error;
  }
}

// Run the test
testExponentImageMapping()
  .then(() => process.exit(0))
  .catch(error => {
    console.error('Test failed:', error);
    process.exit(1);
  });
