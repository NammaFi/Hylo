import React from 'react';
import { Info } from 'lucide-react';
import type { AssetData } from '../services/ratexApi';
import Timer from './Timer';
import { RateXIcon, AssetBoostIcon } from './Icons';
import './Dashboard.css';

interface AssetCardProps {
  asset: AssetData;
  depositAmount?: number;
}

// Helper to format large numbers (K, M, B)
const formatLargeNumber = (num: number | null): string => {
  if (num === null || num === undefined) return 'N/A';
  if (num < 1000) return num.toFixed(2);
  if (num < 1000000) return (num / 1000).toFixed(1) + 'K';
  if (num < 1000000000) return (num / 1000000).toFixed(1) + 'M';
  return (num / 1000000000).toFixed(1) + 'B';
};

// Helper to format percentage
const formatPercent = (num: number | null, decimals: number = 2): string => {
  if (num === null || num === undefined) return 'N/A';
  return `${num.toFixed(decimals)}%`;
};

// Split a formatted number into integer + decimal parts
const splitNumber = (num: number | null, decimals: number = 2): { int: string; dec: string } => {
  if (num === null || num === undefined) return { int: 'N/A', dec: '' };
  const str = num.toFixed(decimals);
  const dot = str.indexOf('.');
  if (dot === -1) return { int: str, dec: '' };
  return { int: str.slice(0, dot), dec: str.slice(dot) };
};

// Helper to format price with appropriate decimals
const formatPrice = (price: number | null | undefined): string => {
  if (price === null || price === undefined) return 'N/A';
  if (price < 0.01) return price.toFixed(4);
  if (price < 0.1) return price.toFixed(3);
  return price.toFixed(2);
};

