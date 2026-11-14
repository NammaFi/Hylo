// Claimable-yield alerts (built 2026-11-14). Used ONLY by api/claim-check.js.
//
// What it does: every minute (the Cloudflare Worker's 1-minute cron calls api/claim-check) it reads the
// wallet's Exponent YT positions straight from the chain, computes what `YtPosition.getClaimableInterest`
// would return (verified identical to the raw unit on live positions), and runs the alert rules:
//   * enabling an (asset, wallet) pair arms it: the baseline is the claimable AT THAT MOMENT (silent + one
//     'armed' message);
//   * claimable - baseline >= the pair's minimum increase (blank = any increase above a dust floor) starts a
//     burst: one Telegram message per tick for 10 ticks, then silence, the baseline becomes the claimable at
//     the last message and the pair waits for a further increase;
//   * a drop of the claimable (a claim) ends a burst, resets the baseline to the new value, one 'claimed' note.
//
// No dependencies except node:crypto. Network access is injected (see makeRealDeps) so the whole thing runs
// against fakes in tests. Config is written ONLY by yield-manager.html (file claim-alert-config.json of the
// alerts Gist), state ONLY by this module (claim-alert-state.json): one writer per file, and the existing
// cr-alert-subscribers.json is never touched.

import { createHash } from 'node:crypto';

// ─── Constants ───────────────────────────────────────────────────────────────

export const CORE_PROGRAM_ID = 'ExponentnaRg3CQbW6dqQNZKXp7gtZ9DGMp1cwC4HAS7';
export const DEFAULT_WALLET = 'FCC8bBW9JBpa7rsHoEY711hMQBBgDJnAtqsS52TJBCTm';
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const BURST_MESSAGES = 10;            // messages per burst, one per tick
export const MIN_SEND_GAP_MS = 50_000;       // two calls inside this gap never send twice for one pair
export const DUST_USD = 0.001;               // 'any increase' means at least this much (in dollars)
export const DUST_UNITS = 1e-6;              // the same floor where no dollar price exists
export const FAIL_WARN_STREAK = 15;          // consecutive failed ticks before the one warning message
export const HEARTBEAT_MS = 5 * 60_000;      // state is written at least this often (when nothing changes)
export const CONFIG_FILE = 'claim-alert-config.json';
export const STATE_FILE = 'claim-alert-state.json';

const MARKETS_URL = 'https://app.exponent.finance/api/markets';
const JUP_PRICE_URL = `https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`;

// ─── base58 / ed25519 on-curve test / PDA ────────────────────────────────────

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function b58decode(s) {
  if (typeof s !== 'string' || s.length === 0) throw new Error('empty base58');
  let n = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error('bad base58 character');
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const body = n === 0n ? Buffer.alloc(0) : Buffer.from(hex, 'hex');
  let zeros = 0;
  for (const ch of s) { if (ch === '1') zeros++; else break; }
  return Buffer.concat([Buffer.alloc(zeros), body]);
}

export function b58encode(bytes) {
  const buf = Buffer.from(bytes);
  let n = 0n;
  for (const b of buf) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b === 0) out = '1' + out; else break; }
  return out;
}

/** A valid Solana address = base58 that decodes to exactly 32 bytes. */
export function isAddress(s) {
  try { return b58decode(String(s).trim()).length === 32; } catch { return false; }
}

const P = (1n << 255n) - 19n;
const mod = (a) => { const r = a % P; return r >= 0n ? r : r + P; };
function powmod(b, e) {
  let r = 1n; b = mod(b);
  while (e > 0n) { if (e & 1n) r = mod(r * b); b = mod(b * b); e >>= 1n; }
  return r;
}
const inv = (a) => powmod(a, P - 2n);
const D = mod(-121665n * inv(121666n));

/** True when the 32 bytes decode to a point on the ed25519 curve (a PDA must be OFF the curve). */
export function isOnCurve(bytes32) {
  const b = Uint8Array.from(bytes32);
  const sign = b[31] >> 7;
  b[31] &= 0x7f;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(b[i]);
  if (y >= P) return false;
  const y2 = mod(y * y);
  const x2 = mod(mod(y2 - 1n) * inv(mod(D * y2 + 1n)));
  if (x2 === 0n) return sign === 0;
  return powmod(x2, (P - 1n) / 2n) === 1n;
}

