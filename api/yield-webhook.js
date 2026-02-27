/**
 * Vercel Serverless Function — Yield Trading Bot Webhook
 * 
 * Handles incoming Telegram commands for @yieldtrading_bot:
 *   /start     — Welcome + capture chatId
 *   /list      — Show all available assets with implied yields
 *   /enable    — Enable alerts for an asset (e.g. /enable xSOL-2511)
 *   /disable   — Disable alerts for an asset
 *   /setlow    — Set low threshold (alert when yield ≤ value)
 *   /sethigh   — Set high threshold (alert when yield ≥ value)
 *   /clear     — Remove a threshold (low/high) from an asset
 *   /mystatus  — Show all your enabled assets + thresholds
 *   /help      — Show available commands
 * 
 * Setup (one-time):
 *   Register webhook:
 *     GET https://api.telegram.org/bot<YIELD_BOT_TOKEN>/setWebhook?url=https://hylo-community-hub.vercel.app/api/yield-webhook
 * 
 * Environment variables:
 *   YIELD_BOT_TOKEN  — Bot token for @yieldtrading_bot
 *   ALERTS_GIST_ID   — Shared alerts Gist
 *   GIST_TOKEN       — GitHub token with Gist permissions
 */

const TELEGRAM_API = 'https://api.telegram.org';
const GIST_RAW_URL = 'https://gist.githubusercontent.com/TejSingh24/d3a1db6fc79e168cf5dff8d3a2c11706/raw/ratex-assets.json';

// ─── Alerts Gist helpers ─────────────────────────────────────────────────────

