import puppeteerCore from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import { chmod } from 'fs/promises';

const puppeteer = puppeteerCore;

// Gist configuration
const GIST_ID = process.env.GIST_ID || 'd3a1db6fc79e168cf5dff8d3a2c11706';
const GIST_RAW_URL = `https://gist.githubusercontent.com/NammaFi/${GIST_ID}/raw/ratex-assets.json`;

/**
 * Fetch existing Gist data for fallback/merge
 * @returns {Promise<Object>} Map of asset name to asset data
 */
export async function fetchExistingGistData() {
  try {
    const response = await fetch(GIST_RAW_URL);
    if (!response.ok) {
      console.warn('⚠️ Could not fetch existing Gist data (may not exist yet)');
      return {};
    }
    
    const data = await response.json();
    
    // Convert array to map for fast lookup
    const dataMap = {};
    if (data.assets && Array.isArray(data.assets)) {
      data.assets.forEach(asset => {
        dataMap[asset.asset] = asset;
      });
    }
    
    console.log(`✅ Loaded ${Object.keys(dataMap).length} assets from existing Gist`);
    return dataMap;
  } catch (error) {
    console.warn('⚠️ Error fetching existing Gist data, starting fresh:', error.message);
    return {};
  }
}

/**
 * Calculate time until maturity from maturity date
 * @param {string} maturityUTC - Maturity date string (e.g., "2025-11-29 00:00:00 UTC")
 * @returns {string} Time until maturity (e.g., "23d 10h")
 */
export function calculateMaturesIn(maturityUTC) {
  try {
    const maturityDate = new Date(maturityUTC);
    const now = new Date();
    const diffMs = maturityDate - now;
    
    if (diffMs <= 0) return "Expired";
    
    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    
    return `${days}d ${hours}h`;
  } catch (error) {
    console.warn('Error calculating maturesIn:', error.message);
    return null;
  }
}

/**
 * Convert maturityDays decimal to maturesIn format (e.g., 0.2083 -> "0d 5h", 23.417 -> "23d 10h")
 * @param {number} maturityDays - Days until maturity as decimal
 * @returns {string} Time until maturity (e.g., "23d 10h")
 */
export function convertMaturityDaysToMaturesIn(maturityDays) {
  if (maturityDays == null || maturityDays < 0) return null;
  
  const days = Math.floor(maturityDays);
  const hours = Math.floor((maturityDays - days) * 24);
  
  return `${days}d ${hours}h`;
}

/**
 * Calculate precise days until maturity (including decimal hours)
 * @param {string} maturity - Maturity date in UTC format
 * @param {string} lastUpdated - Current timestamp
 * @returns {number|null} - Days until maturity as decimal (e.g., 23.417)
 */
export function calculateDaysToMaturity(maturity, lastUpdated) {
  if (!maturity || !lastUpdated) return null;
  
  try {
    const maturityDate = new Date(maturity);
    const updatedDate = new Date(lastUpdated);
    
    if (isNaN(maturityDate.getTime()) || isNaN(updatedDate.getTime())) {
      return null;
    }
    
    const diffMs = maturityDate.getTime() - updatedDate.getTime();
    
    if (diffMs <= 0) return 0;
    
    // Convert milliseconds to days (including decimal hours)
    const days = diffMs / (24 * 60 * 60 * 1000);
    
    return days;
  } catch (error) {
    console.warn('Error calculating days to maturity:', error.message);
    return null;
  }
}

/**
 * Format YT price with adaptive decimal precision (at least 3 non-zero digits)
 * @param {number} value - Raw YT price value
 * @returns {number|null} - Formatted value with appropriate decimals
 */
function formatYtPrice(value) {
  if (value === null || value === undefined) return null;
  
  const absValue = Math.abs(value);
  
  // >= 1.0 → 3 decimals (e.g., 1.234)
  if (absValue >= 1.0) return parseFloat(value.toFixed(3));
  
  // 0.1 to 0.999 → 4 decimals (e.g., 0.1234)
  if (absValue >= 0.1) return parseFloat(value.toFixed(4));
  
  // 0.01 to 0.099 → 5 decimals (e.g., 0.01234)
  if (absValue >= 0.01) return parseFloat(value.toFixed(5));
  
  // 0.001 to 0.0099 → 6 decimals (e.g., 0.001234)
  if (absValue >= 0.001) return parseFloat(value.toFixed(6));
  
  // 0.0001 to 0.00099 → 7 decimals (e.g., 0.0001234)
  if (absValue >= 0.0001) return parseFloat(value.toFixed(7));
  
  // Even smaller → 8 decimals
  return parseFloat(value.toFixed(8));
}

/**
 * Format percentage with adaptive precision (at least 2 non-zero digits)
 * @param {number} value - Percentage value
 * @returns {number|null} - Formatted percentage with appropriate decimals
 */
function formatPercentage(value) {
  if (value === null || value === undefined) return null;
  
  const absValue = Math.abs(value);
  
  if (absValue >= 1.0) return parseFloat(value.toFixed(2));
  if (absValue >= 0.1) return parseFloat(value.toFixed(2));
  if (absValue >= 0.01) return parseFloat(value.toFixed(3));
  if (absValue >= 0.001) return parseFloat(value.toFixed(4));
  if (absValue >= 0.0001) return parseFloat(value.toFixed(5));
  return parseFloat(value.toFixed(6));
}

/**
 * Calculate YT price using formula: 1 - (1 + r)^(-T)
 * @param {string} maturity - Maturity date in UTC format
 * @param {number} yieldRate - Yield rate as percentage (e.g., 62.115)
 * @param {string} lastUpdated - Timestamp when data was fetched
 * @returns {number|null} - YT price with adaptive precision, or null if invalid
 */
function calculateYtPrice(maturity, yieldRate, lastUpdated) {
  if (!maturity || yieldRate === null || yieldRate === undefined || !lastUpdated) {
    return null;
  }
  
  try {
    const maturityDate = new Date(maturity);
    const updatedDate = new Date(lastUpdated);
    
    if (isNaN(maturityDate.getTime()) || isNaN(updatedDate.getTime())) {
      return null;
    }
    
    const diffMs = maturityDate.getTime() - updatedDate.getTime();
    
    if (diffMs <= 0) return 0; // Maturity passed
    
    const T = diffMs / (365 * 24 * 60 * 60 * 1000); // Years
    const r = yieldRate / 100; // Convert percentage to decimal
    const ytPrice = 1 - Math.pow(1 + r, -T);
    
    return formatYtPrice(ytPrice);
  } catch (error) {
    console.warn(`Error calculating YT price:`, error.message);
    return null;
  }
}

/**
 * Calculate YT price using Exponent formula: (r × T) / (1 + r × T)
 * @param {string} maturity - Maturity date in UTC format
 * @param {number} yieldRate - Yield rate as percentage (e.g., 78.0)
 * @param {string} lastUpdated - Timestamp when data was fetched
 * @returns {number|null} - YT price with adaptive precision, or null if invalid
 */