export function findPda(seeds, programId32) {
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash('sha256');
    for (const s of seeds) h.update(s);
    h.update(Uint8Array.of(bump));
    h.update(programId32);
    h.update('ProgramDerivedAddress');
    const out = h.digest();
    if (!isOnCurve(out)) return { address: b58encode(out), bump };
  }
  throw new Error('no program-derived address found');
}

const pdaCache = new Map();
/** The wallet's YT position account in one vault: PDA(["yield_position", vault, owner], core program). */
export function positionAddress(vault58, owner58, program58 = CORE_PROGRAM_ID) {
  const key = vault58 + '|' + owner58 + '|' + program58;
  let a = pdaCache.get(key);
  if (!a) {
    a = findPda([Buffer.from('yield_position'), b58decode(vault58), b58decode(owner58)], b58decode(program58)).address;
    pdaCache.set(key, a);
  }
  return a;
}

// ─── Account decoding and the claimable formula ──────────────────────────────

const disc = (name) => createHash('sha256').update('account:' + name).digest().subarray(0, 8);
const DISC_POSITION = disc('YieldTokenPosition');
const DISC_VAULT = disc('Vault');

function u256le(buf, o) {
  let v = 0n;
  for (let i = 31; i >= 0; i--) v = (v << 8n) | BigInt(buf[o + i]);
  return v;
}

/** The program's 256-bit index has 12 decimals; parse it like the SDK does (as the exact decimal string). */
export function u256ToFloat(raw) {
  const s = raw.toString().padStart(13, '0');
  return parseFloat(s.slice(0, -12) + '.' + s.slice(-12));
}

/** YieldTokenPosition: discriminator 8, owner @8, vault @40, yt_balance u64 @72, last_seen_index U256 @80, staged u64 @112. */
export function decodePosition(buf) {
  if (!buf || buf.length < 120) throw new Error('position account too short');
  if (!buf.subarray(0, 8).equals(DISC_POSITION)) throw new Error('not a YT position account');
  return { yt: buf.readBigUInt64LE(72), idx: u256ToFloat(u256le(buf, 80)), staged: buf.readBigUInt64LE(112) };
}

/** Vault: last_seen_sy_exchange_rate U256 @337 (12 decimals), interest_bps_fee u16 @505. */
export function decodeVault(buf) {
  if (!buf || buf.length < 507) throw new Error('vault account too short');
  if (!buf.subarray(0, 8).equals(DISC_VAULT)) throw new Error('not a vault account');
  return { storedRate: u256ToFloat(u256le(buf, 337)), feeBps: buf.readUInt16LE(505) };
}

/** Exactly the SDK's YtPosition.getClaimableInterest(rate): raw asset units, net of the vault fee. */
export function claimableRaw(pos, feeBps, rate) {
  if (!(pos.idx > 0) || !(rate > 0)) return 0;
  const delta = 1 / pos.idx - 1 / rate;
  const toCollect = Math.floor(Number(pos.yt) * delta + Number(pos.staged));
  const safe = Math.max(0, toCollect);
  const fee = Math.floor((safe * feeBps + 9999) / 10000);
  const user = Math.max(0, safe - fee);
  const base = Math.floor(user * rate);
  return Math.max(0, base > 0 ? base - 1 : base);
}

// ─── Units and number formatting ─────────────────────────────────────────────

/** unit: 'USD' (the asset is dollars), 'SOL' (converted with the SOL price) or the asset's own ticker (no $ conversion). */
export function unitOf(ticker) {
  if (ticker === 'USD') return 'USD';
  if (ticker === 'SOL') return 'SOL';
  return String(ticker || 'asset');
}

const fmtNum = (v, maxDec) => {
  const a = Math.abs(v);
  const dec = a >= 1000 ? 2 : a >= 1 ? maxDec : a >= 0.01 ? 4 : 6;
  return v.toLocaleString('en-US', { minimumFractionDigits: Math.min(2, dec), maximumFractionDigits: dec });
};

