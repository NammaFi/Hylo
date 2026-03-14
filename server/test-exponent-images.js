/**
 * Test script to explore extracting asset symbol images from Exponent Finance
 * Run with: node server/test-exponent-images.js
 */

import puppeteerCore from 'puppeteer-core';

const puppeteer = puppeteerCore;

async function testExponentImageExtraction() {
  let browser;
  
  try {
    console.log('🚀 Starting Exponent image extraction test...\n');
    
    // Use Edge on Windows
    const executablePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    
    browser = await puppeteer.launch({
      executablePath: executablePath,
      headless: false, // Run in visible mode for debugging
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
    console.log('🔍 Analyzing image structure...\n');
    
    // Extract all images and their context
    const imageData = await page.evaluate(() => {
      const results = [];
      
      // Find all images on the page
      const allImages = document.querySelectorAll('img');
      
      allImages.forEach(img => {
        const src = img.src;
        const alt = img.alt || '';
        const className = img.className || '';
        
        // Get parent text context (up to 3 levels)
        let parentText = '';
        let current = img.parentElement;
        for (let i = 0; i < 3 && current; i++) {
          const text = current.textContent || '';
          if (text.length < 500) { // Only grab short text snippets
            parentText += text + ' | ';
          }
          current = current.parentElement;
        }
        
        results.push({
          src,
          alt,
          className,
          parentText: parentText.substring(0, 300) // Limit text length
        });
      });
      
      return results;
    });
    
    console.log(`Found ${imageData.length} total images\n`);
    
    // Filter for potential asset symbol images
    console.log('🎯 Looking for asset symbol images (circular icons near asset names)...\n');
    
    const potentialAssetImages = imageData.filter(img => {
      // Look for images that might be asset symbols
      // They should be near YT- asset names in the DOM
      const hasAssetInContext = /YT-[A-Za-z0-9+\-]+/i.test(img.parentText);
      
      // Filter out common non-asset images
      const isNotUIIcon = !img.src.includes('spark') && 
                         !img.src.includes('logo') && 
                         !img.src.includes('icon/ui') &&
                         !img.src.includes('gradient');
      
      return hasAssetInContext && isNotUIIcon;
    });
    
    console.log(`Found ${potentialAssetImages.length} potential asset symbol images:\n`);
    
    potentialAssetImages.forEach((img, index) => {
      console.log(`${index + 1}. Image:`);
      console.log(`   URL: ${img.src}`);
      console.log(`   Alt: ${img.alt}`);
      console.log(`   Class: ${img.className}`);
      console.log(`   Context: ${img.parentText.substring(0, 150)}...`);
      console.log('');
    });
    
    // Try to extract asset symbols with their corresponding asset names
    console.log('🔗 Attempting to map images to specific assets...\n');
    
    const assetImageMap = await page.evaluate(() => {
      const results = [];
      
      // Find all asset name elements
      const allElements = Array.from(document.querySelectorAll('*'));
      
      for (const element of allElements) {
        const text = element.textContent || '';
        const assetMatch = text.match(/YT-([A-Za-z0-9*+\-]+)-(\d{2}[A-Z]{3}\d{2})/);
        
        if (assetMatch) {
          const fullAssetName = assetMatch[0];
          const baseAsset = assetMatch[1];
          
          // Look for nearby images (within same card)
          let current = element;
          let foundImage = null;
          
          // Search up the DOM tree
          for (let i = 0; i < 10 && current; i++) {
            // Look for img tags in this level
            const imgs = current.querySelectorAll('img');
            
            for (const img of imgs) {
              const src = img.src;
              
              // Skip UI icons
              if (src.includes('spark') || src.includes('gradient') || 
                  src.includes('logo_white') || src.includes('icon/ui')) {
                continue;
              }
              
              // Check if this might be an asset symbol
              // Asset symbols are typically small circular images
              const width = img.width;
              const height = img.height;
              const isSmallSquare = width > 0 && width < 100 && height > 0 && height < 100;
              
              if (isSmallSquare) {
                foundImage = {
                  src,
                  alt: img.alt || '',
                  width,
                  height
                };
                break;
              }
            }
            
            if (foundImage) break;
            current = current.parentElement;
          }
          
          results.push({
            asset: fullAssetName,
            baseAsset,
            image: foundImage
          });
        }
      }
      
      return results;
    });
    
    console.log(`Found ${assetImageMap.length} assets with potential image mappings:\n`);
    
    // Group by whether they have images
    const withImages = assetImageMap.filter(a => a.image);
    const withoutImages = assetImageMap.filter(a => !a.image);
    
    console.log(`✅ ${withImages.length} assets WITH images:`);
    withImages.slice(0, 5).forEach(a => {
      console.log(`   ${a.asset} (${a.baseAsset})`);
      console.log(`   → ${a.image.src}`);
      console.log(`   → ${a.image.width}x${a.image.height}px`);
      console.log('');
    });
    
    if (withImages.length > 5) {
      console.log(`   ... and ${withImages.length - 5} more\n`);
    }
    
    console.log(`❌ ${withoutImages.length} assets WITHOUT images:`);
    withoutImages.slice(0, 5).forEach(a => {
      console.log(`   ${a.asset} (${a.baseAsset})`);
    });
    
    if (withoutImages.length > 5) {
      console.log(`   ... and ${withoutImages.length - 5} more`);
    }
    
    console.log('\n');
    
    // Analyze URL patterns
    if (withImages.length > 0) {
      console.log('📊 Image URL patterns:');
      const uniqueDomains = [...new Set(withImages.map(a => {
        try {
          const url = new URL(a.image.src);
          return url.hostname;
        } catch {
          return 'invalid-url';
        }
      }))];
      
      console.log(`   Domains: ${uniqueDomains.join(', ')}`);
      
      // Check if URLs contain base asset names
      const urlsWithAssetName = withImages.filter(a => 
        a.image.src.toLowerCase().includes(a.baseAsset.toLowerCase())
      );
      console.log(`   ${urlsWithAssetName.length}/${withImages.length} URLs contain the base asset name`);
      
      if (urlsWithAssetName.length > 0) {
        console.log('\n   Examples:');
        urlsWithAssetName.slice(0, 3).forEach(a => {
          console.log(`   ${a.baseAsset} → ${a.image.src}`);
        });
      }
    }
    
    await browser.close();
    
    console.log('\n✅ Test complete!\n');
    
    return { imageData, assetImageMap };
    
  } catch (error) {
    console.error('❌ Error:', error);
    if (browser) {
      await browser.close();
    }
    throw error;
  }
}

// Run the test
testExponentImageExtraction()
  .then(() => process.exit(0))
  .catch(error => {
    console.error('Test failed:', error);
    process.exit(1);
  });
