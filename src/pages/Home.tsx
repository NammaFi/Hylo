import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BarChart3, Calculator, ArrowRight, TrendingUp, Bell } from 'lucide-react';
import { checkAndRefreshIfStale } from '../services/ratexApi';
import '../components/Dashboard.css';

const GIST_RAW_URL = 'https://gist.githubusercontent.com/NammaFi/d3a1db6fc79e168cf5dff8d3a2c11706/raw/ratex-assets.json';

const Home: React.FC = () => {
  const [xsolIconUrl, setXsolIconUrl] = useState<string | null>(null);

  // Check data freshness on mount
  useEffect(() => {
    checkAndRefreshIfStale();
  }, []);

  // Fetch xSOL icon URL from Gist
  useEffect(() => {
    const fetchXsolIcon = async () => {
      try {
        const response = await fetch(GIST_RAW_URL, { cache: 'no-cache' });
        if (response.ok) {
          const data = await response.json();
          const xsolAsset = data.assets?.find((a: { baseAsset?: string }) => a.baseAsset === 'xSOL');
          if (xsolAsset?.assetSymbolImage) {
            setXsolIconUrl(xsolAsset.assetSymbolImage);
          }
        }
      } catch (error) {
        console.warn('Failed to fetch xSOL icon:', error);
      }
    };
    fetchXsolIcon();
  }, []);

  return (
    <div className="home-page">
      <div className="home-inner" style={{ textAlign: 'center' }}>

        {/* Hero Title */}
        <h1 className="hero-title">
          <span className="home-title-brand">Hylo</span><br />
          <span className="home-title-white">Community Toolkit</span>
        </h1>

        {/* Hero Subtitle */}
        <p className="hero-sub">
          Analyze leveraged positions, calculate yield, track xSOL protocol metrics, and set collateral ratio alerts — all in one place.
        </p>

        {/* CTA Buttons */}
        <div className="hero-btns">
          <Link to="/dashboard" className="hero-btn hero-btn-primary">Open Dashboard →</Link>
          <Link to="/xsol-metrics" className="hero-btn hero-btn-secondary">xSOL Metrics</Link>
        </div>

        {/* Tool Cards Row */}
        <div className="tool-cards-row">

          {/* Strategy Dashboard */}
          <Link to="/dashboard" className="tool-card violet-stripe">
            <div className="tc-top">
              <div className="tc-icon violet">
                <BarChart3 size={20} />
              </div>
              <span className="tc-badge live">Live data</span>
            </div>
            <div className="tc-title">Strategy Dashboard</div>
            <div className="tc-desc">Real-time yield positions across Rate-X and Exponent with advanced filtering, risk scoring, and points projections.</div>
            <ul className="tc-features">
              <li><span className="check">✓</span> Live leverage &amp; implied yield metrics</li>
              <li><span className="check">✓</span> Upside / downside risk analysis</li>
              <li><span className="check">✓</span> Expected points per day projections</li>
            </ul>
            <div className="tc-link violet-link">Open Strategy <ArrowRight size={14} /></div>
          </Link>

          {/* xSOL Metrics */}
          <Link to="/xsol-metrics" className="tool-card teal-stripe">
            <div className="tc-top">
              <div className="tc-icon teal">
                {xsolIconUrl ? (
                  <img src={xsolIconUrl} alt="xSOL" style={{ width: 20, height: 20, borderRadius: '50%' }} />
                ) : (
                  <TrendingUp size={20} />
                )}
              </div>
              <span className="tc-badge realtime">Protocol</span>
            </div>
            <div className="tc-title">xSOL Metrics</div>
            <div className="tc-desc">Protocol-level data for the Hylo xSOL token including collateral ratios, supply, leverage, and break-even calculator.</div>
            <ul className="tc-features">
              <li><span className="check">✓</span> Real-time collateral ratio &amp; TVL</li>
              <li><span className="check">✓</span> Stability pool xSOL tracking</li>
              <li><span className="check">✓</span> Phase-aware break-even calculator</li>
            </ul>
            <div className="tc-link teal-link">Open xSOL <ArrowRight size={14} /></div>
          </Link>

          {/* Yield Calculator */}
          <Link to="/calculator" className="tool-card amber-stripe">
            <div className="tc-top">
              <div className="tc-icon amber">
                <Calculator size={20} />
              </div>
              <span className="tc-badge new">Tool</span>
            </div>
            <div className="tc-title">Yield Calculator</div>
            <div className="tc-desc">Calculate gross and net yield returns for any Hylo-RateX position. Supports manual entry or auto-fetch from live data.</div>
            <ul className="tc-features">
              <li><span className="check">✓</span> Manual &amp; auto-fetch modes</li>
              <li><span className="check">✓</span> Gross &amp; net yield calculations</li>
              <li><span className="check">✓</span> Points projections at any deposit size</li>
            </ul>
            <div className="tc-link amber-link">Open Yield <ArrowRight size={14} /></div>
          </Link>

        </div>

        {/* CR Alerts Bottom Bar */}
        <Link to="/cr-alerts" className="cr-bottom-row">
          <div className="cr-row-left">
            <div className="cr-row-icon">
              <Bell size={18} />
            </div>
            <div>
              <div className="cr-row-title">CR Alerts</div>
              <div className="cr-row-desc">Get Telegram notifications when collateral ratio drops below your threshold</div>
            </div>
          </div>
          <div className="cr-row-link">Setup <ArrowRight size={14} /></div>
        </Link>

      </div>

      {/* Footer disclaimer — full-width at very bottom */}
      <div className="home-footer-text">
        Data is automatically updated every 5 minutes. If data is older than 10 minutes when someone visits, a hard refresh (1-2 minutes) updates all metrics to ensure accuracy.
      </div>
    </div>
  );
};

export default Home;
