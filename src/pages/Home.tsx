import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BarChart3, Calculator, ArrowRight, TrendingUp, Shield, DollarSign, Activity } from 'lucide-react';
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
      <div className="home-container">
        {/* Hero Section */}
        <div className="home-hero">
          <h1 className="home-title">
            Hylo Community Toolkit
          </h1>
          <p className="home-subtitle">
            Comprehensive tools for analyzing and calculating yields/points for all Exponent/Rate-X available tokens
          </p>
        </div>

        {/* Navigation Cards - Row 1: Dashboard + xSOL Metrics */}
        <div className="home-cards">
          {/* Strategy Dashboard Card */}
          <Link to="/dashboard" className="home-card home-card-dashboard">
            <div className="home-card-icon">
              <BarChart3 size={48} />
            </div>
            <div className="home-card-content">
              <h2 className="home-card-title">YT's Strategy/Risk Dashboard</h2>
              <p className="home-card-description">
                Monitor leveraged yield positions with comprehensive risk analysis, 
                upside potential, downside risk, and projected points earnings.
              </p>
              <ul className="home-card-features">
                <li>
                  <Shield size={16} />
                  <span>Live market metrics and analysis</span>
                </li>
                <li>
                  <TrendingUp size={16} />
                  <span>Track upside potential & downside risk</span>
                </li>
                <li>
                  <BarChart3 size={16} />
                  <span>Monitor all assets in one place</span>
                </li>
              </ul>
            </div>
            <div className="home-card-action">
              <span>View Dashboard</span>
              <ArrowRight size={20} />
            </div>
          </Link>

          {/* xSOL Metrics Card */}
          <Link to="/xsol-metrics" className="home-card home-card-xsol">
            <div className="home-card-icon">
              {xsolIconUrl ? (
                <img src={xsolIconUrl} alt="xSOL" style={{ width: 48, height: 48, borderRadius: '50%' }} />
              ) : (
                <TrendingUp size={48} />
              )}
            </div>
            <div className="home-card-content">
              <h2 className="home-card-title">xSOL Metrics & Break-Even</h2>
              <p className="home-card-description">
                Track real-time xSOL protocol metrics including collateral ratio, 
                effective leverage, and calculate your break-even price.
              </p>
              <ul className="home-card-features">
                <li>
                  <Activity size={16} />
                  <span>Live protocol metrics from blockchain</span>
                </li>
                <li>
                  <DollarSign size={16} />
                  <span>Real-time xSOL & SOL prices</span>
                </li>
                <li>
                  <Calculator size={16} />
                  <span>Break-even price calculator</span>
                </li>
              </ul>
            </div>
            <div className="home-card-action">
              <span>View Metrics</span>
              <ArrowRight size={20} />
            </div>
          </Link>
        </div>

        {/* Navigation Cards - Row 2: Calculator (Centered) */}
        <div className="home-cards home-cards-centered">
          {/* Yield Calculator Card */}
          <Link to="/calculator" className="home-card home-card-calculator">
            <div className="home-card-icon">
              <Calculator size={48} />
            </div>
            <div className="home-card-content">
              <h2 className="home-card-title">YT Yield/Point Calculator</h2>
              <p className="home-card-description">
                Calculate expected yield returns or points for your leveraged yield token positions. 
                Enter parameters manually or fetch live data from Exponent/Rate-X.
              </p>
              <ul className="home-card-features">
                <li>
                  <Calculator size={16} />
                  <span>Manual & auto-fetch modes</span>
                </li>
                <li>
                  <TrendingUp size={16} />
                  <span>Gross & net yield calculations</span>
                </li>
                <li>
                  <BarChart3 size={16} />
                  <span>Expected points projections</span>
                </li>
              </ul>
            </div>
            <div className="home-card-action">
              <span>Open Calculator</span>
              <ArrowRight size={20} />
            </div>
          </Link>
        </div>

        {/* Footer Info */}
        <div className="home-footer">
          <p className="home-footer-text">
            Data is automatically updated every 5 minutes. If data is older than 10 minutes when someone visits, a hard refresh (1-2 minutes) updates all metrics to ensure accuracy.
          </p>
        </div>
      </div>
    </div>
  );
};

export default Home;
