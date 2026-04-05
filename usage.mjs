#!/usr/bin/env node
/**
 * cc-usage: Live-updating Claude Code usage monitor
 *
 * Reads OAuth tokens from ~/.claude/.credentials.json (same store Claude Code uses),
 * auto-refreshes when expired, and polls https://api.anthropic.com/api/oauth/usage
 * every 30s with live progress bars.
 *
 * Headless / status-bar flags:
 *   --headless          Fetch once, print a compact single line, exit.
 *   --format=plain      (default) Plain text, no ANSI codes.
 *   --format=i3blocks   Three-line output: full / short / #RRGGBB — for i3blocks.
 *   --format=json       Raw usage JSON from the API.
 *
 * Exit codes in headless mode:
 *   0  — all limits below 80 %
 *   1  — at least one limit ≥ 80 %
 *   2  — at least one limit ≥ 95 %
 */

import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// ─── CLI args ────────────────────────────────────────────────────────────────
const ARGS     = process.argv.slice(2)
const HEADLESS = ARGS.includes('--headless')
const FORMAT   = (() => {
  const f = ARGS.find(a => a.startsWith('--format='))
  return f ? f.split('=')[1] : 'plain'
})()

// ─── Config ──────────────────────────────────────────────────────────────────
const POLL_INTERVAL_MS = 30_000
const API_URL          = 'https://api.anthropic.com/api/oauth/usage'
const TOKEN_URL        = 'https://platform.claude.com/v1/oauth/token'
const CLIENT_ID        = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const CREDS_PATH       = join(homedir(), '.claude', '.credentials.json')
const BAR_WIDTH        = 40

// ─── Token management ────────────────────────────────────────────────────────
function readCreds() {
  return JSON.parse(readFileSync(CREDS_PATH, 'utf8'))
}

function writeCreds(creds) {
  writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2), 'utf8')
}

function loadTokens() {
  try {
    const oauth = readCreds()?.claudeAiOauth
    if (!oauth?.accessToken) throw new Error('No accessToken in credentials')
    return oauth
  } catch (err) {
    console.error(`Failed to read credentials from ${CREDS_PATH}: ${err.message}`)
    process.exit(1)
  }
}

function isExpired(tokens) {
  if (!tokens.expiresAt) return false
  // Refresh 60s before actual expiry
  return Date.now() >= tokens.expiresAt - 60_000
}

async function refreshTokens(tokens) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type:    'refresh_token',
      refresh_token: tokens.refreshToken,
      client_id:     CLIENT_ID,
    }),
    signal: AbortSignal.timeout(15_000),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Token refresh failed (${res.status}): ${body.slice(0, 200)}`)
  }

  const data = await res.json()
  const newTokens = {
    ...tokens,
    accessToken:  data.access_token,
    refreshToken: data.refresh_token ?? tokens.refreshToken,
    expiresAt:    Date.now() + data.expires_in * 1000,
  }

  // Write back so other Claude Code instances see the new tokens
  try {
    const creds = readCreds()
    creds.claudeAiOauth = newTokens
    writeCreds(creds)
  } catch (err) {
    // Non-fatal — we still have valid tokens in memory
  }

  return newTokens
}

// ─── API fetch ───────────────────────────────────────────────────────────────
async function fetchUsage(tokens) {
  const res = await fetch(API_URL, {
    headers: {
      'Authorization':  `Bearer ${tokens.accessToken}`,
      'Content-Type':   'application/json',
      'anthropic-beta': 'oauth-2025-04-20',
    },
    signal: AbortSignal.timeout(8_000),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`)
  }
  return res.json()
}

// ─── ANSI helpers ─────────────────────────────────────────────────────────────
const R     = '\x1b[0m'
const BOLD  = '\x1b[1m'
const DIM   = '\x1b[2m'
const GREEN = '\x1b[32m'
const YEL   = '\x1b[33m'
const RED   = '\x1b[31m'
const CYAN  = '\x1b[36m'

function colorForPct(pct) {
  if (pct < 50) return GREEN
  if (pct < 80) return YEL
  return RED
}

function progressBar(ratio) {
  const pct    = Math.min(Math.round(ratio * 100), 100)
  const filled = Math.round(Math.min(ratio, 1) * BAR_WIDTH)
  const empty  = BAR_WIDTH - filled
  return colorForPct(pct) + '█'.repeat(filled) + DIM + '░'.repeat(empty) + R
}