/** '$29.17' | '0.2812 SOL (~$29.40)' | '12.35 hyUSD' */
export function fmtAmount(v, unit, usdPer) {
  if (unit === 'USD') return '$' + fmtNum(v, 2);
  if (unit === 'SOL') return fmtNum(v, 4) + ' SOL' + (usdPer ? ` (~$${fmtNum(v * usdPer, 2)})` : '');
  return fmtNum(v, 4) + ' ' + unit;
}

export function shortAddr(a) { return a.length > 12 ? a.slice(0, 4) + '…' + a.slice(-4) : a; }
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sanitize = (s) => String(s ?? '').replace(/https?:\/\/\S+/g, '<url>').slice(0, 300);

// ─── The alert rules (pure) ──────────────────────────────────────────────────

export function armKeyOf(wallet, walletSetAt, cfgRow) {
  return [wallet, cfgRow.vault || '', cfgRow.enabledAt || '', walletSetAt || ''].join('|');
}

/** Minimum increase in ASSET units: the typed amount (dollars for USD / SOL assets, asset units otherwise), never below the dust floor. */
export function thresholdUnits(minIncrease, usdPer) {
  const dust = usdPer ? DUST_USD / usdPer : DUST_UNITS;
  const typed = Number.isFinite(minIncrease) && minIncrease > 0 ? (usdPer ? minIncrease / usdPer : minIncrease) : 0;
  return Math.max(dust, typed);
}

/**
 * One tick of one (asset, wallet) pair.
 *   prev  - the pair's machine state from the last tick (or undefined)
 *   armKey - changes whenever the pair was (re-)enabled or the wallet changed
 *   cl    - the claimable now, in asset units;  usdPer - dollars per asset unit (null = no $ price);  thr - threshold in asset units
 * Returns { next, events } where events are { kind: 'armed' | 'burst' | 'claimed', ... }.
 */
export function stepRow({ prev, armKey, cl, usdPer, thr, now }) {
  const iso = new Date(now).toISOString();
  const dust = usdPer ? DUST_USD / usdPer : DUST_UNITS;
  const events = [];

  if (!prev || prev.armKey !== armKey) {
    events.push({ kind: 'armed', baseline: cl });
    return { next: { armKey, armedAt: iso, baseline: cl, lastSeen: cl, phase: 'idle', burstBase: null, burstSent: 0, burstStartedAt: null, lastSentAt: null }, events };
  }

  const next = { ...prev };
  const was = Number.isFinite(prev.lastSeen) ? prev.lastSeen : prev.baseline;

  // a claim: the claimable fell to less than half of what we saw before (a full claim goes to ~0; noise is far smaller).
  // It must be seen on TWO ticks in a row: one read from a lagging node must not look like a claim (and then like a new increase).
  if (cl < was * 0.5 && was - cl >= dust) {
    const ticks = (prev.dropTicks || 0) + 1;
    if (ticks < 2) { next.dropTicks = ticks; return { next, events }; }   // wait for the second low reading; lastSeen stays
    Object.assign(next, { baseline: cl, lastSeen: cl, phase: 'idle', burstBase: null, burstSent: 0, burstStartedAt: null, dropTicks: 0 });
    events.push({ kind: 'claimed', from: was, to: cl });
    return { next, events };
  }
  next.dropTicks = 0;
  next.lastSeen = cl;

  const gapOk = next.lastSentAt == null || now - Date.parse(next.lastSentAt) >= MIN_SEND_GAP_MS;

  if (next.phase === 'burst') {
    if (next.burstSent < BURST_MESSAGES && gapOk) {
      next.burstSent += 1;
      next.lastSentAt = iso;
      const last = next.burstSent >= BURST_MESSAGES;
      events.push({ kind: 'burst', n: next.burstSent, of: BURST_MESSAGES, claimable: cl, inc: cl - next.burstBase, baseline: next.burstBase, last });
      if (last) { next.phase = 'idle'; next.baseline = cl; next.burstBase = null; }
    }
    return { next, events };
  }

  if (cl - next.baseline >= thr && gapOk) {
    next.phase = 'burst';
    next.burstBase = next.baseline;
    next.burstStartedAt = iso;
    next.burstSent = 1;
    next.lastSentAt = iso;
    events.push({ kind: 'burst', n: 1, of: BURST_MESSAGES, claimable: cl, inc: cl - next.baseline, baseline: next.baseline, last: false });
  }
  return { next, events };
}

