// Ported verbatim from server/scraper.js (calculateMaturesIn, calculateDaysToMaturity,
// formatYtPrice, formatPercentage, calculateYtPrice, calculateYtPriceExponent,
// calculateYtMetrics) — pure Date/Math, no Node APIs, so it runs unmodified in Workers.
// Keep in sync with server/scraper.js if that logic ever changes.

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

    const days = diffMs / (24 * 60 * 60 * 1000);

    return days;
  } catch (error) {
    console.warn('Error calculating days to maturity:', error.message);
    return null;
  }
}

function formatYtPrice(value) {
  if (value === null || value === undefined) return null;

  const absValue = Math.abs(value);

  if (absValue >= 1.0) return parseFloat(value.toFixed(3));
  if (absValue >= 0.1) return parseFloat(value.toFixed(4));
  if (absValue >= 0.01) return parseFloat(value.toFixed(5));
  if (absValue >= 0.001) return parseFloat(value.toFixed(6));
  if (absValue >= 0.0001) return parseFloat(value.toFixed(7));
  return parseFloat(value.toFixed(8));
}

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

    if (diffMs <= 0) return 0;

    const T = diffMs / (365 * 24 * 60 * 60 * 1000);
    const r = yieldRate / 100;
    const ytPrice = 1 - Math.pow(1 + r, -T);

    return formatYtPrice(ytPrice);
  } catch (error) {
    console.warn(`Error calculating YT price:`, error.message);
    return null;
  }
}

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

    if (diffMs <= 0) return 0;

    const T = diffMs / (365 * 24 * 60 * 60 * 1000);
    const r = yieldRate / 100;

    const ytPrice = (r * T) / (1 + (r * T));

    return formatYtPrice(ytPrice);
  } catch (error) {
    console.warn(`Error calculating Exponent YT price:`, error.message);
    return null;
  }
}

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

    const currentT = diffMs / (365 * 24 * 60 * 60 * 1000);

    const calculatePrice = source === 'exponent' ? calculateYtPriceExponent : calculateYtPrice;

    result.ytPriceCurrent = calculatePrice(maturity, impliedYield, lastUpdated);
    result.ytPriceLower = calculatePrice(maturity, rangeLower, lastUpdated);
    result.ytPriceUpper = calculatePrice(maturity, rangeUpper, lastUpdated);

    if (leverage !== null && leverage !== undefined && apy !== null && apy !== undefined) {
      const apyDecimal = apy / 100;
      const feeMultiplier = source === 'exponent' ? 0.945 : 0.95;
      const dailyYield = leverage * (Math.pow(1 + apyDecimal, 1/365) - 1) * 100 * feeMultiplier;
      result.dailyYieldRate = formatPercentage(dailyYield);
    }

    if (result.ytPriceCurrent && result.ytPriceLower) {
      const downside = ((result.ytPriceCurrent - result.ytPriceLower) / result.ytPriceCurrent) * 100;
      result.downsideRisk = formatPercentage(downside);
    }

    if (currentT <= 1/365) {
      result.dailyDecayRate = 100;
      result.endDayCurrentYield = 0;
      result.endDayLowerYield = 0;

      if (leverage !== null && leverage !== undefined && apy !== null && apy !== undefined) {
        const apyDecimal = apy / 100;
        const grossYield = leverage * (Math.pow(1 + apyDecimal, 1/365) - 1) * 365 * (1/365) * 100;
        const feeMultiplier = source === 'exponent' ? 0.945 : 0.95;
        const netYield = grossYield * feeMultiplier;
        result.expectedRecoveryYield = formatPercentage(netYield);
      }

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

    if (impliedYield !== null && impliedYield !== undefined) {
      if (source === 'exponent') {
        const tomorrowDate = new Date(new Date(lastUpdated).getTime() + 24 * 60 * 60 * 1000);
        const ytToday = result.ytPriceCurrent;
        const ytTomorrow = calculateYtPriceExponent(maturity, impliedYield, tomorrowDate.toISOString());
        if (ytToday && ytTomorrow) {
          const decay = ((ytToday - ytTomorrow) / ytToday) * 100;
          result.dailyDecayRate = formatPercentage(decay);
        }
      } else {
        const tomorrowT = currentT - (1/365);
        const r = impliedYield / 100;
        const ytToday = 1 - Math.pow(1 + r, -currentT);
        const ytTomorrow = 1 - Math.pow(1 + r, -tomorrowT);
        const decay = ((ytToday - ytTomorrow) / ytToday) * 100;
        result.dailyDecayRate = formatPercentage(decay);
      }
    }

    const T_oneDay = 1 / 365;

    if (impliedYield !== null && impliedYield !== undefined && result.ytPriceCurrent) {
      const r_current = impliedYield / 100;
      const ytEndCurrentYield = 1 - Math.pow(1 + r_current, -T_oneDay);
      const remainingCurrentYield = (ytEndCurrentYield / result.ytPriceCurrent) * 100;
      result.endDayCurrentYield = formatPercentage(remainingCurrentYield);
    }

    if (rangeLower !== null && rangeLower !== undefined && result.ytPriceCurrent) {
      const r_lower = rangeLower / 100;
      const ytEndLowerYield = 1 - Math.pow(1 + r_lower, -T_oneDay);
      const remainingLowerYield = (ytEndLowerYield / result.ytPriceCurrent) * 100;
      result.endDayLowerYield = formatPercentage(remainingLowerYield);
    }

    const preciseDays = calculateDaysToMaturity(maturity, lastUpdated);
    const daysToUse = preciseDays !== null ? preciseDays : maturityDays;

    if (leverage !== null && leverage !== undefined && apy !== null && apy !== undefined && daysToUse !== null && daysToUse !== undefined && daysToUse > 0) {
      const apyDecimal = apy / 100;
      const grossYield = leverage * (Math.pow(1 + apyDecimal, 1/365) - 1) * 365 * (daysToUse/365) * 100;
      const feeMultiplier = source === 'exponent' ? 0.945 : 0.95;
      const netYield = grossYield * feeMultiplier;
      result.expectedRecoveryYield = formatPercentage(netYield);
    }

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
  } catch (error) {
    console.warn(`Error calculating YT metrics:`, error.message);
    return result;
  }
}
