/**
 * Debug script to analyze Exponent Finance farm page structure
 * Tests data extraction for a single asset card
 */

async function analyzeCard() {
  try {
    const url = 'https://v1.exponent.finance/farm';
    console.log(`Fetching: ${url}\n`);
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    const html = await response.text();
    console.log(`HTML Length: ${html.length} bytes\n`);
    
    // Clean up HTML comments
    const cleanedHtml = html.replace(/YT-([A-Za-z0-9+]+)<!--\s*-->-<!--\s*-->(\d{2}[A-Z]{3}\d{2})/gi, 'YT-$1-$2');
    
    // Find first YT asset
    const ytPattern = /YT-([A-Za-z0-9+]+)-(\d{2}[A-Z]{3}\d{2})/i;
    const match = cleanedHtml.match(ytPattern);
    
    if (!match) {
      console.log('❌ No YT assets found!');
      return;
    }
    
    const fullAssetName = match[0];
    console.log(`🔍 Analyzing asset: ${fullAssetName}\n`);
    console.log('='.repeat(80));
    
    // Find the asset's position and extract context
    const assetIndex = cleanedHtml.indexOf(fullAssetName);
    const contextBefore = 2000; // chars before
    const contextAfter = 3000;  // chars after
    
    const start = Math.max(0, assetIndex - contextBefore);
    const end = Math.min(cleanedHtml.length, assetIndex + contextAfter);
    const context = cleanedHtml.substring(start, end);
    
    console.log('\n📄 Context around asset (2000 chars before, 3000 after):');
    console.log('='.repeat(80));
    console.log(context);
    console.log('='.repeat(80));
    
    // Try to extract data using patterns
    console.log('\n🔍 Attempting data extraction:');
    console.log('='.repeat(80));
    
    // Extract TVL
    const tvlMatches = context.match(/\$([0-9,.]+[KMB])/g);
    if (tvlMatches) {
      console.log(`\n💰 TVL Candidates: ${tvlMatches.join(', ')}`);
    }
    
    // Extract percentages (APY candidates)
    const percentMatches = context.match(/(\d+\.\d+)%/g);
    if (percentMatches) {
      console.log(`\n📊 Percentage Values: ${percentMatches.join(', ')}`);
    }
    
    // Extract multipliers (leverage/exposure candidates)
    const multiplierMatches = context.match(/([\d.]+|∞)\s*x/gi);
    if (multiplierMatches) {
      console.log(`\n📈 Multiplier Values: ${multiplierMatches.join(', ')}`);
    }
    
    // Extract points
    const pointsMatches = context.match(/([\d,.]+|∞)\s*pts/gi);
    if (pointsMatches) {
      console.log(`\n⭐ Points Values: ${pointsMatches.join(', ')}`);
    }
    
    // Look for labels
    const hasImpliedAPY = context.includes('Implied APY');
    const hasUnderlyingAPY = context.includes('Underlying') || context.includes('APY (Underlying)');
    const hasEffectiveExposure = context.includes('Effective Exposure');
    const hasPtsDay = context.includes('pts/Day');
    
    console.log(`\n🏷️ Labels Found:`);
    console.log(`   Implied APY: ${hasImpliedAPY ? '✅' : '❌'}`);
    console.log(`   Underlying APY: ${hasUnderlyingAPY ? '✅' : '❌'}`);
    console.log(`   Effective Exposure: ${hasEffectiveExposure ? '✅' : '❌'}`);
    console.log(`   pts/Day: ${hasPtsDay ? '✅' : '❌'}`);
    
    console.log('\n' + '='.repeat(80));
    
  } catch (error) {
    console.error('❌ Error:', error);
  }
}

analyzeCard();