export function formatEvent(ev, ctx) {
  const { asset, wallet, unit, usdPer, minIncrease, at } = ctx;
  const f = (v) => fmtAmount(v, unit, usdPer);
  const head = `<b>${esc(asset)}</b>`;
  const foot = [`👛 ${shortAddr(wallet)}`, `⏰ ${at}`];
  if (ev.kind === 'armed') {
    const rule = minIncrease > 0 ? `an increase of at least ${unit === 'USD' || unit === 'SOL' ? '$' + minIncrease : minIncrease + ' ' + unit}` : 'any increase';
    return ['🔔 <b>CLAIM ALERT ARMED</b> — ' + head, '', `Baseline: <b>${f(ev.baseline)}</b> claimable now.`, `You will be alerted on ${rule} above it.`, '', ...foot].join('\n');
  }
  if (ev.kind === 'claimed') {
    return ['✅ <b>CLAIMED</b> — ' + head, '', `Claimable dropped from ${f(ev.from)} to <b>${f(ev.to)}</b>.`, `Baseline reset to ${f(ev.to)}; watching for the next increase.`, '', ...foot].join('\n');
  }
  const lines = [`💰 <b>CLAIMABLE YIELD</b> — ${head}  (${ev.n}/${ev.of})`, '', `Claimable now: <b>${f(ev.claimable)}</b>`, `Increase: <b>+${f(ev.inc)}</b> (baseline ${f(ev.baseline)})`];
  if (ev.last) lines.push('', `Last reminder for this increase — quiet until it rises further (new baseline ${f(ev.claimable)}).`);
  lines.push('', ...foot);
  return lines.join('\n');
}

// ─── The runner ──────────────────────────────────────────────────────────────

/**
 * deps (all injected):
 *   now()                          - ms since epoch
 *   readFiles()                    - { config, state } parsed JSON or null (throws when the Gist cannot be read)
 *   writeState(obj)                - persist claim-alert-state.json
 *   getMarkets()                   - Map vault -> { rate, decimals, ticker }  (may throw: stored vault rates are used then)
 *   getSolUsd()                    - number | null
 *   getAccounts(addresses)         - Buffer|null per address, same order (throws on failure)
 *   sendTelegram(chatId, html)     - boolean
 */
