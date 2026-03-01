/**
 * API service for xSOL Break-Even Calculator
 * 
 * Data source: GitHub Gist (xsolMetrics field)
 * Updated every 5 minutes via GitHub Actions scraper
 */

const GIST_RAW_URL = 'https://gist.githubusercontent.com/NammaFi/d3a1db6fc79e168cf5dff8d3a2c11706/raw/ratex-assets.json';

export interface XSolMetrics {
  HYusd_supply: number;
  xSOL_price: number;
  xSOL_supply: number;
  CollateralRatio: number;
  SOL_price: number;
  StabilityMode: object;
  xSOL_sp: number;
  Collateral_TVL: number;
  Collateral_TVL_SOL: number;
  Effective_Leverage: number;
  xSOL_icon_url: string | null;
  lastFetched: string;
  source: string;
}

export interface Asset {
  baseAsset?: string;
  assetSymbolImage?: string;
  [key: string]: unknown;
}

export interface GistDataWithXSol {
  lastUpdated: string;
  phase: number;
  phaseStatus?: string;
  assetsCount: number;
  assets: Asset[];
  xsolMetrics?: XSolMetrics;
}

export interface BreakEvenData {
  metrics: XSolMetrics | null;
  isLoading: boolean;
  error: string | null;
  xsolIconUrl: string | null;
}

/**
 * Fetch xSOL metrics from Vercel API endpoint (with Gist fallback)
 * Primary: /api/xsol-metrics (Hylo API via serverless function)
 * Fallback: GitHub Gist
 */
