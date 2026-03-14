/**
 * Debug script to inspect Exponent Finance HTML content
 */

async function debugHTML() {
  try {
    const url = 'https://v1.exponent.finance/farm';
    console.log(`Fetching: ${url}`);
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    
    const html = await response.text();
    console.log(`\nHTML Length: ${html.length} bytes\n`);
    
    // Check if it's a React/Next.js app
    console.log('Checking for JavaScript frameworks...');
    console.log(`Contains React: ${html.includes('react')}`);
    console.log(`Contains Next.js: ${html.includes('next')}`);
    console.log(`Contains __NEXT_DATA__: ${html.includes('__NEXT_DATA__')}`);
    
    // Check for YT pattern
    console.log(`\nContains "YT-": ${html.includes('YT-')}`);
    console.log(`Contains "farm": ${html.includes('farm')}`);
    
    // Extract __NEXT_DATA__ if present
    if (html.includes('__NEXT_DATA__')) {
      const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
      if (nextDataMatch) {
        try {
          const nextData = JSON.parse(nextDataMatch[1]);
          console.log('\n✅ Found __NEXT_DATA__!');
          console.log('\nKeys in __NEXT_DATA__:', Object.keys(nextData));
          
          if (nextData.props) {
            console.log('\nKeys in props:', Object.keys(nextData.props));
            
            if (nextData.props.pageProps) {
              console.log('\nKeys in pageProps:', Object.keys(nextData.props.pageProps));
              console.log('\nFull pageProps structure:');
              console.log(JSON.stringify(nextData.props.pageProps, null, 2));
            }
          }
        } catch (e) {
          console.log('Error parsing __NEXT_DATA__:', e.message);
        }
      }
    }
    
    // Search for YT- patterns in the HTML (with more flexible pattern)
    console.log('\n' + '='.repeat(60));
    console.log('Searching for YT- patterns in HTML...');
    console.log('='.repeat(60));
    
    // First try strict pattern
    let ytMatches = html.match(/YT-[A-Za-z0-9+\-]+-\d{2}[A-Z]{3}\d{2}/gi);
    if (ytMatches) {
      console.log(`\n✅ Found ${ytMatches.length} YT asset matches (strict pattern)!`);
      console.log('\nUnique assets:');
      const uniqueAssets = [...new Set(ytMatches)];
      uniqueAssets.forEach(asset => console.log(`  • ${asset}`));
    } else {
      console.log('\n⚠️ No matches with strict pattern, trying flexible pattern...');
      
      // Try finding YT- followed by asset name patterns
      ytMatches = html.match(/YT-[A-Za-z0-9+]+/gi);
      if (ytMatches) {
        console.log(`\n✅ Found ${ytMatches.length} YT- occurrences!`);
        console.log('\nSample matches:');
        const uniqueAssets = [...new Set(ytMatches)];
        uniqueAssets.slice(0, 20).forEach(asset => console.log(`  • ${asset}`));
      }
      
      // Search for date patterns separately
      const dateMatches = html.match(/\d{2}[A-Z]{3}\d{2}/g);
      if (dateMatches) {
        console.log(`\n✅ Found ${dateMatches.length} date patterns!`);
        console.log('\nSample dates:');
        const uniqueDates = [...new Set(dateMatches)];
        uniqueDates.slice(0, 10).forEach(date => console.log(`  • ${date}`));
      }
      
      // Try to find complete asset names by searching context
      console.log('\n🔍 Analyzing context around YT- occurrences...');
      const ytIndices = [];
      let searchPos = 0;
      while (true) {
        const ytIndex = html.indexOf('YT-', searchPos);
        if (ytIndex === -1) break;
        ytIndices.push(ytIndex);
        searchPos = ytIndex + 1;
        if (ytIndices.length >= 5) break; // First 5 occurrences
      }
      
      ytIndices.forEach((index, i) => {
        console.log(`\nOccurrence ${i + 1} (position ${index}):`);
        const context = html.substring(index, index + 200);
        console.log(context.substring(0, 200).replace(/\s+/g, ' '));
      });
    }
    
    console.log('\n' + '='.repeat(60));
    
  } catch (error) {
    console.error('Error:', error);
  }
}

debugHTML();