function formatResetAt(isoStr) {
  if (!isoStr) return ''
  const d      = new Date(isoStr)
  const diffMs = d - Date.now()
  if (diffMs <= 0) return 'resetting…'
  const h      = Math.floor(diffMs / 3_600_000)
  const m      = Math.floor((diffMs % 3_600_000) / 60_000)
  const parts  = []
  if (h > 0) parts.push(`${h}h`)
  parts.push(`${m}m`)
  const time   = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const day    = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
  return `resets in ${parts.join(' ')} (${day} ${time})`
}

function renderLimitBar(label, limit) {
  if (!limit || limit.utilization === null) return null
  const pct      = Math.floor(limit.utilization)
  const color    = colorForPct(pct)
  const bar      = progressBar(limit.utilization / 100)
  const resetStr = limit.resets_at ? `  ${DIM}${formatResetAt(limit.resets_at)}${R}` : ''
  return `${BOLD}${label}${R}\n${bar} ${color}${pct}% used${R}${resetStr}`
}

function renderExtraUsage(extra) {
  if (!extra?.is_enabled) return null
  if (extra.monthly_limit === null) {
    return `${BOLD}Extra usage${R}\n${DIM}Unlimited${R}`
  }
  if (typeof extra.used_credits !== 'number' || typeof extra.utilization !== 'number') return null
  const used  = (extra.used_credits  / 100).toFixed(2)
  const limit = (extra.monthly_limit / 100).toFixed(2)
  const now   = new Date()
  const reset = new Date(now.getFullYear(), now.getMonth() + 1, 1)
  const pct   = Math.floor(extra.utilization)
  const color = colorForPct(pct)
  const bar   = progressBar(extra.utilization / 100)
  const resetStr = `  ${DIM}resets ${reset.toLocaleDateString([], { month: 'short', day: 'numeric' })}${R}`
  return `${BOLD}Extra usage${R}\n${bar} ${color}${pct}% used${R}  ${DIM}$${used} / $${limit}${R}${resetStr}`
}

function render(data, lastUpdated, status) {
  const lines = []
  lines.push(`${BOLD}${CYAN}◆ Claude Code — Rate Limit Usage${R}`)
  lines.push(DIM + '─'.repeat(60) + R)

  if (status?.type === 'error') {
    lines.push(`${RED}Error: ${status.msg}${R}`)
  } else if (status?.type === 'refreshing') {
    lines.push(`${DIM}Refreshing token…${R}`)
  } else if (!data) {
    lines.push(`${DIM}Loading…${R}`)
  } else {
    const sections = [
      renderLimitBar('Current session  (5-hour window)', data.five_hour),
      renderLimitBar('Current week — all models  (7-day window)', data.seven_day),
      renderLimitBar('Current week — Sonnet only  (7-day window)', data.seven_day_sonnet),
      renderExtraUsage(data.extra_usage),
    ].filter(Boolean)

    if (sections.length === 0) {
      lines.push(`${DIM}/usage is only available for subscription plans.${R}`)
    } else {
      lines.push(...sections.flatMap(s => [s, '']))
    }
  }

  lines.push(DIM + '─'.repeat(60) + R)
  const timeStr = lastUpdated ? new Date(lastUpdated).toLocaleTimeString() : '—'
  lines.push(`${DIM}Updated: ${timeStr}  ·  auto-refresh every ${POLL_INTERVAL_MS / 1000}s  ·  [r] refresh  ·  [q/Ctrl+C] quit${R}`)
  return lines.join('\n')
}

// ─── Headless rendering ─────────────────────────────────────────────────────

/** Returns the worst utilization pct across all active limits (0-100). */
function worstPct(data) {
  const vals = [
    data.five_hour?.utilization,
    data.seven_day?.utilization,
    data.seven_day_sonnet?.utilization,
    data.extra_usage?.is_enabled ? data.extra_usage?.utilization : null,
  ].filter(v => typeof v === 'number')
  return vals.length ? Math.max(...vals) : 0
}

/** Exit code based on worst utilisation pct. */
function exitCodeFor(pct) {
  if (pct >= 95) return 2
  if (pct >= 80) return 1
  return 0
}

/** #RRGGBB hex color matching the TUI colour logic (Nord palette). */
function hexColorForPct(pct) {
  if (pct < 50) return '#A3BE8C'   // Nord14 green
  if (pct < 80) return '#EBCB8B'   // Nord13 yellow
  return '#BF616A'                  // Nord11 red
}

/** Compact label + pct for one limit, e.g. "5h:42%". */
function fmtLimit(label, limit) {
  if (!limit || limit.utilization === null) return null
  return `${label}:${Math.floor(limit.utilization)}%`
}

