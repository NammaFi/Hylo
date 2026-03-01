import React, { useState, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Home, BarChart3, Calculator, TrendingUp, Bell } from 'lucide-react';
import './Dashboard.css';

const GIST_RAW_URL = 'https://gist.githubusercontent.com/NammaFi/d3a1db6fc79e168cf5dff8d3a2c11706/raw/ratex-assets.json';

const Navbar: React.FC = () => {
  const location = useLocation();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [xsolIconUrl, setXsolIconUrl] = useState<string | null>(null);

  const isActive = (path: string) => {
    return location.pathname === path;
  };

  const toggleMobileMenu = () => {
    setIsMobileMenuOpen(!isMobileMenuOpen);
  };

  const closeMobileMenu = () => {
    setIsMobileMenuOpen(false);
  };

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

  // Prevent body scroll when mobile menu is open
  useEffect(() => {
    if (isMobileMenuOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    
    // Cleanup on unmount
    return () => {
      document.body.style.overflow = '';
    };
  }, [isMobileMenuOpen]);

  // Close mobile menu on route change
  useEffect(() => {
    setIsMobileMenuOpen(false);
  }, [location.pathname]);

  return (
    <>
      <nav className="navbar">
        <div className="navbar-container">
          <div className="navbar-brand">
            <h1 className="navbar-title">Hylo</h1>
            <span className="navbar-subtitle">Community Hub</span>
          </div>

          {/* Desktop Navigation Links */}
          <div className="navbar-links">
            <Link 
              to="/" 
              className={`navbar-link ${isActive('/') ? 'navbar-link-active' : ''}`}
            >
              <Home size={18} />
              <span>Home</span>
            </Link>

            <Link 
              to="/dashboard" 
              className={`navbar-link ${isActive('/dashboard') ? 'navbar-link-active' : ''}`}
            >
              <BarChart3 size={18} />
              <span>Strategy Dashboard</span>
            </Link>

            <Link 
              to="/xsol-metrics" 
              className={`navbar-link ${isActive('/xsol-metrics') ? 'navbar-link-active' : ''}`}
            >
              {xsolIconUrl ? (
                <img src={xsolIconUrl} alt="xSOL" style={{ width: 18, height: 18, borderRadius: '50%' }} />
              ) : (
                <TrendingUp size={18} />
              )}
              <span>xSOL Metrics</span>
            </Link>

            <Link 
              to="/calculator" 
              className={`navbar-link ${isActive('/calculator') ? 'navbar-link-active' : ''}`}
            >
              <Calculator size={18} />
              <span>Yield Calculator</span>
            </Link>

            <Link 
              to="/cr-alerts" 
              className={`navbar-link ${isActive('/cr-alerts') ? 'navbar-link-active' : ''}`}
            >
              <Bell size={18} />
              <span>CR Alerts</span>
            </Link>
          </div>

          {/* Hamburger Button (Mobile Only) */}
          <button 
            className={`navbar-hamburger ${isMobileMenuOpen ? 'active' : ''}`}
            onClick={toggleMobileMenu}
            aria-label="Toggle menu"
          >
            <span></span>
            <span></span>
            <span></span>
          </button>
        </div>
      </nav>

      {/* Mobile Menu Overlay - Now outside navbar as sibling */}
      <div className={`navbar-mobile-menu ${isMobileMenuOpen ? 'active' : ''}`}>
        <Link 
          to="/" 
          className={`navbar-link ${isActive('/') ? 'navbar-link-active' : ''}`}
          onClick={closeMobileMenu}
        >
          <Home size={24} />
          <span>Home</span>
        </Link>

        <Link 
          to="/dashboard" 
          className={`navbar-link ${isActive('/dashboard') ? 'navbar-link-active' : ''}`}
          onClick={closeMobileMenu}
        >
          <BarChart3 size={24} />
          <span>Strategy Dashboard</span>
        </Link>

        <Link 
          to="/xsol-metrics" 
          className={`navbar-link ${isActive('/xsol-metrics') ? 'navbar-link-active' : ''}`}
          onClick={closeMobileMenu}
        >
          {xsolIconUrl ? (
            <img src={xsolIconUrl} alt="xSOL" style={{ width: 24, height: 24, borderRadius: '50%' }} />
          ) : (
            <TrendingUp size={24} />
          )}
          <span>xSOL Metrics</span>
        </Link>

        <Link 
          to="/calculator" 
          className={`navbar-link ${isActive('/calculator') ? 'navbar-link-active' : ''}`}
          onClick={closeMobileMenu}
        >
          <Calculator size={24} />
          <span>Yield Calculator</span>
        </Link>

        <Link 
          to="/cr-alerts" 
          className={`navbar-link ${isActive('/cr-alerts') ? 'navbar-link-active' : ''}`}
          onClick={closeMobileMenu}
        >
          <Bell size={24} />
          <span>CR Alerts</span>
        </Link>
      </div>
    </>
  );
};

export default Navbar;