export async function runClaimCheck(deps) {
  const now = deps.now();
  const iso = new Date(now).toISOString();
  const out = { ok: true, checked: 0, armed: 0, sent: 0, claimed: 0, errors: 0, timestamp: iso };

  let files;
  try { files = await deps.readFiles(); }
  catch (e) { return { ok: false, error: 'Could not read the alert Gist: ' + sanitize(e.message), timestamp: iso }; }

  const config = files.config;
  const prevState = files.state && typeof files.state === 'object' ? files.state : {};
  const state = JSON.parse(JSON.stringify({
    version: 1,
    chats: prevState.chats || {},
    solUsd: prevState.solUsd ?? null,
    solUsdAt: prevState.solUsdAt ?? null,
    lastTick: prevState.lastTick || { at: null, ok: true, error: null, failStreak: 0, warned: false },
    lastWrite: prevState.lastWrite || null,
  }));

  // the pairs to watch
  const work = [];            // { chatId, asset, cfgRow, wallet, walletSetAt }
  const chatErrors = {};      // chatId -> text
  const rowErrors = [];       // [chatId, asset, text]: written after the pruning below
  for (const [chatId, chat] of Object.entries(config?.chats || {})) {
    const assets = chat?.assets || {};
    const enabled = Object.entries(assets).filter(([, r]) => r && r.enabled);
    if (enabled.length === 0) continue;
    const wallet = String(chat.wallet || DEFAULT_WALLET).trim();
    if (!isAddress(wallet)) { chatErrors[chatId] = 'wallet is not a valid address'; continue; }
    for (const [asset, cfgRow] of enabled) {
      if (!cfgRow.vault || !isAddress(cfgRow.vault)) { out.errors++; rowErrors.push([chatId, asset, 'no vault address in the config row']); continue; }
      work.push({ chatId, asset, cfgRow, wallet, walletSetAt: chat.walletSetAt || '' });
    }
  }

  // forget state of pairs that are no longer enabled (re-enabling re-arms with a fresh baseline)
  const wanted = new Set(work.map((w) => w.chatId + '\u0000' + w.asset));
  for (const [chatId, rows] of Object.entries(state.chats)) {
    for (const asset of Object.keys(rows)) if (!wanted.has(chatId + '\u0000' + asset) && !(chatErrors[chatId])) delete rows[asset];
    if (Object.keys(rows).length === 0) delete state.chats[chatId];
  }

  for (const [chatId, asset, msg] of rowErrors) setRowError(state, chatId, asset, msg);

  if (work.length === 0) {
    // nothing to watch: write only when the state changed (rows were pruned), never a heartbeat
    state.lastTick = { at: iso, ok: true, error: null, failStreak: 0, warned: false };
    for (const [chatId, msg] of Object.entries(chatErrors)) setRowError(state, chatId, '(wallet)', msg);
    await maybeWrite(deps, state, prevState, now, iso, { heartbeat: false });
    return { ...out, message: 'no enabled claim alerts' };
  }

  // one chain read for every position and vault
  const addrs = [];
  const idx = new Map();
  const want = (a) => { if (!idx.has(a)) { idx.set(a, addrs.length); addrs.push(a); } return idx.get(a); };
  for (const w of work) { w.posAddr = positionAddress(w.cfgRow.vault, w.wallet); w.iPos = want(w.posAddr); w.iVault = want(w.cfgRow.vault); }

  let accounts;
  try { accounts = await deps.getAccounts(addrs); }
  catch (e) { return await failTick(deps, state, prevState, work, now, iso, 'chain read failed: ' + sanitize(e.message), out); }

  let markets = null;
  try { markets = await deps.getMarkets(); } catch { markets = null; }

  let solUsd = null;
  if (work.some((w) => unitOf(markets?.get(w.cfgRow.vault)?.ticker ?? state.chats[w.chatId]?.[w.asset]?.unit) === 'SOL')) {
    try { solUsd = await deps.getSolUsd(); } catch { solUsd = null; }
    if (solUsd) { state.solUsd = solUsd; state.solUsdAt = iso; }
    else if (state.solUsd && state.solUsdAt && now - Date.parse(state.solUsdAt) < 24 * 3600_000) solUsd = state.solUsd;
  }

  const sends = [];   // { chatId, asset, kind, text, commit() / hold() }
  for (const w of work) {
    const { chatId, asset, cfgRow, wallet } = w;
    const prevRow = state.chats[chatId]?.[asset];
    try {
      const meta = markets?.get(cfgRow.vault);
      const ticker = meta?.ticker;
      const unit = ticker != null ? unitOf(ticker) : prevRow?.unit;
      const decimals = meta?.decimals ?? prevRow?.decimals;
      if (!unit || decimals == null) throw new Error('vault is not in the Exponent API and was never seen before');

      const vault = decodeVault(accounts[w.iVault]);
      const posBuf = accounts[w.iPos];
      if (!posBuf && prevRow && prevRow.yt > 0) throw new Error('position account not returned by the RPC (read problem?)');
      const pos = posBuf ? decodePosition(posBuf) : { yt: 0n, idx: 0, staged: 0n };
      const apiRate = meta?.rate;
      const rate = Math.max(Number.isFinite(apiRate) ? apiRate : 0, vault.storedRate);
      const rateSource = Number.isFinite(apiRate) && apiRate > vault.storedRate ? 'api' : 'stored';
      const cl = claimableRaw(pos, vault.feeBps, rate) / 10 ** decimals;

      const usdPer = unit === 'USD' ? 1 : unit === 'SOL' ? solUsd : null;
      const minInc = cfgRow.minIncrease == null || cfgRow.minIncrease === '' ? null : Number(cfgRow.minIncrease);
      if (unit === 'SOL' && !usdPer && minInc > 0) throw new Error('no SOL price available for a dollar threshold');
      const thr = thresholdUnits(minInc, usdPer);

      const armKey = armKeyOf(wallet, w.walletSetAt, cfgRow);
      const { next, events } = stepRow({ prev: prevRow, armKey, cl, usdPer, thr, now });
      out.checked++;

      const obs = { wallet, vault: cfgRow.vault, unit, decimals, usdPer: usdPer ?? null, claimable: cl, claimableUsd: usdPer ? cl * usdPer : null, rate, rateSource, yt: Number(pos.yt) / 10 ** decimals, checkedAt: iso, error: null };
      const row = { ...next, ...obs };
      if (!state.chats[chatId]) state.chats[chatId] = {};
      state.chats[chatId][asset] = row;

      for (const ev of events) {
        if (ev.kind === 'armed') out.armed++;
        const text = formatEvent(ev, { asset, wallet, unit, usdPer, minIncrease: minInc, at: iso });
        sends.push({ chatId, asset, kind: ev.kind, text, prev: prevRow, row });
        row.lastEvent = ev.kind; row.lastEventAt = iso;
      }
    } catch (e) {
      out.errors++;
      setRowError(state, chatId, asset, sanitize(e.message));
    }
  }

  for (const s of sends) {
    let ok = false;
    try { ok = await deps.sendTelegram(s.chatId, s.text); } catch { ok = false; }
    if (ok) { if (s.kind === 'burst') out.sent++; if (s.kind === 'claimed') out.claimed++; continue; }
    // a burst message that did not go out does not count: put the burst counters back (retry next tick)
    if (s.kind === 'burst' && s.prev) {
      for (const k of ['phase', 'baseline', 'burstBase', 'burstSent', 'burstStartedAt', 'lastSentAt']) s.row[k] = s.prev[k];
      s.row.error = 'telegram send failed';
    } else if (s.kind === 'burst') {
      s.row.phase = 'idle'; s.row.burstSent = 0; s.row.lastSentAt = null; s.row.error = 'telegram send failed';
    }
  }

  // tick bookkeeping, one-time warning after a long outage and the recovery note
  const lt = state.lastTick;
  const wasWarned = !!lt.warned && lt.failStreak >= FAIL_WARN_STREAK;
  const hadFailures = (lt.failStreak || 0) > 0;
  state.lastTick = { at: iso, ok: true, error: null, failStreak: 0, warned: false };
  if (wasWarned) {
    for (const chatId of new Set(work.map((w) => w.chatId))) {
      try { await deps.sendTelegram(chatId, '✅ <b>Claim alerts recovered</b> — the chain and Exponent API reads work again.'); } catch { /* ignore */ }
    }
  }
  for (const [chatId, msg] of Object.entries(chatErrors)) setRowError(state, chatId, '(wallet)', msg);

  await maybeWrite(deps, state, prevState, now, iso, { force: hadFailures });
  return out;
}

