/**
 * Vercel Serverless Function — Telegram Bot Webhook
 * 
 * Handles incoming Telegram commands:
 *   /cr      — Show current Collateral Ratio + status
 *   /status  — Show system status, last alert times, active thresholds
 *   /alerts  — Show alert history
 *   /start   — Welcome message
 *   /help    — Show available commands
 * 
 * Setup (one-time):
 *   1. Create bot via @BotFather → /newbot → get token
 *   2. Create a private group/channel, add the bot
 *   3. Get chat ID (send a message, then visit https://api.telegram.org/bot<TOKEN>/getUpdates)
 *   4. Register webhook:
 *      GET https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://hylo.vercel.app/api/telegram-webhook
 *   5. Set environment variables in Vercel:
 *      TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 * 
 * Environment variables:
 *   TELEGRAM_BOT_TOKEN  — Bot token from @BotFather
 */

const TELEGRAM_API = 'https://api.telegram.org';
const HYLO_STATS_API = 'https://api.hylo.so/stats';
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
        'User-Agent': 'Hylo-Telegram-Bot',
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
        'User-Agent': 'Hylo-Telegram-Bot',
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function sendTelegramReply(chatId, text, botToken) {
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

async function fetchLiveCR() {
  try {
    const res = await fetch(HYLO_STATS_API);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return {
      cr: data.exchangeStats?.collateralRatio ?? null,
      hyusdSupply: data.exchangeStats?.stablecoinSupply ?? null,
      xsolPrice: data.exchangeStats?.levercoinNav ?? null,
      xsolSupply: data.exchangeStats?.levercoinSupply ?? null,
      stabilityMode: data.exchangeStats?.stabilityMode ?? {},
    };
  } catch (err) {
    return { cr: null, error: err.message };
  }
}

async function fetchAlertState() {
  try {
    const res = await fetch(GIST_RAW_URL, { cache: 'no-cache' });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      alertState: data.alertState || null,
      lastUpdated: data.lastUpdated || null,
      xsolMetrics: data.xsolMetrics || null,
    };
  } catch {
    return null;
  }
}

