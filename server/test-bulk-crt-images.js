/**
 * Test script to verify BulkSOL and CRT image extraction
 * Run with: node server/test-bulk-crt-images.js
 */

import puppeteerCore from 'puppeteer-core';

const puppeteer = puppeteerCore;

async function testBulkCRTImages() {
  let browser;
  
  try {
    console.log('🚀 Testing image extraction for BulkSOL and CRT...\n');
    
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
    console.log('🔍 Using the batch extraction method...\n');
    
    // Use the batch extraction method from the test output
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
    
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📦 BATCH EXTRACTION RESULTS:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    console.log(`Total assets found: ${Object.keys(tokenImages).length}\n`);
    
    // Check specifically for BulkSOL and CRT
    const targets = ['BulkSOL', 'CRT'];
    
    targets.forEach(asset => {
      if (tokenImages[asset]) {
        console.log(`✅ ${asset}:`);
        console.log(`   URL: ${tokenImages[asset]}`);
        
        // Extract token address
        const match = tokenImages[asset].match(/\/tokens\/([^/.]+)\.svg/);
        const tokenAddress = match ? match[1] : 'N/A';
        console.log(`   Token Address: ${tokenAddress}`);
        console.log('');
      } else {
        console.log(`❌ ${asset}: NOT FOUND`);
        console.log('');
      }
    });
    
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 ALL EXTRACTED IMAGES:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    Object.keys(tokenImages).sort().forEach(asset => {
      const match = tokenImages[asset].match(/\/tokens\/([^/.]+)\.svg/);
      const tokenAddress = match ? match[1] : 'N/A';
      console.log(`${asset.padEnd(15)} → ${tokenAddress}`);
    });
    
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ VERIFICATION:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    const bulkSOLFound = tokenImages['BulkSOL'] ? '✅' : '❌';
    const crtFound = tokenImages['CRT'] ? '✅' : '❌';
    
    console.log(`${bulkSOLFound} BulkSOL image extraction: ${tokenImages['BulkSOL'] ? 'SUCCESS' : 'FAILED'}`);
    console.log(`${crtFound} CRT image extraction: ${tokenImages['CRT'] ? 'SUCCESS' : 'FAILED'}`);
    
    if (tokenImages['BulkSOL'] && tokenImages['CRT']) {
      console.log('\n🎉 Both BulkSOL and CRT images extracted successfully!');
      console.log('   The batch extraction method works correctly.');
    } else {
      console.log('\n⚠️  Some images were not found. May need to adjust extraction logic.');
    }
    
    await browser.close();
    
    console.log('\n✅ Test complete!\n');
    
    return { tokenImages, success: tokenImages['BulkSOL'] && tokenImages['CRT'] };
    
  } catch (error) {
    console.error('❌ Error:', error);
    if (browser) {
      await browser.close();
    }
    throw error;
  }
}

// Run the test
testBulkCRTImages()
  .then(result => {
    if (result.success) {
      console.log('✅ All target images found!');
    } else {
      console.log('⚠️  Some target images missing.');
    }
    process.exit(0);
  })
  .catch(error => {
    console.error('Test failed:', error);
    process.exit(1);
  });