async function fetchAlertsGist() {
  const alertsGistId = process.env.ALERTS_GIST_ID;
  const gistToken = process.env.GIST_TOKEN;
  if (!alertsGistId || !gistToken) return null;

  try {
    const res = await fetch(`https://api.github.com/gists/${alertsGistId}`, {
      headers: {
        'Authorization': `token ${gistToken}`,
        'User-Agent': 'Hylo-Yield-Bot',
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
        'User-Agent': 'Hylo-Yield-Bot',
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

// ─── Fetch live asset data ───────────────────────────────────────────────────

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

// ─── Telegram helpers ────────────────────────────────────────────────────────

async function sendReply(chatId, text, botToken) {
  await fetch(`${TELEGRAM_API}/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    }),
  });
}

/**
 * Normalize asset name for matching: lowercase, strip whitespace
 */
function normalizeAsset(name) {
  return name.toLowerCase().replace(/\s+/g, '');
}

/**
 * Find an asset by fuzzy match against the user-supplied name
 */
function findAsset(assets, query) {
  const q = normalizeAsset(query);
  // Exact match first
  const exact = assets.find(a => normalizeAsset(a.asset) === q);
  if (exact) return exact;
  // Partial match
  return assets.find(a => normalizeAsset(a.asset).includes(q) || q.includes(normalizeAsset(a.asset)));
}

// ─── Command handlers ────────────────────────────────────────────────────────

async function handleStart(chatId, botToken) {
  const msg = [
    '🤖 *Yield Trading Alert Bot*',
    '',
    'Monitor implied yields on RateX and Exponent assets.',
    'Get alerted when yields cross your thresholds!',
    '',
    `Your Chat ID: \`${chatId}\``,
    '',
    'Use /help to see available commands.',
  ];
  await sendReply(chatId, msg.join('\n'), botToken);
}

async function handleList(chatId, botToken) {
  const assets = await fetchAssets();
  if (!assets || assets.length === 0) {
    await sendReply(chatId, '❌ Could not fetch asset data. Try again later.', botToken);
    return;
  }

  // Group by source (case-insensitive)
  const ratex = assets.filter(a => a.source?.toLowerCase() === 'ratex');
  const exponent = assets.filter(a => a.source?.toLowerCase() === 'exponent');

  const lines = ['📊 *Available Assets*\n'];

  if (ratex.length > 0) {
    lines.push('*RateX:*');
    for (const a of ratex) {
      const iy = a.impliedYield != null ? `${a.impliedYield}%` : 'N/A';
      lines.push(`  \`${a.asset}\` — IY: ${iy}`);
    }
    lines.push('');
  }

  if (exponent.length > 0) {
    lines.push('*Exponent:*');
    for (const a of exponent) {
      const iy = a.impliedYield != null ? `${a.impliedYield}%` : 'N/A';
      lines.push(`  \`${a.asset}\` — IY: ${iy}`);
    }
    lines.push('');
  }

  lines.push('_Use /enable <asset> to start tracking_');
  await sendReply(chatId, lines.join('\n'), botToken);
}

async function handleEnable(chatId, assetQuery, botToken) {
  if (!assetQuery) {
    await sendReply(chatId, '❌ Usage: `/enable <asset>`\nExample: `/enable xSOL-2511`', botToken);
    return;
  }

  const assets = await fetchAssets();
  if (!assets) {
    await sendReply(chatId, '❌ Could not fetch asset data. Try again later.', botToken);
    return;
  }

  const asset = findAsset(assets, assetQuery);
  if (!asset) {
    await sendReply(chatId, `❌ Asset "${assetQuery}" not found.\nUse /list to see available assets.`, botToken);
    return;
  }

  const alertsData = await fetchAlertsGist();
  if (!alertsData) {
    await sendReply(chatId, '❌ Alert system unavailable. Try again later.', botToken);
    return;
  }

  // Initialize yieldAlerts if needed
  if (!alertsData.yieldAlerts) alertsData.yieldAlerts = {};
  if (!alertsData.yieldAlerts[String(chatId)]) {
    alertsData.yieldAlerts[String(chatId)] = { assets: {} };
  }

  const userAlerts = alertsData.yieldAlerts[String(chatId)];
  const assetName = asset.asset;

  if (userAlerts.assets[assetName]?.enabled) {
    await sendReply(chatId, `ℹ️ \`${assetName}\` is already enabled.`, botToken);
    return;
  }

  userAlerts.assets[assetName] = {
    enabled: true,
    thresholdLow: null,
    thresholdHigh: null,
    lastAlert: null,
    lastYield: null,
  };

  await persistAlertsGist(alertsData);
  await sendReply(chatId, `✅ Enabled alerts for \`${assetName}\`\n\nSet thresholds:\n  /setlow ${assetName} <value>\n  /sethigh ${assetName} <value>`, botToken);
}

async function handleDisable(chatId, assetQuery, botToken) {
  if (!assetQuery) {
    await sendReply(chatId, '❌ Usage: `/disable <asset>`', botToken);
    return;
  }

  const alertsData = await fetchAlertsGist();
  if (!alertsData) {
    await sendReply(chatId, '❌ Alert system unavailable. Try again later.', botToken);
    return;
  }

  const userAlerts = alertsData.yieldAlerts?.[String(chatId)];
  if (!userAlerts?.assets) {
    await sendReply(chatId, 'ℹ️ You have no enabled assets.', botToken);
    return;
  }

  // Find the matching asset key in user's config
  const assetKey = Object.keys(userAlerts.assets).find(
    k => normalizeAsset(k) === normalizeAsset(assetQuery) || normalizeAsset(k).includes(normalizeAsset(assetQuery))
  );

  if (!assetKey || !userAlerts.assets[assetKey]?.enabled) {
    await sendReply(chatId, `ℹ️ \`${assetQuery}\` is not enabled.`, botToken);
    return;
  }

  userAlerts.assets[assetKey].enabled = false;
  await persistAlertsGist(alertsData);
  await sendReply(chatId, `🔕 Disabled alerts for \`${assetKey}\`.`, botToken);
}

async function handleSetLow(chatId, args, botToken) {
  if (!args || args.length < 2) {
    await sendReply(chatId, '❌ Usage: `/setlow <asset> <value>`\nExample: `/setlow xSOL-2511 5.5`\n\nAlert triggers when implied yield ≤ this value.', botToken);
    return;
  }

  const value = parseFloat(args[args.length - 1]);
  const assetQuery = args.slice(0, -1).join(' ');

  if (isNaN(value)) {
    await sendReply(chatId, '❌ Invalid number. Example: `/setlow xSOL-2511 5.5`', botToken);
    return;
  }

  const alertsData = await fetchAlertsGist();
  if (!alertsData) {
    await sendReply(chatId, '❌ Alert system unavailable.', botToken);
    return;
  }

  const userAlerts = alertsData.yieldAlerts?.[String(chatId)];
  if (!userAlerts?.assets) {
    await sendReply(chatId, 'ℹ️ No assets enabled. Use /enable first.', botToken);
    return;
  }

  const assetKey = Object.keys(userAlerts.assets).find(
    k => normalizeAsset(k) === normalizeAsset(assetQuery) || normalizeAsset(k).includes(normalizeAsset(assetQuery))
  );

  if (!assetKey) {
    await sendReply(chatId, `❌ \`${assetQuery}\` is not enabled. Use /enable first.`, botToken);
    return;
  }

  userAlerts.assets[assetKey].thresholdLow = value;
  await persistAlertsGist(alertsData);
  await sendReply(chatId, `✅ Low threshold for \`${assetKey}\` set to *${value}%*\n\nYou'll be alerted when implied yield ≤ ${value}%`, botToken);
}

async function handleSetHigh(chatId, args, botToken) {
  if (!args || args.length < 2) {
    await sendReply(chatId, '❌ Usage: `/sethigh <asset> <value>`\nExample: `/sethigh xSOL-2511 15`\n\nAlert triggers when implied yield ≥ this value.', botToken);
    return;
  }

  const value = parseFloat(args[args.length - 1]);
  const assetQuery = args.slice(0, -1).join(' ');

  if (isNaN(value)) {
    await sendReply(chatId, '❌ Invalid number. Example: `/sethigh xSOL-2511 15`', botToken);
    return;
  }

  const alertsData = await fetchAlertsGist();
  if (!alertsData) {
    await sendReply(chatId, '❌ Alert system unavailable.', botToken);
    return;
  }

  const userAlerts = alertsData.yieldAlerts?.[String(chatId)];
  if (!userAlerts?.assets) {
    await sendReply(chatId, 'ℹ️ No assets enabled. Use /enable first.', botToken);
    return;
  }

  const assetKey = Object.keys(userAlerts.assets).find(
    k => normalizeAsset(k) === normalizeAsset(assetQuery) || normalizeAsset(k).includes(normalizeAsset(assetQuery))
  );

  if (!assetKey) {
    await sendReply(chatId, `❌ \`${assetQuery}\` is not enabled. Use /enable first.`, botToken);
    return;
  }

  userAlerts.assets[assetKey].thresholdHigh = value;
  await persistAlertsGist(alertsData);
  await sendReply(chatId, `✅ High threshold for \`${assetKey}\` set to *${value}%*\n\nYou'll be alerted when implied yield ≥ ${value}%`, botToken);
}

async function handleClear(chatId, args, botToken) {
  if (!args || args.length < 2) {
    await sendReply(chatId, '❌ Usage: `/clear <asset> <low|high|all>`\nExample: `/clear xSOL-2511 low`', botToken);
    return;
  }

  const direction = args[args.length - 1].toLowerCase();
  const assetQuery = args.slice(0, -1).join(' ');

  if (!['low', 'high', 'all'].includes(direction)) {
    await sendReply(chatId, '❌ Specify `low`, `high`, or `all`.\nExample: `/clear xSOL-2511 all`', botToken);
    return;
  }

  const alertsData = await fetchAlertsGist();
  if (!alertsData) {
    await sendReply(chatId, '❌ Alert system unavailable.', botToken);
    return;
  }

  const userAlerts = alertsData.yieldAlerts?.[String(chatId)];
  if (!userAlerts?.assets) {
    await sendReply(chatId, 'ℹ️ No assets enabled.', botToken);
    return;
  }

  const assetKey = Object.keys(userAlerts.assets).find(
    k => normalizeAsset(k) === normalizeAsset(assetQuery) || normalizeAsset(k).includes(normalizeAsset(assetQuery))
  );

  if (!assetKey) {
    await sendReply(chatId, `❌ \`${assetQuery}\` is not enabled.`, botToken);
    return;
  }

  if (direction === 'low' || direction === 'all') {
    userAlerts.assets[assetKey].thresholdLow = null;
  }
  if (direction === 'high' || direction === 'all') {
    userAlerts.assets[assetKey].thresholdHigh = null;
  }

  await persistAlertsGist(alertsData);
  await sendReply(chatId, `✅ Cleared ${direction} threshold(s) for \`${assetKey}\`.`, botToken);
}

async function handleMyStatus(chatId, botToken) {
  const alertsData = await fetchAlertsGist();
  const userAlerts = alertsData?.yieldAlerts?.[String(chatId)];

  if (!userAlerts?.assets || Object.keys(userAlerts.assets).length === 0) {
    await sendReply(chatId, 'ℹ️ No assets configured. Use /list and /enable to get started.', botToken);
    return;
  }

  // Fetch live data to show current yields
  const assets = await fetchAssets();

  const lines = ['📊 *Your Yield Alerts*\n'];

  for (const [assetName, config] of Object.entries(userAlerts.assets)) {
    const status = config.enabled ? '✅' : '🔕';
    const liveAsset = assets?.find(a => a.asset === assetName);
    const iy = liveAsset?.impliedYield != null ? `${liveAsset.impliedYield}%` : 'N/A';

    // Compact: threshold info on same line
    const parts = [];
    if (config.thresholdLow != null) parts.push(`↓≤${config.thresholdLow}%`);
    if (config.thresholdHigh != null) parts.push(`↑≥${config.thresholdHigh}%`);
    const thresholds = parts.length > 0 ? parts.join(' ') : '—';

    lines.push(`${status} \`${assetName}\` | IY: ${iy} | ${thresholds}`);
  }

  // Split into chunks of max ~4000 chars to stay under Telegram's 4096 limit
  const messages = [];
  let current = '';
  for (const line of lines) {
    if (current.length + line.length + 1 > 3900 && current.length > 0) {
      messages.push(current);
      current = '';
    }
    current += (current ? '\n' : '') + line;
  }
  if (current) messages.push(current);

  for (const msg of messages) {
    await sendReply(chatId, msg, botToken);
  }
}

async function handleHelp(chatId, botToken) {
  const msg = [
    '🤖 *Yield Trading Bot — Commands*\n',
    '/list — Show all assets with current implied yields',
    '/enable <asset> — Enable alerts for an asset',
    '/disable <asset> — Disable alerts for an asset',
    '/setlow <asset> <value> — Alert when IY ≤ value',
    '/sethigh <asset> <value> — Alert when IY ≥ value',
    '/clear <asset> <low|high|all> — Remove threshold(s)',
    '/mystatus — View your alert settings',
    '/help — Show this message',
    '',
    '*Example:*',
    '```',
    '/enable xSOL-2511',
    '/setlow xSOL-2511 5.5',
    '/sethigh xSOL-2511 15',
    '```',
    '',
    '_Yields are checked every 5 minutes (scraper cycle)._',
    '_Alerts fire every cycle while the threshold is breached._',
  ];
  await sendReply(chatId, msg.join('\n'), botToken);
}

// ─── Webhook handler ─────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const botToken = process.env.YIELD_BOT_TOKEN;
  if (!botToken) {
    console.error('YIELD_BOT_TOKEN not set');
    return res.status(500).json({ error: 'Bot not configured' });
  }

  try {
    const update = req.body;
    const message = update?.message;
    if (!message?.text) return res.status(200).json({ ok: true });

    const chatId = message.chat.id;
    const rawText = message.text.trim();
    const text = rawText.toLowerCase();
    const parts = rawText.split(/\s+/);
    const command = parts[0].toLowerCase().split('@')[0]; // Handle "/cmd@botname"
    const args = parts.slice(1);
    const argText = args.join(' ');

    switch (command) {
      case '/start':
        await handleStart(chatId, botToken);
        break;
      case '/list':
        await handleList(chatId, botToken);
        break;
      case '/enable':
        await handleEnable(chatId, argText, botToken);
        break;
      case '/disable':
        await handleDisable(chatId, argText, botToken);
        break;
      case '/setlow':
        await handleSetLow(chatId, args, botToken);
        break;
      case '/sethigh':
        await handleSetHigh(chatId, args, botToken);
        break;
      case '/clear':
        await handleClear(chatId, args, botToken);
        break;
      case '/mystatus':
        await handleMyStatus(chatId, botToken);
        break;
      case '/help':
        await handleHelp(chatId, botToken);
        break;
      default:
        // Ignore unknown commands
        break;
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Yield webhook error:', error);
    return res.status(200).json({ ok: true }); // Always 200 so Telegram doesn't retry
  }
}
