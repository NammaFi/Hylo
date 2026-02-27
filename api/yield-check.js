/**
 * Vercel Serverless Function — Yield Alert Checker
 * 
 * Fetches both Gists (asset data + alert config), compares implied yields
 * against user thresholds, and sends Telegram alerts.
 * 
 * Called by:
 *   - Python script (local, every 5 min)
 *   - Scraper (end of scrape cycle)
 * 
 * GET /api/yield-check
 * 
 * Environment variables:
 *   YIELD_BOT_TOKEN  — Bot token for @yieldtrading_bot
 *   ALERTS_GIST_ID   — Shared alerts Gist
 *   GIST_TOKEN       — GitHub token with Gist permissions
 */

const TELEGRAM_API = 'https://api.telegram.org';
const GIST_RAW_URL = 'https://gist.githubusercontent.com/TejSingh24/d3a1db6fc79e168cf5dff8d3a2c11706/raw/ratex-assets.json';

// ─── Fetch asset data from main Gist ─────────────────────────────────────────

async function fetchAssets() {
  try {
    const res = await fetch(GIST_RAW_URL, { cache: 'no-cache' });
    if (!res.ok) return null;
    const data = await res.json();
    return data.assets || [];
  } catch {
    return null;
  }
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
        'User-Agent': 'Hylo-Yield-Check',
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
        'User-Agent': 'Hylo-Yield-Check',
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

// ─── Telegram helper ─────────────────────────────────────────────────────────

async function sendTelegramAlert(chatId, text, botToken) {
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ─── Main check logic ────────────────────────────────────────────────────────

async function checkYieldAlerts() {
  const botToken = process.env.YIELD_BOT_TOKEN;
  if (!botToken) {
    return { error: 'YIELD_BOT_TOKEN not set' };
  }

  // Fetch both data sources in parallel
  const [assets, alertsData] = await Promise.all([
    fetchAssets(),
    fetchAlertsGist(),
  ]);

  if (!assets || assets.length === 0) {
    return { error: 'Could not fetch asset data' };
  }

  if (!alertsData) {
    return { error: 'Could not fetch alerts config (Gist read failed, no action taken)' };
  }

  if (!alertsData.yieldAlerts) {
    return { checked: 0, alerts: 0, message: 'No yield alert configs found' };
  }

  const now = new Date().toISOString();
  let totalChecked = 0;
  let totalAlerts = 0;
  let gistChanged = false;
  const alertsSent = [];

  for (const [chatId, userConfig] of Object.entries(alertsData.yieldAlerts)) {
    if (!userConfig?.assets) continue;

    for (const [assetName, config] of Object.entries(userConfig.assets)) {
      if (!config.enabled) continue;

      const liveAsset = assets.find(a => a.asset === assetName);
      if (!liveAsset || liveAsset.impliedYield == null) continue;

      const currentYield = parseFloat(liveAsset.impliedYield);
      if (isNaN(currentYield)) continue;

      totalChecked++;
      let triggered = false;
      let direction = '';

      // Check low threshold: yield ≤ thresholdLow
      if (config.thresholdLow != null && currentYield <= config.thresholdLow) {
        triggered = true;
        direction = 'low';
      }

      // Check high threshold: yield ≥ thresholdHigh
      if (config.thresholdHigh != null && currentYield >= config.thresholdHigh) {
        triggered = true;
        direction = direction === 'low' ? 'both' : 'high';
      }

      if (!triggered) {
        if (config.lastYield !== currentYield) {
          config.lastYield = currentYield;
          gistChanged = true;
        }
        continue;
      }

      // Build alert message
      let emoji, label;
      if (direction === 'both') {
        emoji = '⚠️';
        label = `≤ ${config.thresholdLow}% (Low) AND ≥ ${config.thresholdHigh}% (High)`;
      } else if (direction === 'low') {
        emoji = '📉';
        label = `≤ ${config.thresholdLow}%`;
      } else {
        emoji = '📈';
        label = `≥ ${config.thresholdHigh}%`;
      }

      const source = liveAsset.source || 'Unknown';
      const message = [
        `${emoji} <b>YIELD ALERT — ${assetName}</b>`,
        '',
        `${assetName} implied yield is <b>${currentYield}%</b> (${label})`,
        '',
        `📊 Current IY: <b>${currentYield}%</b>`,
        `🏦 Source: ${source}`,
        `⏰ ${now}`,
      ].join('\n');

      const sent = await sendTelegramAlert(chatId, message, botToken);

      if (sent) {
        totalAlerts++;
        alertsSent.push({ asset: assetName, yield: currentYield, direction, chatId });
        config.lastAlert = now;
        gistChanged = true;
      }

      config.lastYield = currentYield;
      gistChanged = true;
    }
  }

  if (gistChanged) {
    await persistAlertsGist(alertsData);
  }

  return {
    checked: totalChecked,
    alerts: totalAlerts,
    alertsSent,
    timestamp: now,
  };
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const result = await checkYieldAlerts();

    if (result.error) {
      console.error('Yield check error:', result.error);
      return res.status(200).json({ ok: false, ...result });
    }

    console.log(`Yield check: ${result.checked} assets checked, ${result.alerts} alerts sent`);
    return res.status(200).json({ ok: true, ...result });
  } catch (error) {
    console.error('Yield check fatal error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
}
