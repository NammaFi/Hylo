import React, { useState, useEffect, useCallback } from 'react';
import { Bell, Plus, Check, ExternalLink, Loader2 } from 'lucide-react';
import '../App.css';
import '../components/Dashboard.css';

const API_BASE = import.meta.env.DEV ? 'http://localhost:3000' : '';

// Default threshold values (greyed placeholders)
const DEFAULT_THRESHOLDS = [140, 135, 130, 110];

type ConnectionStatus = 'idle' | 'generating' | 'waiting' | 'connected' | 'error';

const CRAlerts: React.FC = () => {
  // Connection state
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('idle');
  const [refCode, setRefCode] = useState<string | null>(null);
  const [botLink, setBotLink] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Threshold state
  const [thresholds, setThresholds] = useState<(number | string)[]>([...DEFAULT_THRESHOLDS]);
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [initialThresholds, setInitialThresholds] = useState<number[]>([...DEFAULT_THRESHOLDS]);

  // Re-alert interval state
  const [reAlertValue, setReAlertValue] = useState<number | string>(24);
  const [reAlertUnit, setReAlertUnit] = useState<'hours' | 'days'>('hours');
  const [initialReAlertHours, setInitialReAlertHours] = useState<number>(24);

  // ─── Generate ref code and open bot link ────────────────────────────────────

  const handleSetupTelegram = async () => {
    setConnectionStatus('generating');
    setErrorMessage(null);

    try {
      const res = await fetch(`${API_BASE}/api/cr-subscribe?action=generate-ref`);
      const data = await res.json();

      if (!res.ok || !data.refCode) {
        throw new Error(data.error || 'Failed to generate link');
      }

      setRefCode(data.refCode);
      setBotLink(data.botLink);
      setConnectionStatus('waiting');

      // Open bot link in new tab
      window.open(data.botLink, '_blank');
    } catch (err: unknown) {
      setConnectionStatus('error');
      setErrorMessage(err instanceof Error ? err.message : 'Something went wrong');
    }
  };

  // ─── Poll for connection status ─────────────────────────────────────────────

  const checkStatus = useCallback(async () => {
    if (!refCode) return;

    try {
      const res = await fetch(`${API_BASE}/api/cr-subscribe?action=check-status&refCode=${refCode}`);
      const data = await res.json();

      if (data.connected) {
        setConnectionStatus('connected');
        if (data.thresholds && Array.isArray(data.thresholds)) {
          setThresholds(data.thresholds);
          setInitialThresholds(data.thresholds);
        }
        // Populate re-alert interval from server
        const intervalHours = data.reAlertIntervalHours || 24;
        setInitialReAlertHours(intervalHours);
        if (intervalHours >= 24 && intervalHours % 24 === 0) {
          setReAlertValue(intervalHours / 24);
          setReAlertUnit('days');
        } else {
          setReAlertValue(intervalHours);
          setReAlertUnit('hours');
        }
      }
    } catch {
      // Silently retry
    }
  }, [refCode]);

  useEffect(() => {
    if (connectionStatus !== 'waiting' || !refCode) return;

    const interval = setInterval(checkStatus, 3000);
    // Stop polling after 5 minutes
    const timeout = setTimeout(() => {
      clearInterval(interval);
      if (connectionStatus === 'waiting') {
        setConnectionStatus('error');
        setErrorMessage('Connection timed out. Please try again.');
      }
    }, 5 * 60 * 1000);

    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, [connectionStatus, refCode, checkStatus]);

  // ─── Threshold management ──────────────────────────────────────────────────

  const updateThreshold = (index: number, value: string) => {
    const updated = [...thresholds];
    updated[index] = value === '' ? '' : Number(value) || value;
    setThresholds(updated);
  };

  const removeThreshold = (index: number) => {
    if (thresholds.length <= 1) return;
    setThresholds(thresholds.filter((_, i) => i !== index));
  };

  const addThreshold = () => {
    setThresholds([...thresholds, '']);
  };

  const saveThresholds = async () => {
    if (!refCode) return;

    const validThresholds = thresholds
      .map(t => Number(t))
      .filter(t => !isNaN(t) && t >= 100 && t <= 200);

    if (validThresholds.length === 0) {
      setErrorMessage('Please enter at least one valid threshold (100-200%)');
      return;
    }

    setIsSaving(true);
    setSaveSuccess(false);
    setErrorMessage(null);

    // Convert re-alert to hours
    const reAlertHours = reAlertUnit === 'days' ? Number(reAlertValue) * 24 : Number(reAlertValue);
    if (isNaN(reAlertHours) || reAlertHours < 1 || reAlertHours > 720) {
      setErrorMessage('Re-alert interval must be between 1 hour and 30 days');
      setIsSaving(false);
      return;
    }

    try {
      const res = await fetch(`${API_BASE}/api/cr-subscribe?action=save-thresholds&refCode=${refCode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ thresholds: validThresholds, refCode, reAlertIntervalHours: reAlertHours }),
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to save thresholds');
      }

      setThresholds(data.thresholds);
      setInitialThresholds(data.thresholds);
      setInitialReAlertHours(reAlertHours);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setIsSaving(false);
    }
  };

  // Compute current re-alert interval in hours for comparison
  const currentReAlertHours = reAlertUnit === 'days' ? Number(reAlertValue) * 24 : Number(reAlertValue);

  const hasChanges = JSON.stringify(
    thresholds.map(t => Number(t)).filter(t => !isNaN(t)).sort((a, b) => b - a)
  ) !== JSON.stringify([...initialThresholds].sort((a, b) => b - a))
    || currentReAlertHours !== initialReAlertHours;

  // ─── Severity helpers ──────────────────────────────────────────────────────

  const getSeverityInfo = (pct: number) => {
    if (pct <= 110) return { emoji: '🚨', color: '#ef4444', label: 'Critical — HYUSD peg at risk' };
    if (pct <= 130) return { emoji: '🔴', color: '#f97316', label: 'High — sHYUSD price going to decrease' };
    if (pct <= 135) return { emoji: '🟠', color: '#eab308', label: 'Medium — sHYUSD price can decrease' };
    return { emoji: '🟡', color: '#a3e635', label: 'Low — Caution on sHYUSD loops' };
  };

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="cr-page dashboard-page">
      <div className="cr-inner">

        {/* Page Header */}
        <div className="cr-header">
          <div className="cr-header-icon">
            <Bell size={24} />
          </div>
          <h1 className="cr-page-title">
            <Bell size={28} style={{ color: '#8b5cf6', WebkitTextFillColor: 'initial' }} />
            Hylo CR Alerts
          </h1>
          <div className="cr-desc">Get notified on Telegram when the Collateral Ratio drops below your thresholds</div>
        </div>

        {/* Main Card */}
        <div className="cr-main-card">

          {/* Section 1: Connect Telegram */}
          <div style={{ marginBottom: connectionStatus === 'connected' ? '2rem' : '0' }}>
            <div className="cr-section-title">1. Connect Telegram</div>
            <div className="cr-section-desc">
              Click the button below to open our alert bot in Telegram. Press <strong style={{ color: '#e2e8f0' }}>Start</strong> in&nbsp;the&nbsp;bot to continue.
            </div>

            {connectionStatus === 'idle' && (
              <button className="tg-setup-btn" onClick={handleSetupTelegram}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/>
                </svg>
                <div>
                  <div className="tg-btn-main">Set Up Telegram Alerts</div>
                  <div className="tg-btn-sub">Opens the bot in Telegram — press Start in bot to Continue</div>
                </div>
              </button>
            )}

            {connectionStatus === 'generating' && (
              <div className="cr-status-banner waiting">
                <Loader2 size={20} className="cr-spinner" />
                <div>
                  <div className="cr-status-main">Generating link...</div>
                </div>
              </div>
            )}

            {connectionStatus === 'waiting' && (
              <div>
                <div className="cr-status-banner waiting">
                  <Loader2 size={20} className="cr-spinner" />
                  <div>
                    <div className="cr-status-main">Waiting for you to press Start in the bot...</div>
                    <div className="cr-status-sub">This page will update automatically</div>
                  </div>
                </div>
                {botLink && (
                  <a href={botLink} target="_blank" rel="noopener noreferrer" className="cr-fallback-link">
                    <ExternalLink size={14} />
                    Didn't open? Click here to open the bot
                  </a>
                )}
              </div>
            )}

            {connectionStatus === 'connected' && (
              <div className="cr-status-banner connected">
                <Check size={20} />
                <div>
                  <div className="cr-status-main">Connected ✓</div>
                  <div className="cr-status-sub">You'll receive CR alerts on Telegram</div>
                </div>
              </div>
            )}

            {connectionStatus === 'error' && (
              <div>
                <div className="cr-status-banner error">
                  ⚠️ {errorMessage || 'Something went wrong'}
                </div>
                <button
                  onClick={() => { setConnectionStatus('idle'); setErrorMessage(null); }}
                  className="add-alert-btn"
                  style={{ marginTop: '8px' }}
                >
                  Try Again
                </button>
              </div>
            )}
          </div>

          {/* Section 2: Configure Thresholds (revealed after connecting) */}
          {connectionStatus === 'connected' && (
            <div>
              <div className="cr-divider" />

              <div className="cr-section-title">2. Configure Alert Thresholds</div>
              <div className="cr-section-desc">
                You'll receive a Telegram alert when the Collateral Ratio drops below any of these levels.
                Alerts reset when CR recovers above 148%.
              </div>

              {/* Threshold Inputs */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '16px' }}>
                {thresholds.map((threshold, index) => {
                  const numValue = Number(threshold);
                  const isValid = !isNaN(numValue) && numValue >= 100 && numValue <= 200;
                  const severity = isValid ? getSeverityInfo(numValue) : null;
                  const defaultVal = DEFAULT_THRESHOLDS[index];
                  const severityClass = isValid && threshold !== '' ? (
                    numValue <= 110 ? 'critical' : numValue <= 130 ? 'high' : numValue <= 135 ? 'medium' : 'low'
                  ) : '';

                  return (
                    <div key={index} className="threshold-row">
                      <div className={`threshold-input-box ${severityClass}`}>
                        <div className="ti-prefix">Alert {index + 1}</div>
                        <input
                          type="number"
                          className="ti-input"
                          value={threshold}
                          onChange={(e) => updateThreshold(index, e.target.value)}
                          placeholder={defaultVal ? String(defaultVal) : '140'}
                          min={100}
                          max={200}
                          step={1}
                        />
                        <span className="ti-suffix">%</span>
                      </div>

                      {/* Severity tag */}
                      {severity && threshold !== '' && (
                        <div className={`severity-tag ${severityClass}`}>
                          {severity.emoji} {numValue <= 110 ? 'Critical' : numValue <= 130 ? 'High' : numValue <= 135 ? 'Medium' : 'Low'}
                        </div>
                      )}

                      {/* Remove button */}
                      {thresholds.length > 1 && (
                        <div
                          className="threshold-remove"
                          onClick={() => removeThreshold(index)}
                          title="Remove this threshold"
                          role="button"
                          tabIndex={0}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') removeThreshold(index); }}
                        >
                          ✕
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Add More Button */}
              <button className="add-alert-btn" onClick={addThreshold}>
                <Plus size={14} />
                Add Alert Level
              </button>

              {/* Re-alert Interval */}
              <div className="realert-group">
                <div className="realert-label">Repeat alert every</div>
                <div className="realert-row">
                  <div className="realert-input-wrap">
                    <input
                      type="number"
                      className="realert-input"
                      value={reAlertValue}
                      onChange={(e) => setReAlertValue(e.target.value === '' ? '' : Number(e.target.value))}
                      min={1}
                      max={reAlertUnit === 'days' ? 30 : 720}
                      step={1}
                    />
                  </div>
                  <select
                    className="realert-select"
                    value={reAlertUnit}
                    onChange={(e) => {
                      const newUnit = e.target.value as 'hours' | 'days';
                      const currentVal = Number(reAlertValue) || 1;
                      if (newUnit === 'days' && reAlertUnit === 'hours') {
                        setReAlertValue(Math.max(1, Math.round(currentVal / 24)));
                      } else if (newUnit === 'hours' && reAlertUnit === 'days') {
                        setReAlertValue(currentVal * 24);
                      }
                      setReAlertUnit(newUnit);
                    }}
                  >
                    <option value="hours">Hours</option>
                    <option value="days">Days</option>
                  </select>
                  <span className="realert-hint">while CR stays below</span>
                </div>
              </div>

              {/* Save Button */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
                <button
                  className={`cr-save-btn ${hasChanges && !isSaving ? 'active' : 'disabled'}`}
                  onClick={saveThresholds}
                  disabled={isSaving || !hasChanges}
                >
                  {isSaving ? (
                    <Loader2 size={16} className="cr-spinner" />
                  ) : (
                    <Check size={16} />
                  )}
                  {isSaving ? 'Saving...' : 'Save Settings'}
                </button>

                {saveSuccess && (
                  <span style={{ color: '#34d399', fontSize: '13px' }}>✓ Saved successfully</span>
                )}

                {errorMessage && connectionStatus === 'connected' && (
                  <span style={{ color: '#fca5a5', fontSize: '13px' }}>⚠️ {errorMessage}</span>
                )}
              </div>

              {/* Info Note */}
              <div className="cr-info-note">
                <div style={{ fontWeight: 600, color: '#c4b5fd', marginBottom: '8px' }}>
                  How alerts work
                </div>
                <ul style={{ margin: 0, paddingLeft: '20px', listStyleType: 'disc' }}>
                  <li>CR is checked every 5–10 minutes or whenever you open the tool (free-tier limits)</li>
                  <li>Telegram: alert on first breach, then repeats at your chosen interval while CR stays below</li>
                  <li>All alerts reset when CR recovers above 148%</li>
                  <li>Email alerts coming soon (one-time per breach, resets on recovery)</li>
                </ul>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default CRAlerts;
