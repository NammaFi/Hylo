import React, { useState, useEffect } from 'react';
import { TrendingUp, Pencil, Check, X, RefreshCw } from 'lucide-react';
import '../App.css';
import '../components/Dashboard.css';
import { 
  fetchXSolMetrics, 
  calculateXSolBreakEvenPrice,
  calculateXSolBreakEvenPriceWithSP,
  formatLargeNumber, 
  formatXSolPrice,
  type XSolMetrics as XSolMetricsData,
  type BreakEvenResult,
} from '../services/xsolMetricsApi';

// Editable field type
type EditableField = 'xSOL_price' | 'SOL_price' | 'xSOL_supply' | 'HYusd_supply' | null;

const XSolMetrics: React.FC = () => {
  const [metrics, setMetrics] = useState<XSolMetricsData | null>(null);
  const [originalMetrics, setOriginalMetrics] = useState<XSolMetricsData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [xsolIconUrl, setXsolIconUrl] = useState<string | null>(null);
  
  const [xSOL_buy_p, setXSOL_buy_p] = useState<string>('0');
  const [breakEvenPrice, setBreakEvenPrice] = useState<number>(0);
  const [breakEvenResult, setBreakEvenResult] = useState<BreakEvenResult | null>(null);

  // Editable fields state
  const [editingField, setEditingField] = useState<EditableField>(null);
  const [editValue, setEditValue] = useState<string>('');
  const [isCustomValues, setIsCustomValues] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string>('');

  // Format time ago
  const formatTimeAgo = (dateString: string): string => {
    if (!dateString) return '';
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    
    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins} min ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    return `${Math.floor(diffHours / 24)}d ago`;
  };

  // Recalculate derived metrics when base values change
  const recalculateMetrics = (updatedMetrics: XSolMetricsData): XSolMetricsData => {
    const { xSOL_supply, HYusd_supply, xSOL_price, SOL_price } = updatedMetrics;
    
    const Collateral_TVL = HYusd_supply + (xSOL_price * xSOL_supply);
    const Collateral_TVL_SOL = SOL_price > 0 ? Collateral_TVL / SOL_price : 0;
    const Effective_Leverage = (xSOL_price * xSOL_supply) > 0 ? Collateral_TVL / (xSOL_price * xSOL_supply) : 0;
    const CollateralRatio = HYusd_supply > 0 ? Collateral_TVL / HYusd_supply : 0;

    return {
      ...updatedMetrics,
      Collateral_TVL,
      Collateral_TVL_SOL,
      Effective_Leverage,
      CollateralRatio,
    };
  };

  // Format number with commas (e.g., 18000000 -> 18,000,000)
  const formatWithCommas = (num: number): string => {
    return Math.round(num).toLocaleString('en-US');
  };

  // Parse number string that may contain commas
  const parseWithCommas = (str: string): number => {
    return parseFloat(str.replace(/,/g, '')) || 0;
  };

  // Format value for editing based on field type
  const formatValueForEdit = (field: EditableField, value: number | undefined): string => {
    if (value === undefined || value === null) return '0';
    
    // For supply fields, show as integer with commas (e.g., 18,000,000)
    if (field === 'xSOL_supply' || field === 'HYusd_supply') {
      return formatWithCommas(value);
    }
    
    // For price fields, show 3 significant decimal digits
    // Find first non-zero decimal position and show 3 digits from there
    if (value === 0) return '0';
    
    const absValue = Math.abs(value);
    if (absValue >= 1) {
      // For values >= 1, just use 3 decimal places
      return value.toFixed(3);
    } else {
      // For values < 1, find first non-zero decimal and show 3 digits from there
      const str = value.toFixed(10);
      const decimalIndex = str.indexOf('.');
      let firstNonZero = -1;
      
      for (let i = decimalIndex + 1; i < str.length; i++) {
        if (str[i] !== '0') {
          firstNonZero = i - decimalIndex;
          break;
        }
      }
      
      if (firstNonZero === -1) return '0';
      
      // Show from first non-zero digit plus 2 more (3 total)
      const precision = firstNonZero + 2;
      return value.toFixed(precision);
    }
  };

  // Handle starting edit
  const startEdit = (field: EditableField, currentValue: number | undefined) => {
    setEditingField(field);
    setEditValue(formatValueForEdit(field, currentValue));
  };

  // Handle canceling edit
  const cancelEdit = () => {
    setEditingField(null);
    setEditValue('');
  };

  // Handle confirming edit
  const confirmEdit = () => {
    if (!metrics || !editingField) return;

    // Parse value - handle commas for supply fields
    const isSupplyField = editingField === 'xSOL_supply' || editingField === 'HYusd_supply';
    const newValue = isSupplyField ? parseWithCommas(editValue) : (parseFloat(editValue) || 0);
    const updatedMetrics = { ...metrics, [editingField]: newValue };
    const recalculated = recalculateMetrics(updatedMetrics);
    
    setMetrics(recalculated);
    setIsCustomValues(true);
    
    // Recalculate break-even price
    const purchasePrice = parseFloat(xSOL_buy_p) || 0;
    const bePrice = calculateXSolBreakEvenPrice(purchasePrice, recalculated);
    setBreakEvenPrice(bePrice);
    setBreakEvenResult(calculateXSolBreakEvenPriceWithSP(purchasePrice, recalculated));
    
    setEditingField(null);
    setEditValue('');
  };

  // Handle key press in edit input
  const handleEditKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      confirmEdit();
    } else if (e.key === 'Escape') {
      cancelEdit();
    }
  };

  // Reset to original values from Gist
  const resetToOriginal = () => {
    if (originalMetrics) {
      setMetrics(originalMetrics);
      setIsCustomValues(false);
      const purchasePrice = parseFloat(xSOL_buy_p) || 0;
      const bePrice = calculateXSolBreakEvenPrice(purchasePrice, originalMetrics);
      setBreakEvenPrice(bePrice);
      setBreakEvenResult(calculateXSolBreakEvenPriceWithSP(purchasePrice, originalMetrics));
    }
  };

  // Fetch metrics on mount
  useEffect(() => {
    const loadMetrics = async () => {
      setIsLoading(true);
      const data = await fetchXSolMetrics();
      
      if (data.metrics) {
        setMetrics(data.metrics);
        setOriginalMetrics(data.metrics);
        setLastUpdated(data.metrics.lastFetched || '');
        // Calculate initial break-even price with default purchase price (0)
        const bePrice = calculateXSolBreakEvenPrice(0, data.metrics);
        setBreakEvenPrice(bePrice);
        setBreakEvenResult(calculateXSolBreakEvenPriceWithSP(0, data.metrics));
      }
      
      setXsolIconUrl(data.xsolIconUrl);
      setError(data.error);
      setIsLoading(false);
    };

    loadMetrics();
  }, []);

  // Calculate break-even price whenever purchase price changes
  const handlePurchasePriceChange = (value: string) => {
    setXSOL_buy_p(value);
    
    if (metrics) {
      const purchasePrice = parseFloat(value) || 0;
      const bePrice = calculateXSolBreakEvenPrice(purchasePrice, metrics);
      setBreakEvenPrice(bePrice);
      setBreakEvenResult(calculateXSolBreakEvenPriceWithSP(purchasePrice, metrics));
    }
  };

  // Calculate step = place value of the second significant (non-zero) digit
  const stepForValue = (v: number | undefined | null): string => {
    if (!v || v === 0) return '0.01';
    const abs = Math.abs(v);
    const s = abs.toPrecision(15).replace(/0+$/, '');   // e.g. "1.0756"
    let count = 0;
    let lastPos = 0;
    const dotIdx = s.indexOf('.');
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '.' || ch === '-') continue;
      if (ch !== '0' || count > 0) {
        count++;
        // position relative to decimal: digits left of dot are positive powers, right are negative
        if (dotIdx === -1) {
          lastPos = s.length - 1 - i;          // integer: position from right
        } else if (i < dotIdx) {
          lastPos = dotIdx - 1 - i;             // left of dot
        } else {
          lastPos = -(i - dotIdx);              // right of dot (negative)
        }
        if (count === 2) return (10 ** lastPos).toFixed(Math.max(0, -lastPos));
      }
    }
    // Only one significant digit found – step one order smaller
    return (10 ** (lastPos - 1)).toFixed(Math.max(0, -(lastPos - 1)));
  };

  const getInputStep = (): string => stepForValue(metrics?.xSOL_price);

  return (
    <div className="xsol-page dashboard-page">
      <div className="xsol-inner">

        {/* Page Header */}
        <div className="xsol-header">
          <div className="xsol-icon-wrap">
            {xsolIconUrl ? (
              <img src={xsolIconUrl} alt="xSOL" />
            ) : (
              <TrendingUp size={28} style={{ color: '#2dd4bf' }} />
            )}
          </div>
          <h1 className="xsol-page-title">xSOL Metrics</h1>
          <div className="xsol-desc">Real-time protocol metrics and break-even price calculator</div>

          {/* Last Updated / Custom Values Banner */}
          {isCustomValues ? (
            <div className="xsol-custom-banner" onClick={resetToOriginal}>
              ⚠️ Using custom values. Click to reset
              <RefreshCw size={14} />
            </div>
          ) : (
            <div className="xsol-updated">Last updated: {formatTimeAgo(lastUpdated)}</div>
          )}
        </div>

        {/* Error Message */}
        {error && (
          <div className="xsol-error">⚠️ {error}</div>
        )}

        {/* Hero Metrics Row: 3 large cards */}
        <div className="xsol-hero-row" style={{ opacity: isLoading ? 0.5 : 1 }}>
          {/* Effective Leverage */}
          <div className="xm-hero green-stripe">
            <div className="xm-label">Effective Leverage</div>
            <div className="xm-value">
              {metrics?.Effective_Leverage ? `${metrics.Effective_Leverage.toFixed(2)}` : '—'}
              <span className="suffix">×</span>
            </div>
          </div>

          {/* xSOL Price - Editable */}
          <div className="xm-hero teal-stripe">
            <div className="xm-label">
              xSOL Price
              {editingField !== 'xSOL_price' && (
                <span
                  className="xm-edit-icon"
                  onClick={() => startEdit('xSOL_price', metrics?.xSOL_price)}
                >
                  <Pencil size={12} />
                </span>
              )}
            </div>
            {editingField === 'xSOL_price' ? (
              <div className="xm-edit-field">
                <Check size={18} style={{ color: '#10b981', cursor: 'pointer' }} onClick={confirmEdit} />
                <input
                  type="number"
                  className="xm-edit-input"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={handleEditKeyPress}
                  step={stepForValue(metrics?.xSOL_price)}
                  autoFocus
                />
                <X size={18} style={{ color: '#ef4444', cursor: 'pointer' }} onClick={cancelEdit} />
              </div>
            ) : (
              <div className="xm-value">
                <span className="suffix">$</span>{formatXSolPrice(metrics?.xSOL_price)}
              </div>
            )}
          </div>

          {/* SOL Price - Editable */}
          <div className="xm-hero teal-stripe">
            <div className="xm-label">
              SOL Price
              {editingField !== 'SOL_price' && (
                <span
                  className="xm-edit-icon"
                  onClick={() => startEdit('SOL_price', metrics?.SOL_price)}
                >
                  <Pencil size={12} />
                </span>
              )}
            </div>
            {editingField === 'SOL_price' ? (
              <div className="xm-edit-field">
                <Check size={18} style={{ color: '#10b981', cursor: 'pointer' }} onClick={confirmEdit} />
                <input
                  type="number"
                  className="xm-edit-input"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={handleEditKeyPress}
                  step={stepForValue(metrics?.SOL_price)}
                  autoFocus
                />
                <X size={18} style={{ color: '#ef4444', cursor: 'pointer' }} onClick={cancelEdit} />
              </div>
            ) : (
              <div className="xm-value">
                <span className="suffix">$</span>{formatXSolPrice(metrics?.SOL_price)}
              </div>
            )}
          </div>
        </div>

        {/* Mid Row: TVL + CR */}
        <div className="xsol-mid-row" style={{ opacity: isLoading ? 0.5 : 1 }}>
          {/* Collateral TVL (SOL) */}
          <div className="xm-mid">
            <div className="xm-mid-label">Collateral TVL (SOL)</div>
            <div className="xm-mid-value">{formatLargeNumber(metrics?.Collateral_TVL_SOL ?? null)}<span className="xm-mid-sub"> SOL</span></div>
            <div style={{ fontFamily: 'var(--f-mono)', fontSize: '10px', color: 'var(--muted)', marginTop: '4px' }}>
              ${formatLargeNumber(metrics?.Collateral_TVL ?? null)} USD
            </div>
          </div>

          {/* Collateral Ratio with Progress Bar */}
          <div className="xm-mid amber-bar">
            <div className="xm-mid-label">Collateral Ratio</div>
            <div className="xm-mid-value" style={{ color: metrics?.CollateralRatio && metrics.CollateralRatio * 100 > 150 ? 'var(--green)' : metrics?.CollateralRatio && metrics.CollateralRatio * 100 > 130 ? 'var(--amber)' : 'var(--red)' }}>
              {metrics?.CollateralRatio ? `${(metrics.CollateralRatio * 100).toFixed(1)}` : '—'}<span className="xm-mid-sub">%</span>
            </div>
            {metrics?.CollateralRatio && (
              <div className="cr-progress">
                <div className="cr-bar-track">
                  <div
                    className="cr-bar-fill"
                    style={{ width: `${Math.min(100, Math.max(0, ((metrics.CollateralRatio * 100 - 120) / 80) * 100))}%` }}
                  />
                </div>
                <div className="cr-bar-labels">
                  <span>120%</span>
                  <span style={{ fontWeight: 600, color: metrics.CollateralRatio * 100 > 150 ? 'var(--green)' : metrics.CollateralRatio * 100 > 130 ? 'var(--amber)' : 'var(--red)' }}>
                    {(metrics.CollateralRatio * 100).toFixed(1)}% (Now)
                  </span>
                  <span>200%+</span>
                </div>
              </div>
            )}
            <div className={`cr-status-badge ${
              metrics?.CollateralRatio && metrics.CollateralRatio * 100 > 150 ? 'healthy' :
              metrics?.CollateralRatio && metrics.CollateralRatio * 100 > 130 ? 'warning' : 'danger'
            }`}>
              {metrics?.CollateralRatio && metrics.CollateralRatio * 100 > 150 ? 'Protocol is healthy' :
               metrics?.CollateralRatio && metrics.CollateralRatio * 100 > 130 ? 'Warning zone' : 'Critical zone'}
            </div>
          </div>
        </div>

        {/* Supply Row: 4 small items */}
        <div className="xsol-supply-row" style={{ opacity: isLoading ? 0.5 : 1 }}>
          {/* xSOL Supply - Editable */}
          <div className="xs-item">
            <div className="xs-label">
              xSOL Supply
              {editingField !== 'xSOL_supply' && (
                <span
                  className="xm-edit-icon"
                  style={{ width: 16, height: 16 }}
                  onClick={() => startEdit('xSOL_supply', metrics?.xSOL_supply)}
                >
                  <Pencil size={10} />
                </span>
              )}
            </div>
            {editingField === 'xSOL_supply' ? (
              <div className="xs-edit-field">
                <Check size={14} style={{ color: '#10b981', cursor: 'pointer' }} onClick={confirmEdit} />
                <input
                  type="text"
                  className="xs-edit-input"
                  value={editValue}
                  onChange={(e) => {
                    const raw = e.target.value.replace(/[^0-9]/g, '');
                    if (raw) {
                      setEditValue(parseInt(raw, 10).toLocaleString('en-US'));
                    } else {
                      setEditValue('');
                    }
                  }}
                  onKeyDown={handleEditKeyPress}
                  autoFocus
                  placeholder="e.g., 18,000,000"
                />
                <X size={14} style={{ color: '#ef4444', cursor: 'pointer' }} onClick={cancelEdit} />
              </div>
            ) : (
              <div className="xs-value">{formatLargeNumber(metrics?.xSOL_supply ?? null)}</div>
            )}
          </div>

          {/* HYusd Supply - Editable */}
          <div className="xs-item">
            <div className="xs-label">
              HYusd Supply
              {editingField !== 'HYusd_supply' && (
                <span
                  className="xm-edit-icon"
                  style={{ width: 16, height: 16 }}
                  onClick={() => startEdit('HYusd_supply', metrics?.HYusd_supply)}
                >
                  <Pencil size={10} />
                </span>
              )}
            </div>
            {editingField === 'HYusd_supply' ? (
              <div className="xs-edit-field">
                <Check size={14} style={{ color: '#10b981', cursor: 'pointer' }} onClick={confirmEdit} />
                <input
                  type="text"
                  className="xs-edit-input"
                  value={editValue}
                  onChange={(e) => {
                    const raw = e.target.value.replace(/[^0-9]/g, '');
                    if (raw) {
                      setEditValue(parseInt(raw, 10).toLocaleString('en-US'));
                    } else {
                      setEditValue('');
                    }
                  }}
                  onKeyDown={handleEditKeyPress}
                  autoFocus
                  placeholder="Enter full number"
                />
                <X size={14} style={{ color: '#ef4444', cursor: 'pointer' }} onClick={cancelEdit} />
              </div>
            ) : (
              <div className="xs-value">{formatLargeNumber(metrics?.HYusd_supply ?? null)}</div>
            )}
          </div>

          {/* Collateral TVL (USD) */}
          <div className="xs-item">
            <div className="xs-label">Coll. TVL (USD)</div>
            <div className="xs-value">${formatLargeNumber(metrics?.Collateral_TVL ?? null)}</div>
          </div>

          {/* Stability Pool xSOL */}
          <div className="xs-item">
            <div className="xs-label">
              Stability Pool xSOL
              <span title="xSOL tokens held in the stability pool. When CR reaches 150%, these convert to HYusd to cap CR." style={{ cursor: 'help', opacity: 0.5 }}>ⓘ</span>
            </div>
            <div className="xs-value">{formatLargeNumber(metrics?.xSOL_sp ?? null)}</div>
            {metrics && metrics.xSOL_sp > 0 && metrics.xSOL_supply > 0 && (
              <div className="xs-sub">{((metrics.xSOL_sp / metrics.xSOL_supply) * 100).toFixed(1)}% of total supply</div>
            )}
          </div>
        </div>

        {/* Break-Even Calculator Section */}
        <div className="be-section-label">Break-Even Calculator</div>

        <div className="be-card">
          <div className="be-card-header">
            <div className="be-card-title">xSOL Break-Even Calculator</div>
            <div className="be-auto-badge">Auto-updating</div>
          </div>

          {/* Purchase Price Input */}
          <div className="be-input-group">
            <div className="be-input-label">xSOL Purchase Price (USD)</div>
            <div className="be-input-wrap">
              <span className="be-input-prefix">$</span>
              <input
                type="number"
                className="be-input"
                value={xSOL_buy_p}
                onChange={(e) => handlePurchasePriceChange(e.target.value)}
                step={getInputStep()}
                min="0"
                placeholder="0.00"
                disabled={!metrics}
              />
            </div>
            <div className="be-hint">Enter the price you paid for xSOL in USD</div>
          </div>

          {/* Result */}
          <div className="be-result">
            <div className="be-result-label">
              xSOL Break-Even SOL Price (USD)
              {breakEvenResult && breakEvenResult.phase === 'phase-B' && (
                <span className="be-phase-badge phase-B" style={{ marginLeft: '8px' }}>SP Adjusted</span>
              )}
            </div>
            <div className="be-result-value">
              <span className="be-result-dollar">$</span>
              <span className="be-result-num">
                {breakEvenResult ? formatXSolPrice(breakEvenResult.breakEvenPrice) : formatXSolPrice(breakEvenPrice)}
              </span>
            </div>

            {/* Phase badge */}
            {breakEvenResult && breakEvenResult.phase !== 'error' && parseFloat(xSOL_buy_p) > 0 && (
              <div className={`be-phase-badge ${
                breakEvenResult.phase === 'phase-0' ? 'phase-0' :
                breakEvenResult.phase === 'phase-A' ? 'phase-A' :
                breakEvenResult.phase === 'phase-B' ? 'phase-B' : 'normal'
              }`}>
                {breakEvenResult.phase === 'phase-0' && 'Normal (CR < 150%)'}
                {breakEvenResult.phase === 'phase-A' && 'During SP Conversion (CR = 150%)'}
                {breakEvenResult.phase === 'phase-B' && 'After SP Exhaustion'}
                {breakEvenResult.phase === 'normal' && 'Normal — No Stability Pool'}
              </div>
            )}

            <div className="be-result-desc">
              The SOL price at which you break even on your xSOL position
              {metrics?.Effective_Leverage ? `, based on the current effective leverage of ${metrics.Effective_Leverage.toFixed(2)}×` : ''}
            </div>
          </div>

          {/* SP Impact Details — Phase B with improvement */}
          {breakEvenResult && breakEvenResult.phase === 'phase-B' && breakEvenResult.improvement > 0 && parseFloat(xSOL_buy_p) > 0 && (
            <div className="be-sp-details">
              <div className="be-sp-row">
                <span className="be-sp-label">Without SP adjustment</span>
                <span className="be-sp-value">${formatXSolPrice(breakEvenResult.naiveBreakEvenPrice)}</span>
              </div>
              <div className="be-sp-row">
                <span className="be-sp-label">With SP adjustment</span>
                <span className="be-sp-value" style={{ color: 'var(--green)' }}>${formatXSolPrice(breakEvenResult.breakEvenPrice)}</span>
              </div>
              <div className="be-sp-row">
                <span className="be-sp-label">Improvement</span>
                <span className="be-sp-value" style={{ color: 'var(--green)' }}>-${formatXSolPrice(breakEvenResult.improvement)} lower</span>
              </div>
              <div className="be-sp-divider" />
              {breakEvenResult.activationSolPrice && (
                <div className="be-sp-row">
                  <span className="be-sp-label">SP Activation SOL Price</span>
                  <span className="be-sp-value">${formatXSolPrice(breakEvenResult.activationSolPrice)}</span>
                </div>
              )}
              {breakEvenResult.poolExhaustionSolPrice && (
                <div className="be-sp-row">
                  <span className="be-sp-label">SP Exhaustion SOL Price</span>
                  <span className="be-sp-value" style={{ color: 'var(--amber)' }}>${formatXSolPrice(breakEvenResult.poolExhaustionSolPrice)}</span>
                </div>
              )}
            </div>
          )}

          {/* SP Info for Phase 0/A — show activation/exhaustion prices */}
          {breakEvenResult && (breakEvenResult.phase === 'phase-0' || breakEvenResult.phase === 'phase-A') && breakEvenResult.activationSolPrice && parseFloat(xSOL_buy_p) > 0 && (
            <div className="be-sp-details">
              {breakEvenResult.activationSolPrice && (
                <div className="be-sp-row">
                  <span className="be-sp-label">SP Activation SOL Price</span>
                  <span className="be-sp-value">${formatXSolPrice(breakEvenResult.activationSolPrice)}</span>
                </div>
              )}
              {breakEvenResult.poolExhaustionSolPrice && (
                <div className="be-sp-row">
                  <span className="be-sp-label">SP Exhaustion SOL Price</span>
                  <span className="be-sp-value" style={{ color: 'var(--amber)' }}>${formatXSolPrice(breakEvenResult.poolExhaustionSolPrice)}</span>
                </div>
              )}
              <div className="be-sp-note">
                Break-even is reached before pool exhausts — no SP adjustment needed.
              </div>
            </div>
          )}
        </div>

        {/* Last Updated */}
        {metrics?.lastFetched && (
          <div className="xsol-last-updated">
            Last updated: {new Date(metrics.lastFetched).toLocaleString()}
          </div>
        )}

        {/* Loading Indicator */}
        {isLoading && (
          <div className="xsol-loading">Loading metrics...</div>
        )}

      </div>
    </div>
  );
};

export default XSolMetrics;
