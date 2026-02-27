/**
 * CR Alert Checker for Vercel Serverless Functions — Multi-User
 * 
 * Standalone version (can't import from server/).
 * Reads all subscribers from the alerts Gist, evaluates per-user thresholds,
 * sends Telegram/email alerts, and persists state.
 * 
 * Triggered non-blocking from api/xsol-metrics.js on page load.
 * 
 * Re-alert policy per user:
 *   Email    — ONE per threshold breach. No more until full reset (CR >= 148%).
 *   Telegram — Once on breach + repeat every 24 hours while still below.
 * 
 * Reset policy:
 *   All alert states reset ONLY when CR recovers above 148%.
 */

const TELEGRAM_API = 'https://api.telegram.org';

const DEFAULT_THRESHOLDS = [140, 135, 130, 110];
const CR_RESET_LEVEL = 1.48;
const DEFAULT_REALERT_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours (default fallback)

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildThresholdConfigs(thresholdPercents) {
  const sorted = [...thresholdPercents].sort((a, b) => b - a);
  return sorted.map(pct => {
    const value = pct / 100;
    const label = `${pct}%`;
    const key = `cr_${pct}`;

    let severity, messageText;
    if (pct <= 110) {
      severity = 'critical';
      messageText = 'Be cautious on HYUSD peg';
    } else if (pct <= 130) {
      severity = 'high';
      messageText = 'Be cautious on sHYUSD loops, sHYUSD price is going to decrease';
    } else if (pct <= 135) {
      severity = 'medium';
      messageText = 'Be cautious on sHYUSD loops, sHYUSD price can decrease anytime';
    } else {
      severity = 'low';
      messageText = 'Be cautious on sHYUSD loops';
    }

    return {
      key, value, label, severity,
      message: (cr) => `Hylo projects Collateral Ratio (CR) is ${(cr * 100).toFixed(1)}% which is below ${label}, ${messageText}`,
    };
  });
}

function defaultAlertStateForThresholds(thresholds) {
  const state = {};
  for (const t of thresholds) {
    state[t.key] = { active: false, lastTelegram: null, lastEmail: null, emailSent: false };
  }
  return state;
}

function hasActiveAlerts(alertState) {
  for (const key of Object.keys(alertState)) {
    if (key.startsWith('_')) continue;
    if (alertState[key]?.active) return true;
  }
  return false;
}

function findMostSevereBreached(cr, thresholds) {
  let most = null;
  for (const t of thresholds) {
    if (cr < t.value && (!most || t.value < most.value)) most = t;
  }
  return most;
}

// ─── Notification senders ────────────────────────────────────────────────────

async function sendTelegram(message, chatId) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken || !chatId) return false;

  try {
    const res = await fetch(`${TELEGRAM_API}/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId, text: message,
        parse_mode: 'Markdown', disable_web_page_preview: true,
      }),
    });
    return res.ok;
  } catch (e) {
    console.warn('Telegram send failed:', e.message);
    return false;
  }
}

async function sendEmail(subject, body, to) {
  if (!to) return false;
  const fromEmail = process.env.ALERT_FROM_EMAIL || 'alerts@hylo.app';

  // Try SendGrid
  if (process.env.SENDGRID_API_KEY) {
    try {
      const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.SENDGRID_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from: { email: fromEmail, name: 'Hylo Alerts' },
          subject, content: [{ type: 'text/plain', value: body }],
        }),
      });
      if (r.status === 202 || r.ok) return true;
    } catch {}
  }

  // Try Mailgun
  if (process.env.MAILGUN_API_KEY && process.env.MAILGUN_DOMAIN) {
    try {
      const form = new URLSearchParams();
      form.append('from', `Hylo Alerts <${fromEmail}>`);
      form.append('to', to); form.append('subject', subject); form.append('text', body);
      const r = await fetch(`https://api.mailgun.net/v3/${process.env.MAILGUN_DOMAIN}/messages`, {
        method: 'POST',
        headers: { 'Authorization': `Basic ${Buffer.from(`api:${process.env.MAILGUN_API_KEY}`).toString('base64')}` },
        body: form,
      });
      if (r.ok) return true;
    } catch {}
  }

  // Try Resend
  if (process.env.RESEND_API_KEY) {
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: `Hylo Alerts <${fromEmail}>`, to: [to], subject, text: body,
        }),
      });
      if (r.ok) return true;
    } catch {}
  }

  return false;
}

// ─── Alerts Gist helpers ─────────────────────────────────────────────────────

async function fetchAlertsGist() {
  const alertsGistId = process.env.ALERTS_GIST_ID;
  const gistToken = process.env.GIST_TOKEN;
  if (!alertsGistId || !gistToken) return null;

  try {
    const res = await fetch(`https://api.github.com/gists/${alertsGistId}`, {
      headers: {
        'Authorization': `token ${gistToken}`,
        'User-Agent': 'Hylo-CR-Monitor-Vercel',
      },
    });
    if (!res.ok) return null;
    const gist = await res.json();
    const content = gist.files?.['cr-alert-subscribers.json']?.content;
    return content ? JSON.parse(content) : null;
  } catch {
    return null;
  }
}