function calculateYtPriceExponent(maturity, yieldRate, lastUpdated) {
  if (!maturity || yieldRate === null || yieldRate === undefined || !lastUpdated) {
    return null;
  }
  
  try {
    const maturityDate = new Date(maturity);
    const updatedDate = new Date(lastUpdated);
    
    if (isNaN(maturityDate.getTime()) || isNaN(updatedDate.getTime())) {
      return null;
    }
    
    const diffMs = maturityDate.getTime() - updatedDate.getTime();
    
    if (diffMs <= 0) return 0; // Maturity passed
    
    const T = diffMs / (365 * 24 * 60 * 60 * 1000); // Years
    const r = yieldRate / 100; // Convert percentage to decimal
    
    // Exponent Formula: (r × T) / (1 + r × T)
    const ytPrice = (r * T) / (1 + (r * T));
    
    return formatYtPrice(ytPrice);
  } catch (error) {
    console.warn(`Error calculating Exponent YT price:`, error.message);
    return null;
  }
}

/**
 * Calculate all YT-related metrics for an asset
 * @param {string} maturity - Maturity date
 * @param {number} impliedYield - Implied yield percentage
 * @param {number} rangeLower - Lower yield range percentage
 * @param {number} rangeUpper - Upper yield range percentage
 * @param {string} lastUpdated - Timestamp when data was fetched
 * @param {number} leverage - Leverage multiplier
 * @param {number} apy - Annual Percentage Yield
 * @param {number} maturityDays - Days until maturity
 * @param {number} assetBoost - Asset boost multiplier
 * @param {string} source - Data source ('ratex' or 'exponent')
 * @returns {Object} All YT metrics (prices, upside, downside, decay, end-day, recovery, points)
 */
export function calculateYtMetrics(maturity, impliedYield, rangeLower, rangeUpper, lastUpdated, leverage, apy, maturityDays, assetBoost, source = 'ratex') {
  const result = {
    ytPriceCurrent: null,
    ytPriceLower: null,
    ytPriceUpper: null,
    dailyYieldRate: null,
    downsideRisk: null,
    endDayCurrentYield: null,
    endDayLowerYield: null,
    dailyDecayRate: null,
    expectedRecoveryYield: null,
    expectedPointsPerDay: null,
    totalExpectedPoints: null
  };
  
  if (!maturity || !lastUpdated) return result;
  
  try {
    const maturityDate = new Date(maturity);
    const updatedDate = new Date(lastUpdated);
    const diffMs = maturityDate.getTime() - updatedDate.getTime();
    
    // Maturity passed - all zeros
    if (diffMs <= 0) {
      return {
        ytPriceCurrent: 0,
        ytPriceLower: 0,
        ytPriceUpper: 0,
        dailyYieldRate: 0,
        downsideRisk: 0,
        endDayCurrentYield: 0,
        endDayLowerYield: 0,
        dailyDecayRate: 0,
        expectedRecoveryYield: 0,
        expectedPointsPerDay: 0,
        totalExpectedPoints: 0
      };
    }
    
    const currentT = diffMs / (365 * 24 * 60 * 60 * 1000); // Years
    
    // Choose YT price calculation function based on source
    const calculatePrice = source === 'exponent' ? calculateYtPriceExponent : calculateYtPrice;
    
    // Calculate YT prices
    result.ytPriceCurrent = calculatePrice(maturity, impliedYield, lastUpdated);
    result.ytPriceLower = calculatePrice(maturity, rangeLower, lastUpdated);
    result.ytPriceUpper = calculatePrice(maturity, rangeUpper, lastUpdated);
    
    // Calculate Daily Yield Rate
    if (leverage !== null && leverage !== undefined && apy !== null && apy !== undefined) {
      const apyDecimal = apy / 100;
      const feeMultiplier = source === 'exponent' ? 0.945 : 0.95;
      const dailyYield = leverage * (Math.pow(1 + apyDecimal, 1/365) - 1) * 100 * feeMultiplier;
      result.dailyYieldRate = formatPercentage(dailyYield);
    }
    
    // Calculate downside risk
    if (result.ytPriceCurrent && result.ytPriceLower) {
      const downside = ((result.ytPriceCurrent - result.ytPriceLower) / result.ytPriceCurrent) * 100;
      result.downsideRisk = formatPercentage(downside);
    }
    
    // Only 1 day left edge case
    if (currentT <= 1/365) {
      result.dailyDecayRate = 100;
      result.endDayCurrentYield = 0;
      result.endDayLowerYield = 0;
      
      // Calculate Expected Recovery Yield with FULL 1 day (not remaining hours)
      if (leverage !== null && leverage !== undefined && apy !== null && apy !== undefined) {
        const apyDecimal = apy / 100;
        // Use 1 full day for standardized comparison
        const grossYield = leverage * (Math.pow(1 + apyDecimal, 1/365) - 1) * 365 * (1/365) * 100;
        const feeMultiplier = source === 'exponent' ? 0.945 : 0.95;
        const netYield = grossYield * feeMultiplier;
        result.expectedRecoveryYield = formatPercentage(netYield);
      }
      
      // Calculate points with ACTUAL remaining time (including hours)
      const preciseDays = calculateDaysToMaturity(maturity, lastUpdated);
      const daysToUse = preciseDays !== null ? preciseDays : maturityDays;
      
      if (leverage !== null && leverage !== undefined && assetBoost !== null && assetBoost !== undefined && daysToUse !== null && daysToUse !== undefined && daysToUse > 0) {
        const depositAmount = 1;
        const totalPoints = leverage * assetBoost * depositAmount * daysToUse;
        result.totalExpectedPoints = Math.round(totalPoints);
      }
      
      if (leverage !== null && leverage !== undefined && assetBoost !== null && assetBoost !== undefined) {
        const depositAmount = 1;
        const pointsPerDay = leverage * assetBoost * depositAmount;
        result.expectedPointsPerDay = Math.round(pointsPerDay);
      }
      
      return result;
    }
    
    // Daily decay rate (time decay with constant yield)
    if (impliedYield !== null && impliedYield !== undefined) {
      if (source === 'exponent') {
        // Use Exponent formula for tomorrow's price
        const tomorrowDate = new Date(new Date(lastUpdated).getTime() + 24 * 60 * 60 * 1000);
        const ytToday = result.ytPriceCurrent;
        const ytTomorrow = calculateYtPriceExponent(maturity, impliedYield, tomorrowDate.toISOString());
        if (ytToday && ytTomorrow) {
          const decay = ((ytToday - ytTomorrow) / ytToday) * 100;
          result.dailyDecayRate = formatPercentage(decay);
        }
      } else {
        // RateX formula
        const tomorrowT = currentT - (1/365);
        const r = impliedYield / 100;
        const ytToday = 1 - Math.pow(1 + r, -currentT);
        const ytTomorrow = 1 - Math.pow(1 + r, -tomorrowT);
        const decay = ((ytToday - ytTomorrow) / ytToday) * 100;
        result.dailyDecayRate = formatPercentage(decay);
      }
    }
    
    // End-day scenarios: 1 day left with different yield scenarios
    const T_oneDay = 1 / 365;
    
    // Scenario 1: 1 day left with CURRENT implied yield - show REMAINING %
    if (impliedYield !== null && impliedYield !== undefined && result.ytPriceCurrent) {
      const r_current = impliedYield / 100;
      const ytEndCurrentYield = 1 - Math.pow(1 + r_current, -T_oneDay);
      const remainingCurrentYield = (ytEndCurrentYield / result.ytPriceCurrent) * 100;
      result.endDayCurrentYield = formatPercentage(remainingCurrentYield);
    }
    
    // Scenario 2: 1 day left with LOWER range yield (worst case) - show REMAINING %
    if (rangeLower !== null && rangeLower !== undefined && result.ytPriceCurrent) {
      const r_lower = rangeLower / 100;
      const ytEndLowerYield = 1 - Math.pow(1 + r_lower, -T_oneDay);
      const remainingLowerYield = (ytEndLowerYield / result.ytPriceCurrent) * 100;
      result.endDayLowerYield = formatPercentage(remainingLowerYield);
    }
    
    // Calculate Expected Recovery Yield (Net Yield %)
    // Use precise days from maturity date, fallback to maturityDays
    const preciseDays = calculateDaysToMaturity(maturity, lastUpdated);
    const daysToUse = preciseDays !== null ? preciseDays : maturityDays;
    
    if (leverage !== null && leverage !== undefined && apy !== null && apy !== undefined && daysToUse !== null && daysToUse !== undefined && daysToUse > 0) {
      const apyDecimal = apy / 100; // Convert percentage to decimal
      const grossYield = leverage * (Math.pow(1 + apyDecimal, 1/365) - 1) * 365 * (daysToUse/365) * 100;
      // Platform fees: RateX takes 5%, Exponent takes 5.5%
      const feeMultiplier = source === 'exponent' ? 0.945 : 0.95;
      const netYield = grossYield * feeMultiplier;
      result.expectedRecoveryYield = formatPercentage(netYield);
    }
    
    // Calculate Total Expected Points (with $1 deposit)
    // Formula: leverage × assetBoost × depositAmount × maturityDays
    if (leverage !== null && leverage !== undefined && assetBoost !== null && assetBoost !== undefined && daysToUse !== null && daysToUse !== undefined && daysToUse > 0) {
      const depositAmount = 1; // Default deposit amount
      const totalPoints = leverage * assetBoost * depositAmount * daysToUse;
      result.totalExpectedPoints = Math.round(totalPoints); // Round to whole number
    }
    
    // Calculate Expected Points Per Day
    // Formula: leverage × assetBoost × depositAmount
    if (leverage !== null && leverage !== undefined && assetBoost !== null && assetBoost !== undefined) {
      const depositAmount = 1; // Default deposit amount
      const pointsPerDay = leverage * assetBoost * depositAmount;
      result.expectedPointsPerDay = Math.round(pointsPerDay); // Round to whole number
    }
    
    return result;
  } catch (error) {
    console.warn(`Error calculating YT metrics:`, error.message);
    return result;
  }
}

