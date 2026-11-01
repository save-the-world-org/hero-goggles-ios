#!/usr/bin/env node
/**
 * credentials.mjs: the secrets this repository relies on, and when they lapse.
 *
 * The manifest's `credentials` list is the record. Each entry names a secret a
 * workflow reads, what breaks without it and how to rotate it, so an agent can
 * see what the repository depends on without reading every workflow.
 *
 *   check   Offline, for CI. Every `secrets.X` a workflow reads is declared,
 *           and every declared credential is read where its `usedBy` says. A
 *           list that lies is worse than no list, so either mismatch fails.
 *
 *   expiry  Network, for a daily schedule. For each `github-token` it asks
 *           GitHub when the token expires: every API response made with an
 *           expiring token carries GitHub-Authentication-Token-Expiration, so
 *           no date is written down to go stale on the next rotation. It posts
 *           to SLACK_WEBHOOK_URL at 30 and 15 days, then every day from 7, and
 *           fails from 7 days out, so the run is red as well as loud.
 *
 * Zero dependencies, and no host globals it does not import: it runs before
 * anything is installed, and whatever ESLint the repository has lints it.
 * Neither a token nor the webhook is ever printed.
 *
 *   node <harness directory>/scripts/credentials.mjs check
 *   node <harness directory>/scripts/credentials.mjs expiry [--notify-test]
 *
 * Test hooks: --target DIR, --now ISO, --expires ISO (skips GitHub),
 * --dry-run (prints what it would post, and posts nothing).
 */

import process from 'node:process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const cmd = argv[0]
const flag = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? null : argv[i + 1]
}
const has = (name) => argv.includes(`--${name}`)
const root = resolve(flag('target') ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..'))
const out = (line) => process.stdout.write(`${line}\n`)

/**
 * The Actions expression that reads a secret, built rather than written: the
 * scaffold's placeholder check refuses a literal double brace in the payload.
 */
const expression = (name) => ['$', '{'.repeat(2), ` secrets.${name} `, '}'.repeat(2)].join('')

const DAY = 86_400_000
const WORKFLOW_DIRS = ['.github/workflows', '.gitea/workflows', '.forgejo/workflows']
const IGNORED = new Set(['GITHUB_TOKEN'])
const KEY_FIX = {
  kind: 'say what it is: "github-token" has its expiry checked; anything else is only listed',
  breaks: 'say what stops working when it lapses',
  rotate: 'say how to replace it, as a command',
}

/**
 * The manifest, found the way bb-harness finds it: in the one top-level entry
 * whose name starts with a dot (never .git), that is a directory, and that
 * holds a harness.json parsing to an object with a numeric `harness`. This
 * ships alone and imports nothing, so the rule is written here too; the CLI's
 * findHarness() is the one to keep it in step with.
 */
function manifest() {
  const found = []
  for (const name of readdirSync(root).sort()) {
    if (!name.startsWith('.') || name === '.git') continue
    try {
      if (!statSync(join(root, name)).isDirectory()) continue
      const parsed = JSON.parse(readFileSync(join(root, name, 'harness.json'), 'utf8'))
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && typeof parsed.harness === 'number') {
        found.push({ name, parsed })
      }
    } catch {
      // No harness.json there, or one that is not a manifest: not the harness.
    }
  }
  if (found.length > 1) throw new Error(`${root} holds ${found.length} harness directories, ${found.map((h) => h.name).join(' and ')}: keep one`)
  if (found.length === 0) throw new Error(`no harness manifest under ${root}`)
  return found[0].parsed
}