async function persistAlertsGist(data) {
  const alertsGistId = process.env.ALERTS_GIST_ID;
  const gistToken = process.env.GIST_TOKEN;
  if (!alertsGistId || !gistToken) return;

  try {
    await fetch(`https://api.github.com/gists/${alertsGistId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `token ${gistToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Hylo-CR-Monitor-Vercel',
      },
      body: JSON.stringify({
        files: {
          'cr-alert-subscribers.json': {
            content: JSON.stringify(data, null, 2),
          },
        },
      }),
    });
  } catch (err) {
    console.warn('Failed to persist alerts Gist:', err.message);
  }
}

// ─── Per-user evaluation ────────────────────────────────────────────────────

async function evaluateForUser(cr, subscriber, thresholds) {
  const chatId = subscriber.chatId;
  const existingAlertState = subscriber.alertState || {};
  const defaults = defaultAlertStateForThresholds(thresholds);
  const state = { ...defaults, ...JSON.parse(JSON.stringify(existingAlertState)) };
  const now = new Date();
  const nowMs = now.getTime();

  // ── Reset check: CR >= 148% ──
  if (cr >= CR_RESET_LEVEL) {
    if (hasActiveAlerts(state)) {
      for (const t of thresholds) {
        const e = state[t.key];
        if (e && (e.active || e.emailSent)) {
          e.active = false; e.lastTelegram = null; e.lastEmail = null;
          e.emailSent = false; e.recoveredAt = now.toISOString();
        }
      }
    }
    state._lastCR = cr; state._lastChecked = now.toISOString();
    return state;
  }

  // ── Above all user thresholds but below reset ──
  const highestThreshold = Math.max(...thresholds.map(t => t.value));
  if (cr >= highestThreshold) {
    state._lastCR = cr; state._lastChecked = now.toISOString();
    return state;
  }

  // ── Find most severe ──
  const mostSevere = findMostSevereBreached(cr, thresholds);
  if (!mostSevere) {
    state._lastCR = cr; state._lastChecked = now.toISOString();
    return state;
  }

  if (!state[mostSevere.key]) {
    state[mostSevere.key] = { active: false, lastTelegram: null, lastEmail: null, emailSent: false };
  }

  const entry = state[mostSevere.key];
  const msg = mostSevere.message(cr);
  const isFirstBreach = !entry.active;
  const emoji = { critical: '🚨', high: '🔴', medium: '🟠', low: '🟡' }[mostSevere.severity];

  // ── Telegram: first breach OR user-configured re-alert ──
  const reAlertIntervalMs = ((subscriber.reAlertIntervalHours || 24) * 60 * 60 * 1000);
  const telegramDue = isFirstBreach ||
    (entry.lastTelegram && (nowMs - new Date(entry.lastTelegram).getTime()) >= reAlertIntervalMs);

  if (telegramDue) {
    const intervalHrs = subscriber.reAlertIntervalHours || 24;
    const intervalLabel = intervalHrs >= 24 && intervalHrs % 24 === 0 ? `${intervalHrs / 24}d` : `${intervalHrs}h`;
    const reAlertTag = isFirstBreach ? '' : `\n🔁 _${intervalLabel} re-alert_`;
    await sendTelegram(
      `${emoji} *CR ALERT — Below ${mostSevere.label}*\n\n${msg}\n\n📊 Current CR: *${(cr * 100).toFixed(1)}%*\n⏰ ${now.toISOString()}${reAlertTag}`,
      chatId
    );
    entry.lastTelegram = now.toISOString();
  }

  // ── Email: ONE per breach cycle ──
  if (isFirstBreach && !entry.emailSent && subscriber.email) {
    const sent = await sendEmail(`⚠️ Hylo CR Alert — Below ${mostSevere.label}`, msg, subscriber.email);
    if (sent) {
      entry.lastEmail = now.toISOString();
      entry.emailSent = true;
    }
  }

  if (!entry.active) entry.active = true;

  // Mark less severe thresholds as active
  for (const t of thresholds) {
    if (cr < t.value && t.key !== mostSevere.key) {
      if (!state[t.key]) state[t.key] = { active: false, lastTelegram: null, lastEmail: null, emailSent: false };
      state[t.key].active = true;
    }
  }

  state._lastCR = cr; state._lastChecked = now.toISOString();
  return state;
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Check CR thresholds for all subscribers. Non-blocking — errors caught internally.
 * @param {number} cr - CollateralRatio from Hylo API
 */
export async function checkCRThresholdsVercel(cr) {
  if (cr == null) return;

  try {
    let alertsData = await fetchAlertsGist();
    if (!alertsData || !alertsData.subscribers) {
      console.warn('Could not read alerts Gist — skipping CR check to avoid data loss');
      return;
    }

    const keys = Object.keys(alertsData.subscribers);
    if (keys.length === 0) return;

    let stateChanged = false;
    for (const key of keys) {
      const sub = alertsData.subscribers[key];
      if (!sub.active) continue;

      try {
        const userThresholds = buildThresholdConfigs(sub.thresholds || DEFAULT_THRESHOLDS);
        const newState = await evaluateForUser(cr, sub, userThresholds);
        if (JSON.stringify(newState) !== JSON.stringify(sub.alertState || {})) {
          sub.alertState = newState;
          stateChanged = true;
        }
      } catch (err) {
        console.warn(`CR check failed for subscriber ${sub.chatId}:`, err.message);
      }
    }

    if (stateChanged) {
      await persistAlertsGist(alertsData);
    }
  } catch (err) {
    console.warn('CR check failed (non-blocking):', err.message);
  }
}