/**
 * Scrapes asset data from Rate-X leverage page
 * @param {string} assetName - The name of the asset to scrape (e.g., 'HyloSOL', 'HYusd', 'sHYUSD', 'xSOL')
 * @returns {Promise<Object>} Asset data including full name, base name, leverage, APY, maturity days, asset boost, RateX boost, and implied yield
 */
export async function scrapeAssetData(assetName = 'HyloSOL') {
  let browser;
  
  try {
    console.log(`Starting scraper for asset: ${assetName}`);
    
    // Get executable path and ensure it has proper permissions
    const executablePath = await chromium.executablePath();
    
    // Fix ETXTBSY error by setting executable permissions
    try {
      await chmod(executablePath, 0o755);
    } catch (chmodError) {
      console.warn('Could not chmod chromium:', chmodError.message);
    }
    
    browser = await puppeteer.launch({
      args: [...chromium.args, '--single-process', '--no-zygote'],
      defaultViewport: chromium.defaultViewport,
      executablePath: executablePath,
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });
    
    const page = await browser.newPage();
    
    console.log('Navigating to Rate-X leverage page...');
    await page.goto('https://app.rate-x.io/leverage', {
      waitUntil: 'domcontentloaded', // Faster than 'networkidle2'
      timeout: 90000 // 90 seconds (1:30 min) to handle cold starts
    });
    
    // Wait for cards to appear instead of fixed timeout
    console.log('Waiting for asset cards to load...');
    try {
      await page.waitForFunction(
        () => document.body.innerText.length > 1000,
        { timeout: 10000 }
      );
    } catch (e) {
      console.warn('Content may not be fully loaded, proceeding anyway...');
    }
    
    // Scroll down multiple times to load ALL cards
    console.log('Scrolling to load all cards...');
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => {
        window.scrollBy(0, 1500);
      });
      await page.waitForTimeout(800); // Reduced from 1500ms to 800ms
    }
    
    console.log(`Looking for ${assetName} card...`);
    
    // First, let's see what's on the page
    const pageContent = await page.evaluate(() => {
      return {
        bodyText: document.body.innerText.substring(0, 3000), // Increased to see more cards
        hasCards: document.querySelectorAll('[class*="card"]').length,
        hasDivs: document.querySelectorAll('div').length
      };
    });
    
    console.log('Page content preview (first 3000 chars):', pageContent);
    
    // Extract data from the page with improved selectors
    const assetData = await page.evaluate((targetAsset) => {
      console.log('Looking for asset:', targetAsset);
      
      // Try multiple strategies to find the asset card
      const allText = document.body.innerText;
      console.log('Page contains asset name?', allText.includes(targetAsset));
      
      // Strategy: Find the exact asset card in the scrolled list
      // Asset cards are formatted as: "assetName-MMYY" (e.g., "hyloSOL+-2511", "xSOL-2511")
      const allElements = Array.from(document.querySelectorAll('*'));
      let assetCard = null;
      let smallestCardLevel = 999; // Track the smallest (most specific) card
      
      // Find element that contains the asset name followed by a dash (exact match)
      for (const element of allElements) {
        const text = element.textContent || '';
        const trimmedText = text.trim();
        
        // Look for pattern: "assetName-" at the start of the text
        // This ensures we match "hyloSOL+-2511" and not "hyloSOL-2511"
        const assetPattern = new RegExp(`^${targetAsset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d{4}$`, 'i');
        
        if (assetPattern.test(trimmedText)) {
          // Found element with asset name, now find parent card
          let current = element;
          for (let i = 0; i < 15; i++) {
            if (!current.parentElement) break;
            current = current.parentElement;
            
            // Check if this looks like a complete card
            const textContent = current.textContent;
            
            // Must contain ALL key indicators of a leverage card
            const hasYieldExposure = textContent.includes('Yield Exposure');
            const hasAPY = textContent.includes('Underlying APY');
            const hasDays = textContent.includes('Days');
            const hasAssetTitle = textContent.includes(trimmedText); // Must contain the exact title
            
            if (hasYieldExposure && hasAPY && hasDays && hasAssetTitle) {
              // Prefer the smallest (most specific) card
              if (i < smallestCardLevel) {
                assetCard = current;
                smallestCardLevel = i;
              }
              break; // Don't traverse further up for this element
            }
          }
        }
      }
      
      if (!assetCard) {
        console.log('Could not find asset card');
        console.log('Available text preview:', allText.substring(0, 2000));
        throw new Error(`Asset card for ${targetAsset} not found on the page`);
      }
      
      console.log('Found asset card!');
      const cardText = assetCard.textContent;
      console.log('Card text preview:', cardText.substring(0, 500));
      
      // Extract full asset name from the card (e.g., "xSOL-2511")
      const fullNameMatch = cardText.match(new RegExp(`${targetAsset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d{4}`, 'i'));
      const fullAssetName = fullNameMatch ? fullNameMatch[0] : targetAsset;
      
      // Initialize result object
      const result = {
        asset: fullAssetName,      // Full name: "xSOL-2511"
        baseAsset: targetAsset,    // Base name: "xSOL"
        leverage: null,
        apy: null,
        maturityDays: null,
        assetBoost: null,
        ratexBoost: null,
        impliedYield: null,
        
        // Phase 2 fields - not available from cards page
        rangeLower: null,
        rangeUpper: null,
        maturity: null,
        maturesIn: null
      };
      
      // Extract data using regex patterns on the full card text
      
      // Extract Leverage (Yield Exposure) - look for patterns like "18.7x" or "Yield Exposure 18.7x"
      const leverageMatch = cardText.match(/Yield\s+Exposure[^\d]*([\d.]+)\s*x/i);
      if (leverageMatch) {
        result.leverage = parseFloat(leverageMatch[1]);
        console.log('Found leverage:', result.leverage);
      }
      
      // Extract APY - look for patterns like "4.2%" near "APY" or "Underlying APY" (may have no space)
      const apyMatch = cardText.match(/Underlying\s+APY\s*([\d.]+)\s*%/i);
      if (apyMatch) {
        result.apy = parseFloat(apyMatch[1]);
        console.log('Found APY:', result.apy);
      }
      
      // Extract Implied Yield - beside Yield Exposure, labeled as "Implied Yield"
      const impliedYieldMatch = cardText.match(/Implied\s+Yield[:\s]*([\d.]+)\s*%/i);
      if (impliedYieldMatch) {
        result.impliedYield = parseFloat(impliedYieldMatch[1]);
        console.log('Found Implied Yield:', result.impliedYield);
      }
      
      // Extract Maturity Days - look for patterns like "14 Days" or "10 Hours"
      let maturityMatch = cardText.match(/([\d]+)\s*Days/i);
      if (maturityMatch) {
        result.maturityDays = parseInt(maturityMatch[1]);
        console.log('Found maturity:', result.maturityDays);
      } else {
        // Handle "Hours" format for assets expiring soon - convert to decimal days
        const hoursMatch = cardText.match(/([\d.]+)\s*Hours?/i);
        if (hoursMatch) {
          const hours = parseFloat(hoursMatch[1]);
          result.maturityDays = hours / 24; // Convert hours to decimal days (e.g., 10 hours = 0.4167 days)
          console.log('Found maturity in hours:', hours, 'hours, converted to', result.maturityDays, 'days');
        }
      }
      
      // Extract Asset Boost and RateX Boost
      // These appear as "8x" and "5x" AFTER the asset name and BEFORE "Yield Exposure"
      // Pattern: assetName-MMYY \n 8x \n 5x \n Yield Exposure
      // Some assets may have only 1 boost value
      // First, remove the asset name with version (e.g., "hyloSOL+-2511") to avoid matching "2511x"
      const assetNamePattern = new RegExp(`${targetAsset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d{4}`, 'i');
      const cleanedText = cardText.replace(assetNamePattern, ''); // Remove asset name
      const boostSection = cleanedText.split('Yield Exposure')[0]; // Get text before "Yield Exposure"
      const boostMatches = boostSection.match(/(\d+)x/gi);
      
      if (boostMatches && boostMatches.length >= 2) {
        // First two "Xx" values after removing asset name are the boosts
        result.assetBoost = parseFloat(boostMatches[0].replace(/x/i, ''));
        result.ratexBoost = parseFloat(boostMatches[1].replace(/x/i, ''));
        console.log('Found boosts:', result.assetBoost, result.ratexBoost);
      } else if (boostMatches && boostMatches.length === 1) {
        // Only one boost found - assign to asset boost
        result.assetBoost = parseFloat(boostMatches[0].replace(/x/i, ''));
        result.ratexBoost = 1; // Default to 1x for RateX boost
        console.log('Found single boost:', result.assetBoost);
      }
      
      return result;
    }, assetName);
    
    console.log('Scraped data:', assetData);
    
    // Validate that we got the essential data
    const missingFields = [];
    if (assetData.leverage === null) missingFields.push('leverage');
    if (assetData.apy === null) missingFields.push('apy');
    if (assetData.maturityDays === null) missingFields.push('maturityDays');
    
    if (missingFields.length > 0) {
      console.warn(`Warning: Could not extract the following fields: ${missingFields.join(', ')}`);
    }
    
    await browser.close();
    return assetData;
    
  } catch (error) {
    console.error('Error scraping asset data:', error);
    if (browser) {
      await browser.close();
    }
    throw error;
  }
}