/** Every secret each workflow reads, as file -> Set(name). Comment lines do not count. */
function secretsRead() {
  const reads = new Map()
  const pattern = /\bsecrets\.([A-Za-z_][A-Za-z0-9_]*)|\bsecrets\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g
  for (const dir of WORKFLOW_DIRS) {
    const abs = join(root, dir)
    if (!existsSync(abs)) continue
    for (const name of readdirSync(abs).sort()) {
      if (!/\.ya?ml$/.test(name)) continue
      const text = readFileSync(join(abs, name), 'utf8')
        .split('\n')
        .filter((line) => !/^\s*#/.test(line))
        .join('\n')
      const found = new Set()
      for (const m of text.matchAll(pattern)) {
        const secret = m[1] ?? m[2]
        if (!IGNORED.has(secret)) found.add(secret)
      }
      if (found.size) reads.set(`${dir}/${name}`, found)
    }
  }
  return reads
}

function check() {
  const m = manifest()
  const fails = []
  const fail = (msg, fix) => fails.push({ msg, fix })
  const reads = secretsRead()
  const readBy = new Map()
  for (const [file, names] of reads) {
    for (const n of names) readBy.set(n, [...(readBy.get(n) ?? []), file])
  }

  if (m.credentials !== undefined && !Array.isArray(m.credentials)) {
    fail('credentials is not a list', 'make it an array of { name, kind, usedBy, breaks, rotate }')
  }
  const list = Array.isArray(m.credentials) ? m.credentials : []
  const seen = new Set()
  for (const c of list) {
    const name = String(c?.name ?? '')
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      fail(`a credential has no usable name (${JSON.stringify(c?.name)})`, 'name it exactly as the secret is named')
      continue
    }
    if (seen.has(name)) fail(`${name} is declared twice`, 'keep one entry per secret')
    seen.add(name)
    for (const key of ['kind', 'breaks', 'rotate']) {
      if (!String(c[key] ?? '').trim()) fail(`${name} has no ${key}`, KEY_FIX[key])
    }
    const usedBy = Array.isArray(c.usedBy) ? c.usedBy : []
    if (usedBy.length === 0) fail(`${name} names no workflow in usedBy`, 'list the workflow files that read it')
    for (const file of usedBy) {
      if (!existsSync(join(root, file))) fail(`${name}: usedBy names ${file}, which does not exist`, 'fix the path, or take it out')
      else if (!reads.get(file)?.has(name)) fail(`${name}: usedBy names ${file}, which never reads secrets.${name}`, 'take it out of usedBy, or wire the secret in')
    }
    for (const file of readBy.get(name) ?? []) {
      if (!usedBy.includes(file)) fail(`${name} is read by ${file}, which its usedBy leaves out`, `add ${file} to usedBy`)
    }
    if (!readBy.has(name)) fail(`${name} is declared, but no workflow reads it`, 'take it out: nothing needs it any more')
  }
  for (const [name, files] of readBy) {
    if (!seen.has(name)) {
      fail(`${files.join(', ')} ${files.length > 1 ? 'read' : 'reads'} secrets.${name}, which harness.json does not declare`,
        `add { "name": "${name}", "kind", "usedBy", "breaks", "rotate" } to credentials`)
    }
  }

  for (const f of fails) out(`  [FAIL] ${f.msg}\n         ${f.fix}`)
  if (fails.length) out(`\n  ${fails.length} failing`)
  else if (m.credentials === undefined) out('  credentials ok: the manifest keeps no credentials list, and no workflow reads a secret')
  else out(`  credentials ok (${list.length} declared)`)
  return fails.length ? 1 : 0
}

/** Warn at 30 and 15 days, then every day from 7; a daily run lands on each exactly once. */
function levelFor(days) {
  if (days < 0) return 'expired'
  if (days <= 7) return 'urgent'
  if (days === 15 || days === 30) return 'notice'
  return 'ok'
}

function parseExpiry(raw) {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*(UTC|Z|[+-]\d{2}:?\d{2})?$/.exec(raw.trim())
  if (!m) return new Date(raw)
  const zone = !m[3] || m[3] === 'UTC' || m[3] === 'Z' ? 'Z' : m[3].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2')
  return new Date(`${m[1]}T${m[2]}${zone}`)
}

async function askGitHub(token) {
  try {
    const res = await globalThis.fetch('https://api.github.com/rate_limit', {
      headers: {
        authorization: `Bearer ${token}`,
        'user-agent': 'bb-harness-credentials',
        'x-github-api-version': '2022-11-28',
      },
    })
    if (res.status === 401) return { rejected: 401 }
    if (!res.ok) return { error: `HTTP ${res.status}` }
    const raw = res.headers.get('github-authentication-token-expiration')
    return { expires: raw ? parseExpiry(raw) : null }
  } catch (error) {
    return { error: String(error?.message ?? error) }
  }
}