/** Build the parts array used by both plain and i3blocks formatters. */
function buildParts(data) {
  const parts = [
    fmtLimit('5h',  data.five_hour),
    fmtLimit('7d',  data.seven_day),
    fmtLimit('snt', data.seven_day_sonnet),
  ].filter(Boolean)

  if (data.extra_usage?.is_enabled) {
    if (data.extra_usage.monthly_limit === null) {
      parts.push('extra:∞')
    } else if (typeof data.extra_usage.utilization === 'number') {
      parts.push(`extra:${Math.floor(data.extra_usage.utilization)}%`)
    }
  }

  return parts
}

function renderHeadlessPlain(data) {
  if (!data) return 'CC: no data'
  const parts = buildParts(data)
  if (parts.length === 0) return 'CC: no subscription'
  return `CC: ${parts.join(' | ')}`
}

function renderHeadlessI3blocks(data) {
  if (!data) {
    return ['CC: no data', 'CC: n/a', '#888888'].join('\n')
  }
  const parts = buildParts(data)
  if (parts.length === 0) {
    return ['CC: no subscription', 'CC: —', '#888888'].join('\n')
  }
  const full  = `CC: ${parts.join(' | ')}`
  // Short text: only the highest-utilisation limit
  const worst = [
    { label: '5h',  u: data.five_hour?.utilization },
    { label: '7d',  u: data.seven_day?.utilization },
    { label: 'snt', u: data.seven_day_sonnet?.utilization },
  ]
    .filter(x => typeof x.u === 'number')
    .sort((a, b) => b.u - a.u)[0]
  const short = worst ? `CC ${worst.label}:${Math.floor(worst.u)}%` : 'CC'
  const color = hexColorForPct(worstPct(data))
  return [full, short, color].join('\n')
}

async function runHeadless() {
  let tokens = loadTokens()

  if (isExpired(tokens)) {
    try { tokens = await refreshTokens(tokens) }
    catch (err) {
      process.stderr.write(`cc-usage: token refresh failed: ${err.message}\n`)
      process.exit(3)
    }
  }

  let data
  try {
    data = await fetchUsage(tokens)
  } catch (err) {
    process.stderr.write(`cc-usage: fetch failed: ${err.message}\n`)
    process.exit(3)
  }

  if (FORMAT === 'json') {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n')
    process.exit(0)
  }

  if (FORMAT === 'i3blocks') {
    process.stdout.write(renderHeadlessI3blocks(data) + '\n')
  } else {
    process.stdout.write(renderHeadlessPlain(data) + '\n')
  }

  process.exit(exitCodeFor(worstPct(data)))
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  let tokens      = loadTokens()
  let data        = null
  let lastUpdated = null
  let status      = null

  const redraw = () => {
    process.stdout.write('\x1b[2J\x1b[H')   // clear + cursor home
    process.stdout.write('\x1b[?25l')        // hide cursor
    console.log(render(data, lastUpdated, status))
  }

  async function refresh() {
    // Re-read creds from disk in case Claude Code refreshed them between polls
    try { tokens = loadTokens() } catch {}

    if (isExpired(tokens)) {
      status = { type: 'refreshing' }
      redraw()
      try {
        tokens = await refreshTokens(tokens)
      } catch (err) {
        status = { type: 'error', msg: `Token refresh failed: ${err.message}` }
        redraw()
        return
      }
    }

    try {
      data        = await fetchUsage(tokens)
      lastUpdated = Date.now()
      status      = null
    } catch (err) {
      status = { type: 'error', msg: err.message }
    }
    redraw()
  }

  redraw()           // initial "loading" frame
  await refresh()    // first real fetch

  const timer = setInterval(refresh, POLL_INTERVAL_MS)

  // Keypress handling
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', key => {
      if (key === 'r' || key === 'R') {
        refresh()
      } else if (key === '\x03' || key === 'q' || key === 'Q') {
        cleanup()
        process.exit(0)
      }
    })
  }

  function cleanup() {
    clearInterval(timer)
    process.stdout.write('\x1b[?25h')  // restore cursor
    process.stdout.write('\n')
  }

  process.on('SIGINT', () => { cleanup(); process.exit(0) })
  process.on('SIGTERM', () => { cleanup(); process.exit(0) })
}

if (HEADLESS) {
  runHeadless().catch(err => { console.error(err); process.exit(3) })
} else {
  main().catch(err => { console.error(err); process.exit(1) })
}