/**
 * Scrapes all available assets from Rate-X leverage page
 * NOW OPTIMIZED: Scrapes ALL asset data in ONE page visit!
 * @returns {Promise<Array>} Array of all asset data
 */
export async function scrapeAllAssets() {
  let browser;
  
  try {
    console.log('🚀 Starting optimized scraper - fetching ALL assets in one go!');
    
    // Get executable path and ensure it has proper permissions
    const executablePath = await chromium.executablePath();
    
    // Fix ETXTBSY error by setting executable permissions
    try {
      await chmod(executablePath, 0o755);
    } catch (chmodError) {
      console.warn('Could not chmod chromium:', chmodError.message);
    }
    
    browser = await puppeteer.launch({
      args: [...chromium.args, '--single-process', '--no-zygote'],
      defaultViewport: chromium.defaultViewport,
      executablePath: executablePath,
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });
    
    const page = await browser.newPage();
    
    console.log('Navigating to Rate-X leverage page...');
    await page.goto('https://app.rate-x.io/leverage', {
      waitUntil: 'domcontentloaded', // Faster than 'networkidle2'
      timeout: 90000 // 90 seconds (1:30 min) to handle cold starts
    });
    
    // Wait for cards to appear instead of fixed timeout
    console.log('Waiting for asset cards to load...');
    try {
      await page.waitForFunction(
        () => document.body.innerText.length > 1000,
        { timeout: 10000 }
      );
    } catch (e) {
      console.warn('Content may not be fully loaded, proceeding anyway...');
    }
    
    // Scroll to load all cards
    console.log('Scrolling to load all cards...');
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => {
        window.scrollBy(0, 1500);
      });
      await page.waitForTimeout(800); // Reduced from 1500ms to 800ms
    }
    
    console.log('⚡ Extracting ALL asset data in one operation...');
    
    // Extract ALL assets data in ONE operation
    const allAssetData = await page.evaluate(() => {
      const assets = [];
      const processedAssets = new Set();
      
      // Find all elements that might be asset names
      const allElements = Array.from(document.querySelectorAll('*'));
      
      for (const element of allElements) {
        const text = element.textContent || '';
        const trimmedText = text.trim();
        
        // Match pattern: "AssetName-MMYY" (e.g., "xSOL-2511", "hyloSOL+-2511", "USD*-2512")
        const assetNameMatch = trimmedText.match(/^([A-Za-z0-9*+\-]+)-(\d{4})$/);
        
        if (assetNameMatch) {
          const fullAssetName = assetNameMatch[0]; // e.g., "xSOL-2511"
          const assetName = assetNameMatch[1]; // e.g., "xSOL"
          
          // Skip if already processed this full asset name (to handle duplicates)
          if (processedAssets.has(fullAssetName)) continue;
          
          // Now find the parent card containing all data for this asset
          // We want the SMALLEST (most specific) card, not the first one
          let current = element;
          let bestCard = null;
          let smallestLevel = 999;
          
          for (let i = 0; i < 15; i++) {
            if (!current.parentElement) break;
            current = current.parentElement;
            
            const cardText = current.textContent;
            
            // Check if this is a complete card with all required fields
            const hasYieldExposure = cardText.includes('Yield Exposure');
            const hasAPY = cardText.includes('Underlying APY');
            const hasDays = cardText.includes('Days') || cardText.includes('Hours');
            const hasAssetName = cardText.includes(fullAssetName);
            
            // IMPORTANT: Make sure this card contains ONLY this asset's data
            // Count how many asset-like patterns exist in this card
            // A valid individual card should have just ONE asset name pattern
            const assetPatternMatches = cardText.match(/[A-Za-z0-9*+\-]+-\d{4}/g);
            const isIndividualCard = assetPatternMatches && assetPatternMatches.length === 1;
            
            if (hasYieldExposure && hasAPY && hasDays && hasAssetName && isIndividualCard) {
              // Found a complete individual card - prefer the smallest (most specific) one
              if (i < smallestLevel) {
                bestCard = current;
                smallestLevel = i;
              }
            }
          }
          
          // Only process if we found a valid card
          if (bestCard) {
            const cardText = bestCard.textContent;
            
            // Extract all data
            const result = {
              asset: fullAssetName,      // Full name: "xSOL-2511"
              baseAsset: assetName,      // Base name: "xSOL"
              leverage: null,
              apy: null,
              maturityDays: null,
              assetBoost: null,
              ratexBoost: null,
              impliedYield: null,
              source: 'ratex',           // Source platform identifier
              
              // Visual assets from card (extracted in Phase 1)
              projectBackgroundImage: null,
              projectName: null,
              assetSymbolImage: null,
              
              // Phase 2 fields - will be populated later
              rangeLower: null,
              rangeUpper: null,
              maturity: null,
              maturesIn: null
            };
            
            // Extract Leverage (Yield Exposure)
            const leverageMatch = cardText.match(/Yield\s+Exposure[^\d]*([\d.]+)\s*x/i);
            if (leverageMatch) {
              result.leverage = parseFloat(leverageMatch[1]);
            }
            
            // Extract APY
            const apyMatch = cardText.match(/Underlying\s+APY\s*([\d.]+)\s*%/i);
            if (apyMatch) {
              result.apy = parseFloat(apyMatch[1]);
            }
            
            // Extract Implied Yield - beside Yield Exposure
            const impliedYieldMatch = cardText.match(/Implied\s+Yield[:\s]*([\d.]+)\s*%/i);
            if (impliedYieldMatch) {
              result.impliedYield = parseFloat(impliedYieldMatch[1]);
            }
            
            // Extract Maturity Days - look for patterns like "14 Days" or "10 Hours"
            let maturityMatch = cardText.match(/([\d]+)\s*Days/i);
            if (maturityMatch) {
              result.maturityDays = parseInt(maturityMatch[1]);
            } else {
              // Handle "Hours" format for assets expiring soon - convert to decimal days
              const hoursMatch = cardText.match(/([\d.]+)\s*Hours?/i);
              if (hoursMatch) {
                const hours = parseFloat(hoursMatch[1]);
                result.maturityDays = hours / 24; // Convert hours to decimal days (e.g., 5 hours = 0.2083 days)
              }
            }
            
            // Extract Asset Boost and RateX Boost
            const assetNamePattern = new RegExp(`${assetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d{4}`, 'i');
            const cleanedText = cardText.replace(assetNamePattern, '');
            const boostSection = cleanedText.split('Yield Exposure')[0];
            const boostMatches = boostSection.match(/(\d+)x/gi);
            
            if (boostMatches && boostMatches.length >= 2) {
              result.assetBoost = parseFloat(boostMatches[0].replace(/x/i, ''));
              result.ratexBoost = parseFloat(boostMatches[1].replace(/x/i, ''));
            } else if (boostMatches && boostMatches.length === 1) {
              result.assetBoost = parseFloat(boostMatches[0].replace(/x/i, ''));
              result.ratexBoost = 1;
            }
            
            // Extract Project Background Image from card div (Phase 1)
            // Card should have inline style with background-image
            const cardDiv = bestCard.querySelector('div[style*="background-image"]') || bestCard;
            if (cardDiv) {
              const styleAttr = cardDiv.getAttribute('style');
              if (styleAttr) {
                const bgImageMatch = styleAttr.match(/background-image:\s*url\s*\(\s*["']?((?:https?:)?\/\/static\.rate-x\.io\/[^"')]+)["']?\s*\)/i);
                if (bgImageMatch) {
                  let imageUrl = bgImageMatch[1];
                  
                  // Fix protocol
                  if (imageUrl.startsWith('//')) {
                    imageUrl = 'https:' + imageUrl;
                  }
                  
                  result.projectBackgroundImage = imageUrl;
                  
                  // Extract project name from filename
                  const urlParts = imageUrl.split('/');
                  const filename = urlParts[urlParts.length - 1];
                  let projectName = filename.replace(/\.(svg|png|jpg|jpeg|gif|webp)$/i, '');
                  
                  // Remove URL encoding and suffixes like %20BG, _BG, etc.
                  projectName = decodeURIComponent(projectName);
                  projectName = projectName.replace(/(%20BG|_BG|\s+BG)$/i, '');
                  projectName = projectName.trim();
                  
                  result.projectName = projectName;
                }
              }
            }
            
            // Extract Asset Symbol Image from card (Phase 1)
            // Find first img tag in the card
            const cardImages = bestCard.querySelectorAll('img[src]');
            for (const img of cardImages) {
              let src = img.getAttribute('src');
              if (!src) continue;
              
              // Fix protocol
              if (src.startsWith('//')) {
                src = 'https:' + src;
              }
              
              // Take first image from static.rate-x.io
              if (src.includes('static.rate-x.io/img/')) {
                result.assetSymbolImage = src;
                break;
              }
            }
            
            // Only add if we found essential data
            if (result.leverage !== null && result.maturityDays !== null) {
              assets.push(result);
              processedAssets.add(fullAssetName); // Track by full name to allow multiple versions
            }
          } // Close if (bestCard)
        } // Close if (assetNameMatch)
      } // Close for loop
      
      return assets;
    });
    
    console.log(`✅ Successfully scraped ${allAssetData.length} assets in ONE page visit!`);
    console.log('Assets found:', allAssetData.map(a => a.asset).join(', '));
    
    // Convert maturityDays to maturesIn format for Rate-X assets (after page.evaluate)
    allAssetData.forEach(asset => {
      if (asset.maturityDays !== null) {
        asset.maturesIn = convertMaturityDaysToMaturesIn(asset.maturityDays);
      }
    });
    
    await browser.close();
    return allAssetData;
    
  } catch (error) {
    console.error('Error scraping all assets:', error);
    if (browser) {
      await browser.close();
    }
    throw error;
  }
}

