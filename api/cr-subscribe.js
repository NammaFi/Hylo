/**
 * Vercel Serverless Function — CR Alert Subscription Management
 * 
 * Handles three actions via query param ?action=:
 *   generate-ref    — Create a unique ref code + deep link for Telegram bot
 *   check-status    — Poll whether a ref code has been claimed (user pressed Start)
 *   save-thresholds — Save custom thresholds for a connected user
 * 
 * All data stored in the alerts Gist (ALERTS_GIST_ID).
 * 
 * Environment variables:
 *   ALERTS_GIST_ID       — Secret Gist for subscriber data
 *   GIST_TOKEN           — GitHub token with Gist permissions
 */

// ─── Alerts Gist helpers ─────────────────────────────────────────────────────

async function fetchAlertsGist() {
  const alertsGistId = process.env.ALERTS_GIST_ID;
  const gistToken = process.env.GIST_TOKEN;
  if (!alertsGistId || !gistToken) return null;

  try {
    const res = await fetch(`https://api.github.com/gists/${alertsGistId}`, {
      headers: {
        'Authorization': `token ${gistToken}`,
        'User-Agent': 'Hylo-CR-Subscribe',
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
  if (!alertsGistId || !gistToken) return false;

  try {
    const res = await fetch(`https://api.github.com/gists/${alertsGistId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `token ${gistToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Hylo-CR-Subscribe',
      },
      body: JSON.stringify({
        files: {
          'cr-alert-subscribers.json': {
            content: JSON.stringify(data, null, 2),
          },
        },
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ─── Ref code generation ─────────────────────────────────────────────────────

function generateRefCode() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let code = 'ref_';
  for (let i = 0; i < 12; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// ─── Clean up expired pending refs (older than 24 hours) ─────────────────────

function cleanExpiredRefs(alertsData) {
  if (!alertsData.pendingRefs) return;
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  for (const [key, ref] of Object.entries(alertsData.pendingRefs)) {
    if (new Date(ref.createdAt).getTime() < oneDayAgo) {
      delete alertsData.pendingRefs[key];
    }
  }
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const action = req.query?.action || req.body?.action;

  if (!action) {
    return res.status(400).json({ error: 'Missing action parameter' });
  }

  // ─── generate-ref ──────────────────────────────────────────────────────────
  if (action === 'generate-ref') {
    let alertsData = await fetchAlertsGist();
    if (!alertsData) {
      alertsData = { subscribers: {}, pendingRefs: {} };
    }
    if (!alertsData.pendingRefs) alertsData.pendingRefs = {};

    // Clean up expired refs
    cleanExpiredRefs(alertsData);

    const refCode = generateRefCode();
    alertsData.pendingRefs[refCode] = {
      createdAt: new Date().toISOString(),
      claimed: false,
    };

    const saved = await persistAlertsGist(alertsData);
    if (!saved) {
      return res.status(500).json({ error: 'Failed to save ref code' });
    }

    const botUsername = 'HyloAlerts_Bot';
    const botLink = `https://t.me/${botUsername}?start=${refCode}`;

    return res.status(200).json({
      refCode,
      botLink,
    });
  }

  // ─── check-status ──────────────────────────────────────────────────────────
  if (action === 'check-status') {
    const refCode = req.query?.refCode || req.body?.refCode;
    if (!refCode) {
      return res.status(400).json({ error: 'Missing refCode parameter' });
    }

    const alertsData = await fetchAlertsGist();
    if (!alertsData) {
      return res.status(200).json({ connected: false });
    }

    const pending = alertsData.pendingRefs?.[refCode];
    if (!pending) {
      return res.status(200).json({ connected: false, error: 'Unknown ref code' });
    }

    if (pending.claimed) {
      // Find the subscriber by refCode
      const chatId = pending.claimedBy || null;
      const subscriber = chatId ? alertsData.subscribers?.[String(chatId)] : null;

      return res.status(200).json({
        connected: true,
        chatId: chatId,
        thresholds: subscriber?.thresholds || [140, 135, 130, 110],
        reAlertIntervalHours: subscriber?.reAlertIntervalHours || 24,
      });
    }

    return res.status(200).json({ connected: false });
  }

  // ─── save-thresholds ──────────────────────────────────────────────────────
  if (action === 'save-thresholds') {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'POST required for save-thresholds' });
    }

    const refCode = req.query?.refCode || req.body?.refCode;
    const thresholds = req.body?.thresholds;

    if (!refCode) {
      return res.status(400).json({ error: 'Missing refCode' });
    }

    if (!Array.isArray(thresholds) || thresholds.length === 0) {
      return res.status(400).json({ error: 'thresholds must be a non-empty array of numbers' });
    }

    // Validate thresholds: all numbers between 100 and 200
    const validThresholds = thresholds
      .map(t => Number(t))
      .filter(t => !isNaN(t) && t >= 100 && t <= 200);

    if (validThresholds.length === 0) {
      return res.status(400).json({ error: 'No valid thresholds (must be numbers between 100-200)' });
    }

    const alertsData = await fetchAlertsGist();
    if (!alertsData) {
      return res.status(500).json({ error: 'Could not read alerts data' });
    }

    // Find subscriber by refCode
    const pending = alertsData.pendingRefs?.[refCode];
    if (!pending?.claimed || !pending.claimedBy) {
      return res.status(400).json({ error: 'Ref code not yet claimed — press Start in the bot first' });
    }

    const chatId = String(pending.claimedBy);
    const subscriber = alertsData.subscribers?.[chatId];
    if (!subscriber) {
      return res.status(400).json({ error: 'Subscriber not found' });
    }

    // Only reset alertState if thresholds actually changed
    const oldThresholds = JSON.stringify([...(subscriber.thresholds || [])].sort((a, b) => b - a));
    const newThresholds = validThresholds.sort((a, b) => b - a);
    subscriber.thresholds = newThresholds;
    if (JSON.stringify(newThresholds) !== oldThresholds) {
      subscriber.alertState = {}; // new thresholds = fresh start
    }
    subscriber.thresholdsUpdatedAt = new Date().toISOString();

    // Update re-alert interval (optional, default 24h)
    const reAlertIntervalHours = Number(req.body?.reAlertIntervalHours);
    if (!isNaN(reAlertIntervalHours) && reAlertIntervalHours >= 1 && reAlertIntervalHours <= 720) {
      subscriber.reAlertIntervalHours = reAlertIntervalHours;
    } else if (!subscriber.reAlertIntervalHours) {
      subscriber.reAlertIntervalHours = 24;
    }

    const saved = await persistAlertsGist(alertsData);
    if (!saved) {
      return res.status(500).json({ error: 'Failed to save thresholds' });
    }

    return res.status(200).json({
      success: true,
      thresholds: subscriber.thresholds,
      reAlertIntervalHours: subscriber.reAlertIntervalHours,
    });
  }

  return res.status(400).json({ error: `Unknown action: ${action}` });
}
