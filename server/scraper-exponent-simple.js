/**
 * Simple Exponent Finance scraper using fetch (no Puppeteer needed)
 * Extracts YT assets from pre-loaded HTML
 */

/**
 * Scrapes YT assets from Exponent Finance farm page using simple fetch
 * @returns {Promise<Array>} Array of YT asset data
 */
export async function scrapeExponentAssets() {
  try {
    console.log('🚀 Starting Exponent Finance scraper (simple mode)...');
    
    const url = 'https://v1.exponent.finance/farm';
    console.log(`Fetching: ${url}`);
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const html = await response.text();
    console.log(`✅ Fetched ${html.length} bytes of HTML`);
    
    // Extract YT assets using regex patterns
    const assets = [];
    const processedAssets = new Set();
    
    // The HTML has patterns like: YT-eUSX<!-- -->-<!-- -->11MAR26
    // We need to handle both direct patterns and HTML-comment-separated patterns
    
    // First, clean up HTML comments between YT asset names and dates
    const cleanedHtml = html.replace(/YT-([A-Za-z0-9+]+)<!--\s*-->-<!--\s*-->(\d{2}[A-Z]{3}\d{2})/gi, 'YT-$1-$2');
    
    // Pattern: YT-{assetName}-{ddMMMyy}
    // Examples: YT-eUSX-11MAR26, YT-hyloSOL-10DEC25, YT-xSOL-26NOV25
    const ytPattern = /YT-([A-Za-z0-9+]+)-(\d{2}[A-Z]{3}\d{2})/gi;
    const matches = cleanedHtml.matchAll(ytPattern);
    
    for (const match of matches) {
      const fullAssetName = match[0]; // e.g., "YT-xSOL-26NOV25"
      const baseAsset = match[1]; // e.g., "xSOL"
      const dateStr = match[2]; // e.g., "26NOV25"
      
      // Skip duplicates
      if (processedAssets.has(fullAssetName)) continue;
      processedAssets.add(fullAssetName);
      
      // Try to extract additional data from surrounding context
      let tvl = null;
      let apy = null;
      let impliedApy = null;
      
      // Find the context around this asset name (500 chars before and after)
      const matchIndex = html.indexOf(fullAssetName);
      if (matchIndex !== -1) {
        const contextStart = Math.max(0, matchIndex - 500);
        const contextEnd = Math.min(html.length, matchIndex + 500);
        const context = html.substring(contextStart, contextEnd);
        
        // Look for TVL pattern: $XX.XXM or $XX.XXK
        const tvlMatch = context.match(/\$([0-9,.]+[KMB])/);
        if (tvlMatch) {
          tvl = tvlMatch[1];
        }
        
        // Look for APY patterns: XX.XX%
        const apyMatches = context.match(/(\d+\.\d+)%/g);
        if (apyMatches && apyMatches.length >= 1) {
          // First percentage is usually the Implied APY
          impliedApy = parseFloat(apyMatches[0].replace('%', ''));
          
          // Second percentage (if exists) is usually the Underlying APY
          if (apyMatches.length >= 2) {
            apy = parseFloat(apyMatches[1].replace('%', ''));
          }
        }
      }
      
      assets.push({
        fullAssetName: fullAssetName,
        baseAsset: baseAsset,
        maturityDate: dateStr,
        tvl: tvl,
        impliedApy: impliedApy,
        underlyingApy: apy
      });
    }
    
    console.log(`✅ Successfully extracted ${assets.length} YT assets from Exponent Finance!`);
    
    // Log summary
    if (assets.length > 0) {
      console.log('\n📊 Assets found:');
      assets.forEach(asset => {
        console.log(`  • ${asset.fullAssetName} (Base: ${asset.baseAsset}, TVL: ${asset.tvl || 'N/A'}, Implied APY: ${asset.impliedApy || 'N/A'}%)`);
      });
    }
    
    return assets;
    
  } catch (error) {
    console.error('❌ Error scraping Exponent Finance assets:', error);
    throw error;
  }
}

/**
 * Scrape detailed data for a specific YT asset
 * @param {string} assetName - Full YT asset name (e.g., "YT-xSOL-26NOV25")
 * @returns {Promise<Object>} Detailed asset data
 */
export async function scrapeExponentAssetDetail(assetName) {
  try {
    console.log(`🔍 Fetching detailed data for ${assetName}...`);
    
    // Extract base asset name from full name (e.g., "xSOL" from "YT-xSOL-26NOV25")
    const baseAssetMatch = assetName.match(/YT-([A-Za-z0-9+\-]+)-/);
    if (!baseAssetMatch) {
      throw new Error(`Invalid asset name format: ${assetName}`);
    }
    const baseAsset = baseAssetMatch[1].toLowerCase();
    const dateMatch = assetName.match(/-(\d{2}[A-Z]{3}\d{2})$/i);
    const dateStr = dateMatch ? dateMatch[1].toLowerCase() : '';
    
    // Construct detail page URL
    const url = `https://v1.exponent.finance/farm/${baseAsset}-${dateStr}`;
    console.log(`Fetching: ${url}`);
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const html = await response.text();
    
    const result = {
      impliedApy: null,
      underlyingApy: null,
      tvl: null,
      leverage: null,
      maturityDate: null,
      daysToMaturity: null,
      pointsMultiplier: null
    };
    
    // Extract Implied APY
    const impliedApyMatch = html.match(/Implied APY[^\d]*([\d.]+)%/i);
    if (impliedApyMatch) {
      result.impliedApy = parseFloat(impliedApyMatch[1]);
    }
    
    // Extract Underlying APY
    const underlyingApyMatch = html.match(/APY\s*\(Underlying\)[^\d]*([\d.]+)%/i);
    if (underlyingApyMatch) {
      result.underlyingApy = parseFloat(underlyingApyMatch[1]);
    }
    
    // Extract TVL
    const tvlMatch = html.match(/\$([0-9,.]+[KMB])/);
    if (tvlMatch) {
      result.tvl = tvlMatch[1];
    }
    
    // Extract Leverage (Effective Exposure)
    const leverageMatch = html.match(/Effective Exposure[^\d]*([\d.]+)x/i);
    if (leverageMatch) {
      result.leverage = parseFloat(leverageMatch[1]);
    } else {
      // Try alternative pattern for infinity symbol
      const leverageInfMatch = html.match(/Effective Exposure[^\d]*∞/i);
      if (leverageInfMatch) {
        result.leverage = 'Infinity';
      }
    }
    
    // Extract Points Multiplier
    const pointsMatch = html.match(/([\d.]+|∞)\s*pts\/Day/i);
    if (pointsMatch) {
      result.pointsMultiplier = pointsMatch[1] === '∞' ? 'Infinity' : parseFloat(pointsMatch[1]);
    }
    
    // Extract Days to Maturity (if shown on detail page)
    const daysMatch = html.match(/(\d+)\s*days?\s*(to|until)\s*maturity/i);
    if (daysMatch) {
      result.daysToMaturity = parseInt(daysMatch[1]);
    }
    
    console.log(`✅ Fetched details for ${assetName}`);
    
    return result;
    
  } catch (error) {
    console.error(`❌ Error fetching details for ${assetName}:`, error);
    throw error;
  }
}