/**
 * Scrape detail page for a single asset
 * @param {Object} page - Puppeteer page instance
 * @param {string} fullAssetName - Full asset name (e.g., "hyloSOL-2511")
 * @returns {Promise<Object>} Detail data including range, maturity, maturesIn, impliedYield
 */
export async function scrapeDetailPage(page, fullAssetName) {
  const url = `https://app.rate-x.io/liquidity/slp?symbol=${encodeURIComponent(fullAssetName)}&tab=Detail`;
  
  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    
    // Wait for content to load
    await page.waitForTimeout(2000);
    
    // Extract detail page data
    const detailData = await page.evaluate(() => {
      const bodyText = document.body.innerText;
      
      const result = {
        rangeLower: null,
        rangeUpper: null,
        maturity: null,
        maturesIn: null,
        impliedYield: null
      };
      
      // Extract Range: "10% - 30%" or "10%-30%"
      const rangeMatch = bodyText.match(/Range[^\d]*([\d]+)%\s*-\s*([\d]+)%/i);
      if (rangeMatch) {
        result.rangeLower = parseInt(rangeMatch[1]);
        result.rangeUpper = parseInt(rangeMatch[2]);
      }
      
      // Extract Maturity: "2025-11-29 00:00:00 UTC"
      const maturityMatch = bodyText.match(/Maturity[^\d]*([\d]{4}-[\d]{2}-[\d]{2}\s+[\d]{2}:[\d]{2}:[\d]{2}\s+UTC)/i);
      if (maturityMatch) {
        result.maturity = maturityMatch[1];
      }
      
      // Extract Matures In: "23d 10h"
      const maturesInMatch = bodyText.match(/Matures\s+in[^\d]*([\d]+d\s+[\d]+h)/i);
      if (maturesInMatch) {
        result.maturesIn = maturesInMatch[1];
      }
      
      // Extract Implied Yield (updated value from detail page)
      const impliedYieldMatch = bodyText.match(/Implied\s+Yield[:\s]*([\d.]+)\s*%/i);
      if (impliedYieldMatch) {
        result.impliedYield = parseFloat(impliedYieldMatch[1]);
      }
      
      return result;
    });
    
    return detailData;
    
  } catch (error) {
    console.warn(`  ⚠️ Error scraping detail page for ${fullAssetName}:`, error.message);
    throw error;
  }
}

