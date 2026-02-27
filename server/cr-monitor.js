/**
 * CR (Collateral Ratio) Monitor — Multi-User
 * 
 * Checks xSOL metrics CollateralRatio against per-user thresholds and
 * triggers Telegram + email alerts for each subscribed user.
 * 
 * Subscriber data is stored in a separate secret Gist (ALERTS_GIST_ID).
 * Admin (TELEGRAM_CHAT_ID env var) always receives alerts as fallback.
 * 
 * Default thresholds (users can customise):
 *   CR < 1.40 (140%) — caution on sHYUSD loops
 *   CR < 1.35 (135%) — sHYUSD price can decrease anytime
 *   CR < 1.30 (130%) — sHYUSD price is going to decrease
 *   CR < 1.10 (110%) — caution on HYUSD peg
 * 
 * Re-alert policy (per user):
 *   Email    — ONE per threshold breach. No more until full reset (CR >= 148%).
 *   Telegram — Once on breach + repeat every 24 hours while still below.
 * 
 * Reset policy:
 *   All alert states reset ONLY when CR recovers above 148%.
 */

import { sendTelegramAlert, sendEmailWithFallback } from './notifications.js';

// ─── Alerts Gist helpers ─────────────────────────────────────────────────────

/**
 * Fetch subscribers from the alerts Gist via GitHub API (not raw, to avoid caching)
 */