const AssetCard: React.FC<AssetCardProps> = ({ asset, depositAmount = 1 }) => {
  // Calculate Expected Recovery Yield
  const calculateExpectedRecoveryYield = (): number | null => {
    if (asset.expectedRecoveryYield !== null) return asset.expectedRecoveryYield;
    const { leverage, apy, maturityDays, source } = asset;
    if (leverage && apy && maturityDays) {
      const apyDecimal = apy / 100;
      const grossYield = leverage * (Math.pow(1 + apyDecimal, 1 / 365) - 1) * 365 * (maturityDays / 365) * 100;
      const feeMultiplier = source === 'exponent' ? 0.945 : 0.95;
      return grossYield * feeMultiplier;
    }
    return null;
  };

  const expectedRecoveryYield = calculateExpectedRecoveryYield();

  // Price range
  const priceRange =
    asset.ytPriceLower !== null && asset.ytPriceLower > 0 && asset.ytPriceUpper !== null && asset.ytPriceUpper > 0
      ? `${formatPrice(asset.ytPriceLower)} – ${formatPrice(asset.ytPriceUpper)}`
      : asset.ytPriceLower !== null && asset.ytPriceLower > 0
        ? `${formatPrice(asset.ytPriceLower)} – N/A`
        : 'N/A';

  // Split primary metric values
  const lev = splitNumber(asset.leverage);
  const iy = splitNumber(asset.impliedYield);
  const apyVal = splitNumber(asset.apy);

  // Display name (strip YT- prefix for exponent)
  const displayName = asset.source === 'exponent' && asset.asset.startsWith('YT-')
    ? asset.asset.substring(3)
    : asset.asset;

  return (
    <div className="ac">
      {/* Card Body */}
      <div className="ac-body">

        {/* Header: icon + name + badges */}
        <div className="ac-header">
          <div className="ac-identity">
            <div className="ac-icon">
              {asset.assetSymbolImage ? (
                <img src={asset.assetSymbolImage} alt={asset.asset} />
              ) : (
                <span>{(asset.baseAsset || asset.asset).charAt(0).toUpperCase()}</span>
              )}
            </div>
            <div className="ac-name-block">
              <div className="ac-name">{displayName}</div>
              <Timer
                maturesIn={asset.maturesIn}
                maturityDate={asset.maturity}
                maturityDays={asset.maturityDays}
              />
            </div>
          </div>
          <div className="ac-badges">
            <span className={`ac-badge-source ${asset.source === 'ratex' ? 'ac-badge-ratex' : 'ac-badge-exponent'}`}>
              {asset.source === 'ratex' ? 'Rate-X' : 'Exponent'}
            </span>
            {asset.assetBoost !== null && (
              <span className="ac-badge-boost">
                <AssetBoostIcon size={10} />
                {asset.assetBoost}× Asset
              </span>
            )}
            {asset.ratexBoost !== null && (
              <span className="ac-badge-boost ac-badge-boost-ratex">
                <RateXIcon size={10} />
                {asset.ratexBoost}× RateX
              </span>
            )}
          </div>
        </div>

        {/* Primary Metrics: Leverage / Implied Yield / APY */}
        <div className="ac-primary">
          <div className="pm-item leverage">
            <div className="pm-label">Leverage</div>
            <div className="pm-value">
              {lev.int}<span className="pm-dec">{lev.dec}</span><span className="pm-suffix">×</span>
            </div>
          </div>
          <div className="pm-item yield">
            <div className="pm-label">Implied Yield</div>
            <div className="pm-value">
              {iy.int}<span className="pm-dec">{iy.dec}</span><span className="pm-suffix">%</span>
            </div>
          </div>
          <div className="pm-item apy">
            <div className="pm-label">Underlying APY</div>
            <div className="pm-value">
              {apyVal.int}<span className="pm-dec">{apyVal.dec}</span><span className="pm-suffix">%</span>
            </div>
            <div className="pm-sub">7-day average</div>
          </div>
        </div>

        {/* Secondary Metrics: 2-col boxes */}
        <div className="ac-secondary">
          {/* Recovery + Decay */}
          <div className="sm-box">
            <div className="sm-half">
              <div className="sm-label">
                Recovery
                <span className="sm-info-dot">
                  <Info size={8} />
                  <span className="sm-tooltip">Total Recovery Yield if hold till maturity</span>
                </span>
              </div>
              <div className={`sm-value ${expectedRecoveryYield && expectedRecoveryYield > 0 ? 'success' : ''}`}>
                {formatPercent(expectedRecoveryYield)}
              </div>
            </div>
            <div className="sm-half">
              <div className="sm-label">
                Daily Decay
                <span className="sm-info-dot">
                  <Info size={8} />
                  <span className="sm-tooltip">Daily decay due to time at same Implied Yield</span>
                </span>
              </div>
              <div className={`sm-value ${asset.dailyDecayRate ? 'warning' : ''}`}>
                {formatPercent(asset.dailyDecayRate)}
              </div>
            </div>
          </div>

          {/* Last Day Value */}
          <div className="sm-box sm-box-shared-header">
            <div className="sm-shared-label">Last Day Value</div>
            <div className="sm-halves">
              <div className="sm-half">
                <div className="sm-value danger">{formatPercent(asset.endDayCurrentYield)}</div>
                <div className="sm-sub">Current IY</div>
              </div>
              <div className="sm-half">
                <div className="sm-value danger">{formatPercent(asset.endDayLowerYield)}</div>
                <div className="sm-sub">Lower IY</div>
              </div>
            </div>
          </div>
        </div>

        {/* Analysis Section */}
        <div className="ac-analysis">
          <div className="ac-analysis-header">Today's Analysis</div>
          <div className="ac-analysis-grid">
            <div className="ag-item">
              <div className="ag-label">Daily Yield</div>
              <div className={`ag-value ${asset.dailyYieldRate && asset.dailyYieldRate > 0 ? 'success' : ''}`}>{formatPercent(asset.dailyYieldRate, 2)}</div>
            </div>
            <div className="ag-item">
              <div className="ag-label">Downside Risk</div>
              <div className="ag-value danger">{formatPercent(asset.downsideRisk, 1)}</div>
            </div>
            <div className="ag-item">
              <div className="ag-label">Price Range</div>
              <div className="ag-value purple">{priceRange}</div>
            </div>
          </div>
        </div>
      </div>

      {/* Points Footer Bar */}
      <div className="ac-points-bar">
        <div className="pf-metric">
          <div className="pf-label">Expected Points/Day</div>
          <div className="pf-value">{formatLargeNumber((asset.expectedPointsPerDay || 0) * depositAmount)}</div>
        </div>
        <div className="pf-divider"></div>
        <div className="pf-metric pf-right">
          <div className="pf-label">Total Expected Points</div>
          <div className="pf-value">{formatLargeNumber((asset.totalExpectedPoints || 0) * depositAmount)}</div>
        </div>
      </div>
    </div>
  );
};

export default AssetCard;