function setRowError(state, chatId, asset, msg) {
  if (!state.chats[chatId]) state.chats[chatId] = {};
  state.chats[chatId][asset] = { ...(state.chats[chatId][asset] || {}), error: msg, checkedAt: new Date().toISOString() };
}

async function failTick(deps, state, _prevState, work, _now, iso, error, out) {
  const lt = state.lastTick;
  const streak = (lt.failStreak || 0) + 1;
  let warned = !!lt.warned;
  if (streak >= FAIL_WARN_STREAK && !warned) {
    warned = true;
    for (const chatId of new Set(work.map((w) => w.chatId))) {
      try { await deps.sendTelegram(chatId, `⚠️ <b>Claim alerts cannot read the chain</b> for ${streak} minutes (${esc(error)}). No claim alerts can fire until it recovers.`); } catch { /* ignore */ }
    }
  }
  state.lastTick = { at: iso, ok: false, error, failStreak: streak, warned };
  // every failing tick is written: the streak must persist to reach the warning (one PATCH a minute, only during an outage)
  await safeWrite(deps, state, iso);
  return { ...out, ok: false, error, timestamp: iso };
}

async function safeWrite(deps, state, iso) {
  state.lastWrite = iso;
  try { await deps.writeState(state); } catch { /* the next tick tries again */ }
}