async function fetchAlertsGist(alertsGistId, gistToken) {
  if (!alertsGistId || !gistToken) return null;

  try {
    const res = await fetch(`https://api.github.com/gists/${alertsGistId}`, {
      headers: {
        'Authorization': `token ${gistToken}`,
        'User-Agent': 'Hylo-CR-Monitor',
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

/**
 * Persist updated subscribers data back to the alerts Gist
 */
async function persistAlertsGist(data, alertsGistId, gistToken) {
  if (!alertsGistId || !gistToken) return;

  try {
    const res = await fetch(`https://api.github.com/gists/${alertsGistId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `token ${gistToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Hylo-CR-Monitor',
      },
      body: JSON.stringify({
        files: {
          'cr-alert-subscribers.json': {
            content: JSON.stringify(data, null, 2),
          },
        },
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error('❌ Failed to persist alerts Gist:', res.status, errText);
    } else {
      console.log('✅ Alerts Gist persisted');
    }
  } catch (err) {
    console.error('❌ Error persisting alerts Gist:', err.message);
  }
}

// ─── Configuration ──────────────────────────────────────────────────────────

const DEFAULT_THRESHOLDS = [140, 135, 130, 110];

/**
 * Build threshold config from a percentage array (e.g. [140, 135, 130, 110])
 */
function buildThresholdConfigs(thresholdPercents) {
  const sorted = [...thresholdPercents].sort((a, b) => b - a); // highest first
  return sorted.map(pct => {
    const value = pct / 100;
    const label = `${pct}%`;
    const key = `cr_${pct}`;

    let severity, messageText;
    if (pct <= 110) {
      severity = 'critical';
      messageText = `Be cautious on HYUSD peg`;
    } else if (pct <= 130) {
      severity = 'high';
      messageText = `Be cautious on sHYUSD loops, sHYUSD price is going to decrease`;
    } else if (pct <= 135) {
      severity = 'medium';
      messageText = `Be cautious on sHYUSD loops, sHYUSD price can decrease anytime`;
    } else {
      severity = 'low';
      messageText = `Be cautious on sHYUSD loops`;
    }

    return {
      key,
      value,
      label,
      severity,
      message: (cr) => `Hylo projects Collateral Ratio (CR) is ${(cr * 100).toFixed(1)}% which is below ${label}, ${messageText}`,
    };
  });
}

// CR must recover above this level to reset ALL alert states
const CR_RESET_LEVEL = 1.48;

// Default Telegram re-alert interval (fallback when user hasn't customized)
const DEFAULT_REALERT_INTERVAL = 24 * 60 * 60 * 1000;

function formatIntervalLabel(hours) {
  if (hours >= 24 && hours % 24 === 0) return `${hours / 24}d`;
  return `${hours}h`;
}

// ─── Core per-user logic ────────────────────────────────────────────────────

function defaultAlertStateForThresholds(thresholds) {
  const state = {};
  for (const t of thresholds) {
    state[t.key] = {
      active: false,
      lastTelegram: null,
      lastEmail: null,
      emailSent: false,
    };
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

function findMostSevereBreachedThreshold(currentCR, thresholds) {
  let mostSevere = null;
  for (const threshold of thresholds) {
    if (currentCR < threshold.value) {
      if (!mostSevere || threshold.value < mostSevere.value) {
        mostSevere = threshold;
      }
    }
  }
  return mostSevere;
}

/**
 * Evaluate CR against a single user's thresholds and send notifications.
 * Returns updated alertState for the user.
 */
async function evaluateForUser(currentCR, subscriber, thresholds) {
  const chatId = subscriber.chatId;
  const existingAlertState = subscriber.alertState || {};

  // Build default state including any custom threshold keys the user may have
  const defaults = defaultAlertStateForThresholds(thresholds);
  const state = { ...defaults, ...JSON.parse(JSON.stringify(existingAlertState)) };
  const now = new Date();
  const nowMs = now.getTime();

  // ── Reset check: CR >= 148% resets everything ──
  if (currentCR >= CR_RESET_LEVEL) {
    if (hasActiveAlerts(state)) {
      console.log(`  ✅ [${chatId}] CR above ${(CR_RESET_LEVEL * 100).toFixed(0)}% — resetting ALL alerts`);
      for (const t of thresholds) {
        const entry = state[t.key];
        if (entry && (entry.active || entry.emailSent)) {
          entry.active = false;
          entry.lastTelegram = null;
          entry.lastEmail = null;
          entry.emailSent = false;
          entry.recoveredAt = now.toISOString();
        }
      }
    }
    state._lastCR = currentCR;
    state._lastChecked = now.toISOString();
    return state;
  }

  // ── CR above all user thresholds but below reset level ──
  const highestThreshold = Math.max(...thresholds.map(t => t.value));
  if (currentCR >= highestThreshold) {
    state._lastCR = currentCR;
    state._lastChecked = now.toISOString();
    return state;
  }

  // ── Find MOST SEVERE breached threshold for this user ──
  const mostSevere = findMostSevereBreachedThreshold(currentCR, thresholds);
  if (!mostSevere) {
    state._lastCR = currentCR;
    state._lastChecked = now.toISOString();
    return state;
  }

  // Ensure the state entry exists for this threshold key
  if (!state[mostSevere.key]) {
    state[mostSevere.key] = { active: false, lastTelegram: null, lastEmail: null, emailSent: false };
  }

  const entry = state[mostSevere.key];
  const msg = mostSevere.message(currentCR);
  const emoji =
    mostSevere.severity === 'critical' ? '🚨' :
    mostSevere.severity === 'high' ? '🔴' :
    mostSevere.severity === 'medium' ? '🟠' : '🟡';
  const isFirstBreach = !entry.active;

  // ── Telegram: first breach OR user-configured re-alert interval ──
  const reAlertIntervalMs = ((subscriber.reAlertIntervalHours || 24) * 60 * 60 * 1000);
  const telegramDue = isFirstBreach ||
    (entry.lastTelegram && (nowMs - new Date(entry.lastTelegram).getTime()) >= reAlertIntervalMs);

  if (telegramDue) {
    const intervalLabel = formatIntervalLabel(subscriber.reAlertIntervalHours || 24);
    const reAlertTag = isFirstBreach ? '' : `\n🔁 _${intervalLabel} re-alert_`;
    const telegramMsg = `${emoji} *CR ALERT — Below ${mostSevere.label}*\n\n${msg}\n\n📊 Current CR: *${(currentCR * 100).toFixed(1)}%*\n⏰ ${now.toISOString()}${reAlertTag}`;
    await sendTelegramAlert(telegramMsg, chatId);
    entry.lastTelegram = now.toISOString();
    console.log(`  📱 [${chatId}] Telegram alert sent for CR < ${mostSevere.label}`);
  }

  // ── Email: ONE per breach cycle ──
  if (isFirstBreach && !entry.emailSent && subscriber.email) {
    const subject = `⚠️ Hylo CR Alert — Below ${mostSevere.label}`;
    await sendEmailWithFallback(subject, msg, subscriber.email);
    entry.lastEmail = now.toISOString();
    entry.emailSent = true;
    console.log(`  📧 [${chatId}] Email sent for CR < ${mostSevere.label}`);
  }

  // Mark active
  entry.active = true;

  // Also mark all less severe thresholds as active
  for (const t of thresholds) {
    if (currentCR < t.value && t.key !== mostSevere.key) {
      if (!state[t.key]) state[t.key] = { active: false, lastTelegram: null, lastEmail: null, emailSent: false };
      state[t.key].active = true;
    }
  }

  state._lastCR = currentCR;
  state._lastChecked = now.toISOString();
  return state;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Main entry point: check CR thresholds for all subscribers and send alerts.
 * Also sends admin alert to TELEGRAM_CHAT_ID as fallback.
 */
export async function checkCRAndAlert(collateralRatio, opts = {}) {
  const gistToken = opts.gistToken || process.env.GIST_TOKEN;
  const alertsGistId = opts.alertsGistId || process.env.ALERTS_GIST_ID;

  if (collateralRatio === null || collateralRatio === undefined) {
    console.warn('⚠️ CR monitor: collateralRatio is null/undefined, skipping');
    return;
  }

  console.log(`\n🔍 CR Monitor: CR = ${(collateralRatio * 100).toFixed(1)}% | Reset at ${(CR_RESET_LEVEL * 100).toFixed(0)}%`);

  // Read alerts Gist — if read fails, abort (never overwrite with empty data)
  const alertsData = await fetchAlertsGist(alertsGistId, gistToken);
  if (!alertsData || !alertsData.subscribers) {
    console.warn('⚠️ Could not read alerts Gist — skipping CR check to avoid data loss');
    return;
  }

  const subscriberKeys = Object.keys(alertsData.subscribers);
  if (subscriberKeys.length === 0) {
    console.log('ℹ️ No subscribers found — nothing to do');
    return;
  }

  console.log(`📢 Processing ${subscriberKeys.length} subscriber(s)`);

  for (const key of subscriberKeys) {
    const sub = alertsData.subscribers[key];
    if (!sub.active) continue;

    try {
      const userThresholds = buildThresholdConfigs(sub.thresholds || DEFAULT_THRESHOLDS);
      sub.alertState = await evaluateForUser(collateralRatio, sub, userThresholds);
    } catch (err) {
      console.error(`  ❌ [${sub.chatId}] Alert evaluation failed:`, err.message);
    }
  }

  // Persist all subscriber states in one write
  await persistAlertsGist(alertsData, alertsGistId, gistToken);
}

/**
 * Get a human-readable CR status string (used by Telegram /cr command)
 */
export function formatCRStatus(cr) {
  const percent = (cr * 100).toFixed(1);
  let status = '🟢 Healthy';
  let detail = 'All clear — no threshold breached.';

  if (cr < 1.10) {
    status = '🚨 CRITICAL';
    detail = 'Below 110% — HYUSD peg at risk!';
  } else if (cr < 1.30) {
    status = '🔴 DANGER';
    detail = 'Below 130% — sHYUSD price is going to decrease.';
  } else if (cr < 1.35) {
    status = '🟠 WARNING';
    detail = 'Below 135% — sHYUSD price can decrease anytime.';
  } else if (cr < 1.40) {
    status = '🟡 CAUTION';
    detail = 'Below 140% — Be cautious on sHYUSD loops.';
  }

  return `📊 *Collateral Ratio: ${percent}%*\n\nStatus: ${status}\n${detail}`;
}

export { DEFAULT_THRESHOLDS, CR_RESET_LEVEL, buildThresholdConfigs };