async function expiry() {
  const m = manifest()
  const list = Array.isArray(m.credentials) ? m.credentials : []
  const now = flag('now') ? new Date(flag('now')) : new Date()
  const where = process.env.GITHUB_REPOSITORY || m.product || 'this repository'
  const webhook = process.env.SLACK_WEBHOOK_URL
  const dry = has('dry-run')
  const notifyTest = has('notify-test')
  const messages = []
  let bad = false

  const tokens = list.filter((c) => c?.kind === 'github-token')
  if (tokens.length === 0) out('  no github-token credentials declared; nothing here expires')
  for (const c of tokens) {
    let expires
    if (flag('expires')) {
      expires = new Date(flag('expires'))
    } else {
      const value = process.env[c.name]
      if (!value) {
        out(`  [FAIL] ${c.name} is not in the environment`)
        out(`         map it in the workflow: env: ${c.name}: ${expression(c.name)}`)
        bad = true
        continue
      }
      const asked = await askGitHub(value)
      if (asked.rejected) {
        out(`  ${c.name}: rejected by GitHub (${asked.rejected})`)
        messages.push(`:x: *${c.name}* was rejected by GitHub (${asked.rejected}): expired or revoked, in ${where}. Broken until it is replaced: ${c.breaks} Rotate: ${c.rotate}`)
        bad = true
        continue
      }
      if (asked.error) {
        out(`  [WARN] ${c.name}: could not ask GitHub (${asked.error}); the next run asks again`)
        continue
      }
      if (!asked.expires) {
        out(`  ${c.name}: does not expire`)
        if (notifyTest) messages.push(`:white_check_mark: The credential watch for ${where} is wired. *${c.name}* does not expire.`)
        continue
      }
      expires = asked.expires
    }

    const days = Math.floor((expires.getTime() - now.getTime()) / DAY)
    const level = levelFor(days)
    const date = expires.toISOString().slice(0, 10)
    const plural = days === 1 ? 'day' : 'days'
    out(`  ${c.name}: expires ${date} (${days} ${plural}) -> ${level}`)
    if (level === 'expired') {
      messages.push(`:x: *${c.name}* expired on ${date}, in ${where}. Broken until it is replaced: ${c.breaks} Rotate: ${c.rotate}`)
    } else if (level === 'urgent') {
      messages.push(`:rotating_light: *${c.name}* expires in ${days} ${plural} (${date}), in ${where}. Rotate it before it lapses; when it does: ${c.breaks} Rotate: ${c.rotate}`)
    } else if (level === 'notice') {
      messages.push(`:warning: *${c.name}* expires in ${days} days (${date}), in ${where}. When it lapses: ${c.breaks} Rotate: ${c.rotate}`)
    } else if (notifyTest) {
      messages.push(`:white_check_mark: The credential watch for ${where} is wired. *${c.name}* expires ${date}, in ${days} days; the first warning comes at 30.`)
    }
    if (level === 'urgent' || level === 'expired') bad = true
  }

  if (notifyTest && messages.length === 0) messages.push(`:white_check_mark: The credential watch for ${where} is wired; nothing here expires.`)
  if (notifyTest && !webhook && !dry) {
    out('  [FAIL] --notify-test needs SLACK_WEBHOOK_URL in the environment')
    bad = true
  }
  for (const text of messages) {
    if (dry) {
      out(`  would post: ${text}`)
      continue
    }
    if (!webhook) {
      out(`::warning::${text}`)
      continue
    }
    const res = await globalThis.fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    }).catch((error) => ({ ok: false, status: String(error?.message ?? error) }))
    if (res.ok) {
      out('  posted to Slack')
    } else {
      out(`  [FAIL] Slack refused the message (${res.status})`)
      bad = true
    }
  }
  return bad ? 1 : 0
}

function usage() {
  out('credentials.mjs <check|expiry> [--notify-test] [--target DIR] [--now ISO] [--expires ISO] [--dry-run]')
  return cmd ? 2 : 0
}

const run = cmd === 'check' ? Promise.resolve().then(check)
  : cmd === 'expiry' ? expiry()
  : Promise.resolve(usage())
run.then(
  (code) => { process.exitCode = code },
  (error) => { out(`credentials: ${error?.message ?? error}`); process.exitCode = 2 },
)