export async function fetchXSolMetrics(): Promise<BreakEvenData> {
  try {
    console.log('🔍 Fetching xSOL metrics from /api/xsol-metrics...');
    
    const response = await fetch('/api/xsol-metrics', {
      cache: 'no-cache',
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const metrics: XSolMetrics = await response.json();
    console.log('✅ xSOL metrics from API:', metrics);
    
    // Get xSOL icon from Gist (API doesn't return it)
    const gistData = await fetchGistForIcon();
    
    return {
      metrics,
      isLoading: false,
      error: null,
      xsolIconUrl: gistData.xsolIconUrl,
    };
  } catch (error) {
    console.warn('⚠️ API failed, falling back to Gist:', error);
    return fetchXSolMetricsFromGist();
  }
}

/**
 * Fetch just the xSOL icon URL from Gist
 */
async function fetchGistForIcon(): Promise<{ xsolIconUrl: string | null }> {
  try {
    const response = await fetch(GIST_RAW_URL, { cache: 'no-cache' });
    const gistData: GistDataWithXSol = await response.json();
    const xsolAsset = gistData.assets.find(a => a.baseAsset === 'xSOL');
    return { xsolIconUrl: xsolAsset?.assetSymbolImage || null };
  } catch {
    return { xsolIconUrl: null };
  }
}

/**
 * Fetch xSOL metrics from GitHub Gist (fallback)
 */
export async function fetchXSolMetricsFromGist(): Promise<BreakEvenData> {
  try {
    console.log('🔍 Fetching xSOL metrics from GitHub Gist...');
    
    const response = await fetch(GIST_RAW_URL, {
      cache: 'no-cache',
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const gistData: GistDataWithXSol = await response.json();
    console.log('✅ Gist data loaded. Last updated:', gistData.lastUpdated);
    
    // Find xSOL icon from any asset with baseAsset === 'xSOL'
    const xsolAsset = gistData.assets.find(a => a.baseAsset === 'xSOL');
    const xsolIconUrl = xsolAsset?.assetSymbolImage || null;
    console.log('🖼️ xSOL icon URL:', xsolIconUrl || 'Not found, will use fallback');
    
    if (!gistData.xsolMetrics) {
      console.warn('⚠️ xsolMetrics not found in Gist - Phase 0 may not have run yet');
      return {
        metrics: null,
        isLoading: false,
        error: 'xSOL metrics not available. Please try again later.',
        xsolIconUrl,
      };
    }

    console.log('✅ xSOL metrics extracted:', gistData.xsolMetrics);
    
    return {
      metrics: gistData.xsolMetrics,
      isLoading: false,
      error: null,
      xsolIconUrl,
    };
  } catch (error) {
    console.error('❌ Failed to fetch xSOL metrics:', error);
    return {
      metrics: null,
      isLoading: false,
      error: error instanceof Error ? error.message : 'Failed to load xSOL metrics',
      xsolIconUrl: null,
    };
  }
}

/**
 * Calculate xSOL break-even price
 * 
 * Formula: xSOL_be_p = ((xSOL_buy_p × xSOL_supply) + HYusd_supply) / Collateral_TVL_SOL
 * 
 * @param xSOL_buy_p - User's xSOL purchase price (in USD)
 * @param metrics - xSOL metrics from Gist
 * @returns Break-even price in USD
 */
export function calculateXSolBreakEvenPrice(
  xSOL_buy_p: number,
  metrics: XSolMetrics
): number {
  const { xSOL_supply, HYusd_supply, Collateral_TVL_SOL } = metrics;
  
  if (Collateral_TVL_SOL === 0) return 0;
  
  const xSOL_be_p = ((xSOL_buy_p * xSOL_supply) + HYusd_supply) / Collateral_TVL_SOL;
  
  return xSOL_be_p;
}

/**
 * Break-even result with Stability Pool awareness
 */
export interface BreakEvenResult {
  /** SOL price at which user breaks even (SP-adjusted) */
  breakEvenPrice: number;
  /** Which phase the break-even falls in */
  phase: 'phase-0' | 'phase-A' | 'phase-B' | 'normal' | 'error';
  /** SOL price where stability pool fully exhausts (P*) */
  poolExhaustionSolPrice: number | null;
  /** xSOL price at pool exhaustion */
  poolExhaustionXSolPrice: number | null;
  /** SOL price where CR reaches 150% and pool activates */
  activationSolPrice: number | null;
  /** Break-even without SP adjustment (naive) */
  naiveBreakEvenPrice: number;
  /** Improvement: how much lower the SP break-even is vs naive */
  improvement: number;
}

/**
 * Calculate xSOL break-even price WITH Stability Pool awareness.
 *
 * Three phases as SOL price rises:
 *   Phase 0: CR < 150%, normal — xSOL price = (P*C - n_h) / n_x
 *   Phase A: CR pinned at 150%, pool converting — same xSOL price formula, leverage = 3×
 *   Phase B: Pool exhausted — xSOL price = (P*C - n_h*) / n_x* (steeper slope)
 *
 * Key insight: xSOL price formula is identical in Phase 0 & A. The adjustment
 * only matters when break-even falls in Phase B (after pool exhaustion), where
 * fewer xSOL tokens and more HYusd change the slope, giving a LOWER break-even.
 *
 * @param xSOL_buy_p  User's xSOL purchase price in USD
 * @param metrics     Current protocol metrics
 * @returns           BreakEvenResult with adjusted price and phase info
 */
export function calculateXSolBreakEvenPriceWithSP(
  xSOL_buy_p: number,
  metrics: XSolMetrics
): BreakEvenResult {
  const { xSOL_supply, HYusd_supply, SOL_price, Collateral_TVL } = metrics;
  const xSOL_sp = metrics.xSOL_sp ?? 0;

  // C = total SOL collateral (constant regardless of SOL price)
  const C = SOL_price > 0 ? Collateral_TVL / SOL_price : 0;

  if (C === 0 || xSOL_supply === 0) {
    return {
      breakEvenPrice: 0,
      phase: 'error',
      poolExhaustionSolPrice: null,
      poolExhaustionXSolPrice: null,
      activationSolPrice: null,
      naiveBreakEvenPrice: 0,
      improvement: 0,
    };
  }

  // Naive break-even (Phase 0 / Phase A — same formula)
  const P_be_naive = (xSOL_buy_p * xSOL_supply + HYusd_supply) / C;

  // If no stability pool xSOL, return naive
  if (xSOL_sp <= 0) {
    return {
      breakEvenPrice: P_be_naive,
      phase: 'normal',
      poolExhaustionSolPrice: null,
      poolExhaustionXSolPrice: null,
      activationSolPrice: null,
      naiveBreakEvenPrice: P_be_naive,
      improvement: 0,
    };
  }

  // SOL price where CR reaches 150% (stability pool activates)
  const P_activate = (1.5 * HYusd_supply) / C;

  // SOL price where stability pool fully exhausts
  // P* = n_h * (n_x - x_sp) / (C * (2*n_x/3 - x_sp))
  const denominator = (2 * xSOL_supply / 3) - xSOL_sp;

  // Edge case: pool >= 66.7% of supply — pool can never exhaust, Phase A forever
  if (denominator <= 0) {
    return {
      breakEvenPrice: P_be_naive,
      phase: P_be_naive <= P_activate ? 'phase-0' : 'phase-A',
      poolExhaustionSolPrice: null,
      poolExhaustionXSolPrice: null,
      activationSolPrice: P_activate,
      naiveBreakEvenPrice: P_be_naive,
      improvement: 0,
    };
  }

  const P_star = (HYusd_supply * (xSOL_supply - xSOL_sp)) / (C * denominator);

  // xSOL price at pool exhaustion (using Phase 0/A formula)
  const xSOL_price_at_P_star = (P_star * C - HYusd_supply) / xSOL_supply;

  // If naive break-even is at or before pool exhaustion, no SP adjustment needed
  // (xSOL price formula is identical in Phase 0 and Phase A)
  if (P_be_naive <= P_star) {
    const phase = P_be_naive <= P_activate ? 'phase-0' : 'phase-A';
    return {
      breakEvenPrice: P_be_naive,
      phase,
      poolExhaustionSolPrice: P_star,
      poolExhaustionXSolPrice: xSOL_price_at_P_star,
      activationSolPrice: P_activate,
      naiveBreakEvenPrice: P_be_naive,
      improvement: 0,
    };
  }

  // Break-even is AFTER pool exhaustion — Phase B formula applies
  // Post-exhaustion state:
  const n_x_star = xSOL_supply - xSOL_sp;      // All pool xSOL burned
  const n_h_star = (2 * P_star * C) / 3;        // HYusd at exhaustion

  // Phase B break-even: xSOL_buy_p = (P_be * C - n_h*) / n_x*
  // => P_be = (xSOL_buy_p * n_x* + n_h*) / C
  const P_be_sp = (xSOL_buy_p * n_x_star + n_h_star) / C;

  return {
    breakEvenPrice: P_be_sp,
    phase: 'phase-B',
    poolExhaustionSolPrice: P_star,
    poolExhaustionXSolPrice: xSOL_price_at_P_star,
    activationSolPrice: P_activate,
    naiveBreakEvenPrice: P_be_naive,
    improvement: P_be_naive - P_be_sp,
  };
}

/**
 * Format large numbers with K, M, B suffix
 */
export function formatLargeNumber(num: number | null): string {
  if (num === null || num === undefined) return 'N/A';
  
  if (num < 1000) {
    return num.toFixed(2);
  } else if (num < 1000000) {
    return (num / 1000).toFixed(1) + 'K';
  } else if (num < 1000000000) {
    return (num / 1000000).toFixed(1) + 'M';
  } else {
    return (num / 1000000000).toFixed(1) + 'B';
  }
}

/**
 * Format price with appropriate decimals
 */
export function formatXSolPrice(price: number | null | undefined): string {
  if (price === null || price === undefined) return 'N/A';
  if (price < 0.01) return price.toFixed(6);
  if (price < 0.1) return price.toFixed(4);
  if (price < 1) return price.toFixed(3);
  return price.toFixed(2);
}
