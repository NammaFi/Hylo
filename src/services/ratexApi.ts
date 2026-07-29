// Backend data URL - Public, no authentication needed
const GIST_RAW_URL = 'https://gist.githubusercontent.com/NammaFi/d3a1db6fc79e168cf5dff8d3a2c11706/raw/ratex-assets.json';

console.log('Fetching RateX data from backend'); // Debug log

export interface AssetData {
  asset: string;              // Full name with maturity: "xSOL-2511", "hyloSOL+-2511"
  baseAsset: string;          // Base name without suffix: "xSOL", "hyloSOL+"
  leverage: number | null;
  apy: number | null;
  maturityDays: number | null;
  assetBoost: number | null;
  ratexBoost: number | null;
  impliedYield: number | null; // Implied Yield percentage (e.g., 62.115)
  source: 'ratex' | 'exponent'; // Platform source: 'ratex' or 'exponent'
  
  // Detail page fields (scraped from liquidity detail page)
  rangeLower: number | null;   // Lower bound of range (e.g., 10 from "10% - 30%")
  rangeUpper: number | null;   // Upper bound of range (e.g., 30 from "10% - 30%")
  maturity: string | null;     // Maturity date (e.g., "2025-11-29 00:00:00 UTC")
  maturesIn: string | null;    // Time until maturity (e.g., "23d 10h")
  
  // Project and asset visual assets
  projectBackgroundImage: string | null;  // Background image URL for project (e.g., "https://static.rate-x.io/img/v1/1c9857/Hylo.svg")
  projectName: string | null;             // Project name extracted from background image (e.g., "Hylo")
  assetSymbolImage: string | null;        // Asset symbol icon URL (e.g., "https://static.rate-x.io/img/v1/361b53/xSOL.svg")
  
  // YT Price calculations (calculated in backend, stored in cache)
  ytPriceCurrent: number | null;  // YT price using impliedYield
  ytPriceLower: number | null;    // YT price using rangeLower
  ytPriceUpper: number | null;    // YT price using rangeUpper
  dailyYieldRate: number | null;  // Daily yield rate: leverage × daily APY × fee multiplier
  downsideRisk: number | null;    // Percentage downside (ytCurrent vs ytLower)
  endDayCurrentYield: number | null; // Loss % if 1 day left with current yield
  endDayLowerYield: number | null;   // Loss % if 1 day left with lower yield (worst case)
  dailyDecayRate: number | null;   // Daily value loss % due to time passing
  
  // Yield and Points calculations (calculated in backend, stored in cache)
  expectedRecoveryYield: number | null;  // Net yield % (gross × 0.995)
  expectedPointsPerDay: number | null;   // Points/day (with $1 deposit)
  totalExpectedPoints: number | null;    // Total points (with $1 deposit)
}

export interface GistResponse {
  lastUpdated: string;
  assetsCount: number;
  assets: AssetData[];
}

/**
 * Fetch all available assets from Rate-X (via backend cache)
 */
export async function fetchAllAssets(): Promise<AssetData[]> {
  try {
    // Add timestamp to bypass cache
    const response = await fetch(`${GIST_RAW_URL}?t=${Date.now()}`);
    
    if (!response.ok) {
      throw new Error(`Failed to fetch from backend: ${response.status}`);
    }
    
    const result: GistResponse = await response.json();
    
    return result.assets || [];
  } catch (error) {
    console.error('Error fetching all assets from backend:', error);
    throw error;
  }
}

/**
 * Fetch specific asset data from Rate-X (via backend cache)
 */
export async function fetchAssetData(assetName: string): Promise<AssetData> {
  try {
    // Fetch all assets and find the specific one
    const assets = await fetchAllAssets();
    const asset = assets.find(a => a.asset.toLowerCase() === assetName.toLowerCase());
    
    if (!asset) {
      throw new Error(`Asset ${assetName} not found`);
    }
    
    return asset;
  } catch (error) {
    console.error(`Error fetching asset ${assetName}:`, error);
    throw error;
  }
}

/**
 * Get last update timestamp
 */
export async function getLastUpdated(): Promise<string> {
  try {
    const response = await fetch(`${GIST_RAW_URL}?t=${Date.now()}`);
    const result: GistResponse = await response.json();
    return result.lastUpdated || 'Unknown';
  } catch (error) {
    console.error('Error getting last updated time:', error);
    return 'Unknown';
  }
}

/**
 * Force refresh - not needed with Gist approach
 * Kept for compatibility, but returns current data
 */
export async function refreshCache(): Promise<AssetData[]> {
  console.log('Note: Data is automatically updated every 5 minutes. If data is older than 10 minutes, a hard refresh (1-2 minutes) updates all metrics to ensure accuracy.');
  return fetchAllAssets();
}

/**
 * Check if backend data is available
 */
export const checkHealth = async (): Promise<boolean> => {
  try {
    const response = await fetch(`${GIST_RAW_URL}?t=${Date.now()}`);
    return response.ok;
  } catch (error) {
    console.error('Backend health check failed:', error);
    return false;
  }
}

// triggerWorkflowRefresh()/checkAndRefreshIfStale() (client-side, VITE_GITHUB_WORKFLOW_TOKEN)
// removed — Vite bundles every VITE_* var into public JS, so that token was shipped to every
// visitor's browser. The Hylo Exponent Worker (workers/) now triggers scrape-ratex.yml reliably
// every 5 minutes server-side instead, independent of whether anyone is visiting the site.