/** Write when a machine field changed (or force), else at most every HEARTBEAT_MS (unless heartbeat is off). */
async function maybeWrite(deps, state, prevState, now, iso, opt = {}) {
  const sig = (s) => JSON.stringify(Object.fromEntries(Object.entries(s.chats || {}).map(([c, rows]) => [c, Object.fromEntries(Object.entries(rows).map(([a, r]) => [a, [r.armKey, r.baseline, r.phase, r.burstBase, r.burstSent, r.lastSentAt, r.error ?? null, r.unit ?? null, r.wallet ?? null, r.dropTicks ?? 0]]))])));
  const changed = sig(state) !== sig(prevState);
  const lastWrite = prevState.lastWrite ? Date.parse(prevState.lastWrite) : 0;
  const beat = opt.heartbeat !== false && (!lastWrite || now - lastWrite >= HEARTBEAT_MS);
  if (changed || beat || opt.force) await safeWrite(deps, state, iso);
}

// ─── Real network dependencies (used by api/claim-check.js) ──────────────────

export function makeRealDeps(env, fetchImpl = fetch) {
  const need = (k) => { if (!env[k]) throw new Error(k + ' is not set'); return env[k]; };
  const gistUrl = () => `https://api.github.com/gists/${need('ALERTS_GIST_ID')}`;
  const ghHeaders = () => ({ Authorization: `token ${need('GIST_TOKEN')}`, 'User-Agent': 'Hylo-Claim-Check', Accept: 'application/vnd.github+json' });
  const timeout = (ms) => AbortSignal.timeout(ms);

  return {
    now: () => Date.now(),

    async readFiles() {
      const res = await fetchImpl(gistUrl(), { headers: ghHeaders(), signal: timeout(9000) });
      if (!res.ok) throw new Error('Gist read HTTP ' + res.status);
      const gist = await res.json();
      const parse = (name) => { const c = gist.files?.[name]?.content; if (!c) return null; try { return JSON.parse(c); } catch { return null; } };
      return { config: parse(CONFIG_FILE), state: parse(STATE_FILE) };
    },

    async writeState(state) {
      const res = await fetchImpl(gistUrl(), {
        method: 'PATCH',
        headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: { [STATE_FILE]: { content: JSON.stringify(state, null, 2) } } }),
        signal: timeout(9000),
      });
      if (!res.ok) throw new Error('Gist write HTTP ' + res.status);
    },

    async getMarkets() {
      const res = await fetchImpl(MARKETS_URL, { signal: timeout(8000) });
      if (!res.ok) throw new Error('markets HTTP ' + res.status);
      const arr = await res.json();
      const m = new Map();
      for (const e of arr) if (e?.vaultAddress) m.set(e.vaultAddress, { rate: Number(e.syExchangeRate), decimals: Number(e.decimals ?? 9), ticker: e.quoteAsset?.ticker });
      return m;
    },

    async getSolUsd() {
      const res = await fetchImpl(JUP_PRICE_URL, { signal: timeout(5000) });
      if (!res.ok) return null;
      const j = await res.json();
      const p = Number(j?.[SOL_MINT]?.usdPrice);
      return Number.isFinite(p) && p > 5 && p < 5000 ? p : null;
    },

    async getAccounts(addresses) {
      const url = need('CLAIM_RPC_URL');
      const result = [];
      for (let i = 0; i < addresses.length; i += 100) {
        const chunk = addresses.slice(i, i + 100);
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [chunk, { encoding: 'base64', commitment: 'confirmed' }] }),
          signal: timeout(8000),
        });
        if (!res.ok) throw new Error('RPC HTTP ' + res.status);
        const j = await res.json();
        if (j.error) throw new Error('RPC error ' + (j.error.code ?? ''));
        const vals = j.result?.value;
        if (!Array.isArray(vals) || vals.length !== chunk.length) throw new Error('RPC returned an unexpected answer');
        for (const v of vals) result.push(v && v.data ? Buffer.from(v.data[0], 'base64') : null);
      }
      return result;
    },

    async sendTelegram(chatId, text) {
      const res = await fetchImpl(`https://api.telegram.org/bot${need('YIELD_BOT_TOKEN')}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
        signal: timeout(8000),
      });
      return res.ok;
    },
  };
}