function formatCRStatus(cr) {
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

// ─── Command handlers ────────────────────────────────────────────────────────

async function handleCR(chatId, botToken) {
  const data = await fetchLiveCR();

  if (data.cr === null) {
    await sendTelegramReply(chatId, `❌ Could not fetch CR from Hylo API.\nError: ${data.error || 'Unknown'}`, botToken);
    return;
  }

  const crText = formatCRStatus(data.cr);
  const details = [
    crText,
    '',
    `💰 HYusd Supply: ${data.hyusdSupply?.toLocaleString() ?? 'N/A'}`,
    `📈 xSOL Price: $${data.xsolPrice?.toFixed(4) ?? 'N/A'}`,
    `🪙 xSOL Supply: ${data.xsolSupply?.toLocaleString() ?? 'N/A'}`,
    '',
    `⏰ _Fetched live from Hylo API_`,
  ];

  await sendTelegramReply(chatId, details.join('\n'), botToken);
}

async function handleStatus(chatId, botToken) {
  const gistInfo = await fetchAlertState();
  const liveData = await fetchLiveCR();

  const lines = ['📋 *System Status*\n'];

  // Live CR
  if (liveData.cr !== null) {
    lines.push(`📊 Live CR: *${(liveData.cr * 100).toFixed(1)}%*`);
  } else {
    lines.push(`📊 Live CR: ❌ Could not fetch`);
  }

  // Last scraper update
  if (gistInfo?.lastUpdated) {
    const ago = Math.round((Date.now() - new Date(gistInfo.lastUpdated).getTime()) / 60000);
    lines.push(`🔄 Last Gist update: ${ago} min ago`);
  }

  // Alert state
  const alertState = gistInfo?.alertState;
  if (alertState) {
    lines.push('\n*Active Alerts:*');
    const thresholds = [
      { key: 'cr_140', label: '< 140%' },
      { key: 'cr_135', label: '< 135%' },
      { key: 'cr_130', label: '< 130%' },
      { key: 'cr_110', label: '< 110%' },
    ];
    for (const t of thresholds) {
      const entry = alertState[t.key];
      if (entry?.active) {
        lines.push(`  🔔 ${t.label} — ACTIVE (last Telegram: ${entry.lastTelegram || 'N/A'})`);
      } else {
        lines.push(`  ✅ ${t.label} — cleared`);
      }
    }
  } else {
    lines.push('\n_No alert state found in Gist_');
  }

  await sendTelegramReply(chatId, lines.join('\n'), botToken);
}

async function handleAlerts(chatId, botToken) {
  // Try per-user alert state from alerts Gist first
  const alertsData = await fetchAlertsGist();
  const subscriber = alertsData?.subscribers?.[String(chatId)];
  const alertState = subscriber?.alertState;

  if (!alertState) {
    // Fall back to legacy Gist alertState
    const gistInfo = await fetchAlertState();
    const legacyState = gistInfo?.alertState;
    if (!legacyState) {
      await sendTelegramReply(chatId, '📭 No alert history found. Set up alerts at the Hylo Community Hub.', botToken);
      return;
    }
    // Show legacy state
    const lines = ['📜 *Alert History*\n'];
    const thresholds = [
      { key: 'cr_110', label: '110%', emoji: '🚨' },
      { key: 'cr_130', label: '130%', emoji: '🔴' },
      { key: 'cr_135', label: '135%', emoji: '🟠' },
      { key: 'cr_140', label: '140%', emoji: '🟡' },
    ];
    for (const t of thresholds) {
      const entry = legacyState[t.key];
      lines.push(`${t.emoji} *CR < ${t.label}*`);
      lines.push(`  Active: ${entry?.active ? 'YES' : 'No'}`);
      lines.push(`  Last Telegram: ${entry?.lastTelegram || '—'}`);
      lines.push('');
    }
    await sendTelegramReply(chatId, lines.join('\n'), botToken);
    return;
  }

  // Show per-user alert state
  const userThresholds = (subscriber.thresholds || [140, 135, 130, 110]).sort((a, b) => a - b);
  const lines = ['📜 *Your Alert History*\n'];
  for (const pct of userThresholds) {
    const key = `cr_${pct}`;
    const entry = alertState[key];
    const emoji = pct <= 110 ? '🚨' : pct <= 130 ? '🔴' : pct <= 135 ? '🟠' : '🟡';
    lines.push(`${emoji} *CR < ${pct}%*`);
    lines.push(`  Active: ${entry?.active ? 'YES' : 'No'}`);
    lines.push(`  Last Telegram: ${entry?.lastTelegram || '—'}`);
    lines.push('');
  }
  await sendTelegramReply(chatId, lines.join('\n'), botToken);
}

async function handleStartWithRef(chatId, refCode, botToken) {
  const alertsData = await fetchAlertsGist();
  if (!alertsData) {
    await sendTelegramReply(chatId, '❌ Alert system is not configured yet. Please try again later.', botToken);
    return;
  }

  // Check if ref code exists
  if (!alertsData.pendingRefs?.[refCode]) {
    // Maybe already connected?
    if (alertsData.subscribers?.[String(chatId)]) {
      await sendTelegramReply(chatId, '✅ You\'re already connected! Return to the website to customize your thresholds.', botToken);
      return;
    }
    await sendTelegramReply(chatId, '❌ Invalid or expired link. Please generate a new one from the Hylo Community Hub.', botToken);
    return;
  }

  // Register subscriber (or update existing — preserve thresholds/alertState)
  if (!alertsData.subscribers) alertsData.subscribers = {};
  const existing = alertsData.subscribers[String(chatId)];
  if (existing) {
    // Already a subscriber — just update refCode and reactivate
    existing.refCode = refCode;
    existing.active = true;
  } else {
    // New subscriber
    alertsData.subscribers[String(chatId)] = {
      chatId: chatId,
      refCode: refCode,
      thresholds: [140, 135, 130, 110],
      reAlertIntervalHours: 24,
      alertState: {},
      active: true,
      connectedAt: new Date().toISOString(),
    };
  }

  // Mark ref as claimed
  alertsData.pendingRefs[refCode].claimed = true;
  alertsData.pendingRefs[refCode].claimedBy = chatId;
  alertsData.pendingRefs[refCode].claimedAt = new Date().toISOString();

  await persistAlertsGist(alertsData);

  await sendTelegramReply(
    chatId,
    '✅ *Connected successfully!*\n\nYou\'ll receive CR alerts when thresholds are breached.\n\n🔧 Return to the Hylo Community Hub to customize your alert thresholds.\n\nDefault thresholds: 140%, 135%, 130%, 110%\n\nCommands:\n/mythresholds — View your thresholds\n/unsubscribe — Stop alerts',
    botToken
  );
}

async function handleUnsubscribe(chatId, botToken) {
  const alertsData = await fetchAlertsGist();
  if (!alertsData?.subscribers?.[String(chatId)]) {
    await sendTelegramReply(chatId, 'ℹ️ You\'re not subscribed to any alerts.', botToken);
    return;
  }

  alertsData.subscribers[String(chatId)].active = false;
  await persistAlertsGist(alertsData);

  await sendTelegramReply(chatId, '🔕 *Alerts disabled.* You won\'t receive any more CR alerts.\n\nTo re-enable, visit the Hylo Community Hub and set up alerts again.', botToken);
}

async function handleMyThresholds(chatId, botToken) {
  const alertsData = await fetchAlertsGist();
  const subscriber = alertsData?.subscribers?.[String(chatId)];

  if (!subscriber) {
    await sendTelegramReply(chatId, 'ℹ️ You\'re not subscribed. Set up alerts at the Hylo Community Hub.', botToken);
    return;
  }

  const thresholds = (subscriber.thresholds || [140, 135, 130, 110]).sort((a, b) => b - a);
  const intervalHours = subscriber.reAlertIntervalHours || 24;
  const intervalLabel = intervalHours >= 24 && intervalHours % 24 === 0
    ? `${intervalHours / 24} day${intervalHours / 24 !== 1 ? 's' : ''}`
    : `${intervalHours} hour${intervalHours !== 1 ? 's' : ''}`;
  const lines = [
    '🔔 *Your Alert Settings*\n',
    `Status: ${subscriber.active ? '✅ Active' : '🔕 Paused'}`,
    `Re-alert: every ${intervalLabel}`,
    '',
  ];

  for (const pct of thresholds) {
    const emoji = pct <= 110 ? '🚨' : pct <= 130 ? '🔴' : pct <= 135 ? '🟠' : '🟡';
    lines.push(`${emoji} CR < ${pct}%`);
  }

  lines.push('');
  lines.push('_Customize thresholds on the Hylo Community Hub._');

  await sendTelegramReply(chatId, lines.join('\n'), botToken);
}

async function handleHelp(chatId, botToken) {
  const msg = [
    '🤖 *Hylo Alert Bot — Commands*\n',
    '/cr — Show current Collateral Ratio (live from Hylo API)',
    '/status — System status + active alerts',
    '/alerts — Your alert history',
    '/mythresholds — View your alert thresholds',
    '/unsubscribe — Stop receiving alerts',
    '/help — Show this message',
    '',
    '*Default Alert Thresholds:*',
    '🟡 CR < 140% — Caution on sHYUSD loops',
    '🟠 CR < 135% — sHYUSD price can decrease anytime',
    '🔴 CR < 130% — sHYUSD price is going to decrease',
    '🚨 CR < 110% — HYUSD peg at risk',
    '',
    '_Customize thresholds on the Hylo Community Hub._',
    '_Automated alerts run every 5 minutes._',
    '_Telegram: alerts once + every 24h while breached._',
    '_Email: once per breach (until recovery)._',
  ];

  await sendTelegramReply(chatId, msg.join('\n'), botToken);
}

// ─── Webhook handler ─────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.error('TELEGRAM_BOT_TOKEN not set');
    return res.status(500).json({ error: 'Bot not configured' });
  }

  try {
    const update = req.body;

    // Only process text messages
    const message = update?.message;
    if (!message?.text) {
      return res.status(200).json({ ok: true });
    }

    const chatId = message.chat.id;
    const rawText = message.text.trim();
    const text = rawText.toLowerCase();
    const command = text.split(' ')[0]; // Handle "/cr@botname" format

    switch (command) {
      case '/cr':
        await handleCR(chatId, botToken);
        break;
      case '/status':
        await handleStatus(chatId, botToken);
        break;
      case '/alerts':
        await handleAlerts(chatId, botToken);
        break;
      case '/start': {
        // Check for deep link ref code: /start ref_XXXX
        const parts = rawText.split(/\s+/);
        if (parts.length > 1 && parts[1].startsWith('ref_')) {
          await handleStartWithRef(chatId, parts[1], botToken);
        } else {
          await handleHelp(chatId, botToken);
        }
        break;
      }
      case '/help':
        await handleHelp(chatId, botToken);
        break;
      case '/unsubscribe':
        await handleUnsubscribe(chatId, botToken);
        break;
      case '/mythresholds':
        await handleMyThresholds(chatId, botToken);
        break;
      default:
        // Ignore unknown commands — don't spam the chat
        break;
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(200).json({ ok: true }); // Always 200 so Telegram doesn't retry
  }
}