/**
 * Scrape detail page with retry logic
 * @param {Object} page - Puppeteer page instance
 * @param {string} fullAssetName - Full asset name
 * @param {number} maxRetries - Maximum number of retry attempts (default: 2)
 * @returns {Promise<Object|null>} Detail data or null if all retries fail
 */
export async function scrapeDetailPageWithRetry(page, fullAssetName, maxRetries = 2) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`    [RateX] Attempt ${attempt}/${maxRetries}...`);
      const detailData = await scrapeDetailPage(page, fullAssetName);
      
      // Validate that we got at least some data
      if (detailData.rangeLower !== null || detailData.maturity !== null) {
        return detailData;
      } else {
        throw new Error('No valid data extracted from detail page');
      }
    } catch (error) {
      console.warn(`    [RateX] Attempt ${attempt} failed:`, error.message);
      
      if (attempt < maxRetries) {
        console.log(`    [RateX] Retrying in 2 seconds...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }
  
  return null; // All retries failed
}

/**
 * Scrape detail pages for all assets (Phase 2)
 * @param {Object} page - Puppeteer page instance
 * @param {Array} assets - Array of asset objects from Phase 1
 * @param {Object} existingGistData - Map of existing Gist data for fallback
 * @returns {Promise<Array>} Assets with detail page data merged
 */
export async function scrapeDetailPages(page, assets, existingGistData) {
  console.log('🔍 PHASE 2: Fetching detail pages...');
  const lastUpdated = new Date().toISOString(); // Single timestamp for all calculations
  
  for (const asset of assets) {
    console.log(`  → Fetching details for ${asset.asset}...`);
    
    const detailData = await scrapeDetailPageWithRetry(page, asset.asset, 2);
    
    if (detailData) {
      // Success - update with fresh data
      asset.rangeLower = detailData.rangeLower;
      asset.rangeUpper = detailData.rangeUpper;
      asset.maturity = detailData.maturity;
      
      // Calculate precise decimal days for accurate YT metrics
      const preciseDays = calculateDaysToMaturity(asset.maturity, lastUpdated);
      asset.maturityDays = Math.floor(preciseDays); // For display
      
      // Use scraped maturesIn if available, otherwise calculate from maturity date
      asset.maturesIn = detailData.maturesIn || (asset.maturity ? calculateMaturesIn(asset.maturity) : null);
      
      // Note: projectBackgroundImage, projectName, and assetSymbolImage 
      // are already set from Phase 1, so we don't touch them here
      
      // Override implied yield with latest value from detail page
      if (detailData.impliedYield !== null) {
        asset.impliedYield = detailData.impliedYield;
      }
      
      // Calculate all YT metrics with precise days
      const ytMetrics = calculateYtMetrics(
        asset.maturity,
        asset.impliedYield,
        asset.rangeLower,
        asset.rangeUpper,
        lastUpdated,
        asset.leverage,
        asset.apy,
        preciseDays,
        asset.assetBoost
      );
      
      Object.assign(asset, ytMetrics);
      
      console.log(`  ✅ ${asset.asset}: Range ${detailData.rangeLower}-${detailData.rangeUpper}%, YT Current ${ytMetrics.ytPriceCurrent}`);
    } else {
      // Failed after retries - use old Gist data for DETAIL fields only
      console.warn(`  ⚠️ Failed to fetch ${asset.asset}, using fallback data`);
      
      const oldAsset = existingGistData[asset.asset];
      if (oldAsset) {
        // Use old detail page data (Phase 2 fields only)
        asset.rangeLower = oldAsset.rangeLower;
        asset.rangeUpper = oldAsset.rangeUpper;
        asset.maturity = oldAsset.maturity;
        
        // NOTE: DO NOT overwrite Phase 1 fields (projectBackgroundImage, projectName, assetSymbolImage)
        // Those were just scraped fresh in Phase 1, keep them!
        
        // Recalculate YT metrics with old data
        const ytMetrics = calculateYtMetrics(
          asset.maturity,
          asset.impliedYield,
          asset.rangeLower,
          asset.rangeUpper,
          lastUpdated,
          asset.leverage,
          asset.apy,
          asset.maturityDays,
          asset.assetBoost
        );
        
        Object.assign(asset, ytMetrics);
        
        // Recalculate maturesIn from old maturity if available
        if (oldAsset.maturity) {
          asset.maturesIn = calculateMaturesIn(oldAsset.maturity);
          console.log(`  📊 Using cached data with recalculated maturesIn: ${asset.maturesIn}`);
        } else {
          asset.maturesIn = null;
        }
      } else {
        // New asset with no old data - set Phase 2 fields to null
        // NOTE: Phase 1 fields (projectBackgroundImage, projectName, assetSymbolImage) 
        // are already set from Phase 1, so we keep those
        asset.ytPriceCurrent = null;
        asset.ytPriceLower = null;
        asset.ytPriceUpper = null;
        asset.upsidePotential = null;
        asset.downsideRisk = null;
        asset.endDayMinimumPct = null;
        asset.dailyDecayRate = null;
        asset.expectedRecoveryYield = null;
        asset.expectedPointsPerDay = null;
        asset.totalExpectedPoints = null;
        console.log(`  ℹ️ New asset ${asset.asset} - detail fields will be null until next run`);
      }
    }
  }
  
  console.log('✅ Phase 2 complete');
  return assets;
}

/**
 * Convert fullAssetName to Exponent detail page URL slug
 * @param {string} fullAssetName - e.g., "YT-eUSX-11MAR26" or "YT-hyloSOL+-15DEC25"
 * @returns {string} - e.g., "eusx-11Mar26" or "hylosolplus-15Dec25"
 */
function assetNameToUrlSlug(fullAssetName) {
  const withoutPrefix = fullAssetName.replace(/^YT-/i, '');
  const lastDashIndex = withoutPrefix.lastIndexOf('-');
  let baseAsset = withoutPrefix.substring(0, lastDashIndex).toLowerCase();
  const dateStr = withoutPrefix.substring(lastDashIndex + 1);
  
  baseAsset = baseAsset
    .replace(/\+/g, 'plus')
    .replace(/\*/g, 'star');
  
  const day = dateStr.substring(0, 2);
  const month = dateStr.substring(2, 5);
  const year = dateStr.substring(5, 7);
  
  const formattedDate = day + month.charAt(0).toUpperCase() + month.substring(1).toLowerCase() + year;
  
  return `${baseAsset}-${formattedDate}`;
}

/**
 * Scrape Exponent detail pages for Phase 2 data
 * @param {Object} page - Puppeteer page instance
 * @param {Array} assets - Array of Exponent assets from Phase 1
 * @param {Object} existingGistData - Existing Gist data for fallback
 * @returns {Promise<Array>} Assets with Phase 2 data
 */
export async function scrapeExponentDetailPages(page, assets, existingGistData) {
  console.log(`\n🔍 Scraping ${assets.length} Exponent detail pages...`);
  const lastUpdated = new Date().toISOString();
  
  for (const asset of assets) {
    try {
      console.log(`\n📄 Processing ${asset.asset}...`);
      
      const baseSlug = assetNameToUrlSlug(asset.asset);
      const urlVariations = [
        `https://www.exponent.finance/farm/${baseSlug}`,
        `https://www.exponent.finance/farm/${baseSlug}-1`,
        `https://www.exponent.finance/farm/${baseSlug}-2`,
        `https://www.exponent.finance/farm/${baseSlug}-3`
      ];
      
      let detailData = null;
      let attemptNumber = 1;
      let startTime = null; // Define in outer scope to avoid ReferenceError
      
      for (const url of urlVariations) {
        try {
          console.log(`    [Exponent] Attempt ${attemptNumber}/${urlVariations.length}...`);
          attemptNumber++;
          startTime = Date.now();
          
          const response = await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: 30000
          });
          
          if (response.status() === 404) {
            console.log(`      ↳ URL returned 404, trying next variation`);
            continue;
          }
          
          await page.waitForTimeout(2000);
          
          // Always click Details tab
          const detailsElements = await page.$x("//button[contains(text(), 'Details')] | //div[contains(text(), 'Details')]");
          if (detailsElements.length === 0) {
            throw new Error('Details tab button not found');
          }
          
          await detailsElements[0].click();
          console.log(`      ↳ Clicked Details tab, waiting for content...`);
          
          // Wait for Details content to load (check every 1s, max 5s)
          let detailsLoaded = false;
          for (let i = 0; i < 5; i++) {
            await page.waitForTimeout(1000);
            detailsLoaded = await page.evaluate(() => {
              const bodyText = document.body.innerText || document.body.textContent || '';
              return bodyText.includes('This market expires on');
            });
            if (detailsLoaded) {
              console.log(`      ↳ Details content loaded in ${i + 1}s`);
              break;
            }
          }
          
          if (!detailsLoaded) {
            throw new Error('Details tab content did not load after 5s');
          }
          
          // Extract maturity and assetBoost from Details tab
          detailData = await page.evaluate((assetName) => {
            const bodyText = document.body.innerText || document.body.textContent || '';
            
            const result = {
              assetBoost: null,
              maturity: null,
              debugInfo: null  // For debugging
            };
            
            const baseAssetMatch = assetName.match(/^(YT-[A-Za-z0-9*+\-]+?)-\d{2}[A-Z]{3}\d{2}$/i);
            if (!baseAssetMatch) {
              result.debugInfo = `Asset name pattern didn't match: ${assetName}`;
              return result;
            }
            
            const baseAsset = baseAssetMatch[1];
            
            // Extract maturity - handle timezone variations (GMT+5:30 or GMT+0)
            const fullMaturityPattern = /This market expires on ([A-Za-z]+\s+\d+,\s+\d{4})\s+at\s+(\d{1,2}:\d{2}\s+[AP]M)\s*\.?\s*(GMT[+-]\d{1,2}(?::\d{2})?)/i;
            const fullMatch = bodyText.match(fullMaturityPattern);
            
            const simpleMaturityPattern = /This market expires on (\d{1,2})\s+([A-Za-z]{3})\s+(\d{2})/i;
            const simpleMatch = bodyText.match(simpleMaturityPattern);
            
            if (fullMatch) {
              const datePart = fullMatch[1];
              const timePart = fullMatch[2];
              const timezone = fullMatch[3];
              
              result.maturityRaw = `${datePart} at ${timePart} ${timezone}`;
              
              const dateMatch = datePart.match(/([A-Za-z]+)\s+(\d+),\s+(\d{4})/);
              const timeMatch = timePart.match(/(\d{1,2}):(\d{2})\s+([AP]M)/i);
              
              if (dateMatch && timeMatch) {
                const monthNames = {
                  'january': '01', 'february': '02', 'march': '03', 'april': '04',
                  'may': '05', 'june': '06', 'july': '07', 'august': '08',
                  'september': '09', 'october': '10', 'november': '11', 'december': '12'
                };
                
                const monthStr = monthNames[dateMatch[1].toLowerCase()];
                const day = dateMatch[2].padStart(2, '0');
                const year = dateMatch[3];
                let hours = parseInt(timeMatch[1]);
                const minutes = timeMatch[2];
                const ampm = timeMatch[3].toUpperCase();
                
                if (ampm === 'PM' && hours !== 12) hours += 12;
                if (ampm === 'AM' && hours === 12) hours = 0;
                
                const tzMatch = timezone.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
                if (tzMatch) {
                  const tzSign = tzMatch[1];
                  const tzHours = parseInt(tzMatch[2]);
                  const tzMinutes = tzMatch[3] ? parseInt(tzMatch[3]) : 0; // Default to 0 if no minutes
                  const tzOffsetMinutes = (tzSign === '+' ? -1 : 1) * (tzHours * 60 + tzMinutes);
                  
                  const localDate = new Date(`${year}-${monthStr}-${day}T${hours.toString().padStart(2, '0')}:${minutes}:00`);
                  const utcDate = new Date(localDate.getTime() + tzOffsetMinutes * 60000);
                  
                  result.maturity = `${utcDate.getUTCFullYear()}-${(utcDate.getUTCMonth() + 1).toString().padStart(2, '0')}-${utcDate.getUTCDate().toString().padStart(2, '0')} ${utcDate.getUTCHours().toString().padStart(2, '0')}:${utcDate.getUTCMinutes().toString().padStart(2, '0')}:00 UTC`;
                }
              }
            } else if (simpleMatch) {
              const day = simpleMatch[1].padStart(2, '0');
              const monthAbbr = simpleMatch[2];
              const yearShort = simpleMatch[3];
              
              const monthMap = {
                'jan': '01', 'feb': '02', 'mar': '03', 'apr': '04',
                'may': '05', 'jun': '06', 'jul': '07', 'aug': '08',
                'sep': '09', 'oct': '10', 'nov': '11', 'dec': '12'
              };
              
              const monthStr = monthMap[monthAbbr.toLowerCase()];
              const year = '20' + yearShort;
              
              if (monthStr) {
                const hours = 10;
                const minutes = '30';
                const tzOffsetMinutes = -(5 * 60 + 30);
                
                const localDate = new Date(`${year}-${monthStr}-${day}T${hours}:${minutes}:00`);
                const utcDate = new Date(localDate.getTime() + tzOffsetMinutes * 60000);
                
                result.maturity = `${utcDate.getUTCFullYear()}-${(utcDate.getUTCMonth() + 1).toString().padStart(2, '0')}-${utcDate.getUTCDate().toString().padStart(2, '0')} ${utcDate.getUTCHours().toString().padStart(2, '0')}:${utcDate.getUTCMinutes().toString().padStart(2, '0')}:00 UTC`;
              }
            }
            
            // Extract assetBoost
            const escapedBaseAsset = baseAsset.replace(/[+*]/g, '\\$&');
            const boostPattern = new RegExp(`${escapedBaseAsset}\\s+\\w+\\s+(\\d+)x\\s+([^.\\n]+)`, 'i');
            const boostMatch = bodyText.match(boostPattern);
            
            if (boostMatch) {
              result.assetBoost = parseInt(boostMatch[1]);
            }
            
            return result;
          }, asset.asset);
          
          // Debug logging
          if (detailData && detailData.debugInfo) {
            console.log(`      ↳ Debug: ${detailData.debugInfo}`);
          }
          if (detailData && !detailData.maturity && !detailData.debugInfo) {
            // Extract a snippet of text around "expires" to see the actual format
            const bodySnippet = await page.evaluate(() => {
              const text = document.body.innerText;
              const idx = text.indexOf('expires');
              if (idx !== -1) {
                return text.substring(Math.max(0, idx - 50), Math.min(text.length, idx + 150));
              }
              return 'Text "expires" not found';
            });
            console.log(`      ↳ Extraction failed: maturity=${detailData.maturity}, assetBoost=${detailData.assetBoost}`);
            console.log(`      ↳ Text snippet: "${bodySnippet}"`);
          }
          
          if (detailData && detailData.maturity) {
            // Update asset with Phase 2 data
            asset.maturity = detailData.maturity;
            
            // Calculate precise decimal days for accurate YT metrics
            const preciseDays = calculateDaysToMaturity(asset.maturity, lastUpdated);
            asset.maturityDays = Math.floor(preciseDays); // For display
            asset.maturesIn = calculateMaturesIn(asset.maturity);
            
            // Always update assetBoost if we got it from detail page
            if (detailData.assetBoost) {
              asset.assetBoost = detailData.assetBoost;
            }
            
            // Set Exponent-specific ranges
            asset.rangeLower = asset.apy;
            asset.rangeUpper = null;
            
            // Recalculate YT metrics with Exponent formula and precise days
            const ytMetrics = calculateYtMetrics(
              asset.maturity,
              asset.impliedYield,
              asset.rangeLower,
              asset.rangeUpper,
              lastUpdated,
              asset.leverage,
              asset.apy,
              preciseDays,
              asset.assetBoost,
              'exponent'
            );
            
            Object.assign(asset, ytMetrics);
            
            console.log(`  ✅ ${asset.asset}: Maturity ${asset.maturity}, Boost ${asset.assetBoost}x, YT Current ${ytMetrics.ytPriceCurrent}`);
            
            break;
          }
        } catch (urlError) {
          const elapsedTime = startTime ? ((Date.now() - startTime) / 1000).toFixed(1) : '0.0';
          console.warn(`  ⚠️ Failed at ${elapsedTime}s - ${urlError.message}`);
          continue;
        }
      }
      
      if (!detailData || !detailData.maturity) {
        // Use OLD gist data if detail scraping failed
        console.warn(`  ⚠️ Failed to fetch ${asset.asset}, using fallback data`);
        
        const oldAsset = existingGistData[asset.asset];
        if (oldAsset && oldAsset.maturity) {
          asset.maturity = oldAsset.maturity;
          asset.maturityDays = Math.floor(calculateDaysToMaturity(asset.maturity, lastUpdated));
          asset.maturesIn = calculateMaturesIn(asset.maturity);
          asset.rangeLower = asset.apy;
          asset.rangeUpper = null;
          
          if (oldAsset.assetBoost) {
            asset.assetBoost = oldAsset.assetBoost;
          }
          
          const ytMetrics = calculateYtMetrics(
            asset.maturity,
            asset.impliedYield,
            asset.rangeLower,
            asset.rangeUpper,
            lastUpdated,
            asset.leverage,
            asset.apy,
            asset.maturityDays,
            asset.assetBoost,
            'exponent'
          );
          
          Object.assign(asset, ytMetrics);
          console.log(`  📊 Using cached data for ${asset.asset}`);
        }
      }
      
    } catch (error) {
      console.error(`  ❌ Error processing ${asset.asset}:`, error.message);
    }
  }
  
  console.log('✅ Exponent Phase 2 complete');
  return assets;
}

