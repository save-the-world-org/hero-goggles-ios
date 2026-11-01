#!/usr/bin/env node
/**
 * SessionStart hook: orient an agent from the harness, cheaply.
 *
 * Whatever this prints is added to the session's context before the first
 * prompt, and it is paid for again in every session. So it prints pointers and
 * the newest state, never a whole file: the first paragraph of the mission,
 * the newest few decisions as one line each, the latest progress entry, where
 * the backlog stands, and where to read more. The whole of it is capped at
 * ~6 KB and 100 lines. Anything it cuts is named, with the lines to open.
 *
 * The harness is found the way the guard and the CLI find it, by harnessesIn()
 * in guard.mjs beside this file: at the git top level of $CLAUDE_PROJECT_DIR
 * (or of the session's directory, or that directory itself outside git), the
 * one directory whose name starts with a dot that holds a harness manifest.
 * Two of them, and it says so and reads neither. Paths come from the manifest
 * through the CLI's `path <key>`, the same way CI and scripts find them; the
 * CLI is the manifest's `paths.cli`, or bin/bb-harness.mjs in the harness
 * directory. It also says how the repository delivers its work, which is the
 * mode the guard enforces: the one committed at origin/HEAD (committedDelivery()
 * in guard.mjs), with a line more when the working tree says otherwise. And
 * which template version the harness came from. Every manifest key it shows
 * is optional: an absent one drops its line.
 *
 * Quiet by design: in a repository without the harness it prints nothing, and
 * any failure prints nothing and exits 0. Set BB_HARNESS_ORIENT=0 to turn it
 * off (for a runner whose prompt already says what to read).
 *
 * Zero dependencies, Node 22 or newer. Host globals are imported, not assumed.
 */

import process from 'node:process'
import { Buffer } from 'node:buffer'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'

const MAX_BYTES = 6000
const MAX_LINES = 100
const DECISIONS_SHOWN = 4
const PROGRESS_MAX = 3200

function input() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    // Run by hand, or given nothing: carry on with the environment.
    return {}
  }
}

/** Resolve one manifest key through the CLI; null if it is not declared. */
function pathOf(root, cli, key) {
  return new Promise((done) => {
    execFile(process.execPath, [cli, 'path', key], { cwd: root, timeout: 5000 }, (error, stdout) => {
      done(error ? null : String(stdout).trim() || null)
    })
  })
}

/**
 * The git top level of `dir`, or `dir` itself where there is none: a scaffold
 * before `git init`. `gitEnv` is guard.mjs's GIT_ENV: no git call either hook
 * makes reaches the network or reads through a replace ref.
 */
function rootOf(dir, gitEnv) {
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...gitEnv },
    }).trim()
    return top || dir
  } catch {
    // Not a repository, or no git on the PATH: the directory is the root.
    return dir
  }
}

function read(root, rel) {
  if (!rel) return null
  try {
    return readFileSync(join(root, rel), 'utf8')
  } catch {
    // Declared and missing is validate's complaint, not this hook's.
    return null
  }
}

/* ── markdown, just enough ─────────────────────────────────────────────── */

/** `## ` sections outside code fences: { heading, start (1-based), lines }. */
function sections(text) {
  const out = []
  let current = null
  let fence = false
  text.split('\n').forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    if (!fence && line.startsWith('## ')) {
      current = { heading: line.slice(3).trim(), start: i + 1, lines: [] }
      out.push(current)
    } else if (current) {
      current.lines.push(line)
    }
  })
  return out
}

/** Prose paragraphs: blank-line separated; headings, fences, tables and rules skipped. */
function paragraphs(lines) {
  const out = []
  let buf = []
  let fence = false
  const flush = () => {
    if (buf.length > 0) out.push(buf.join(' ').replace(/\s+/g, ' ').trim())
    buf = []
  }
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) { flush(); fence = !fence; continue }
    if (fence) continue
    if (/^\s*$/.test(line) || line.startsWith('#') || /^\s*\|/.test(line) || /^\s*<!--/.test(line) || /^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flush()
      continue
    }
    buf.push(line.trim())
  }
  flush()
  return out
}

const clip = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`)

/** A JSON field shown as prose, on one line: a title can be written over several. */
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim()

/** The first sentence, without a short bold label such as **Decision.** in front. */
function firstSentence(paragraph, n = 200) {
  let p = paragraph
  const label = /^\*\*([^*]{1,40})\*\*\s*/.exec(p)
  if (label && label[1].trim().split(/\s+/).length <= 3 && /[.:]$/.test(label[1].trim())) p = p.slice(label[0].length)
  p = p.replace(/\*\*|__/g, '')
  const end = /(?<!\b(?:e\.g|i\.e|etc|vs|cf|No))[.!?](?=\s|$)/g
  let m
  while ((m = end.exec(p)) !== null) {
    if (m.index >= 12) return clip(p.slice(0, m.index + 1), n)
  }
  return clip(p, n)
}

/** Dated `## YYYY-MM-DD …` entries; the template's placeholder date sorts oldest. */
function entries(text) {
  return sections(text)
    .map((s) => ({ ...s, date: /^\d{4}-\d{2}-\d{2}/.exec(s.heading)?.[0] ?? (s.heading.startsWith('YYYY-MM-DD') ? '0000-00-00' : null) }))
    .filter((s) => s.date !== null)
}

/** Newest first, whichever way the file is written. Ties keep the file's own order. */
function newestFirst(list, fileIsNewestFirst) {
  const real = list.filter((e) => e.date !== '0000-00-00')
  let nf = fileIsNewestFirst
  if (real.length >= 2 && real[0].date !== real[real.length - 1].date) nf = real[0].date > real[real.length - 1].date
  return list
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.date === b.e.date ? (nf ? a.i - b.i : b.i - a.i) : a.e.date < b.e.date ? 1 : -1))
    .map((x) => x.e)
}

const trimBlank = (lines) => {
  let a = 0
  let b = lines.length
  while (a < b && lines[a].trim() === '') a += 1
  while (b > a && lines[b - 1].trim() === '') b -= 1
  return lines.slice(a, b)
}

/* ── the blocks ────────────────────────────────────────────────────────── */

function missionBlock(text, rel) {
  const lines = text.split('\n')
  const body = lines.slice(lines.findIndex((l) => l.startsWith('# ')) + 1)
  const first = paragraphs(body)[0]
  if (!first) return []
  const heads = sections(text).map((s) => s.heading)
  const out = [`MISSION (${rel}):`, `  ${clip(first, 600)}`]
  if (heads.length > 0) out.push(`  sections: ${clip(heads.join(' · '), 300)}`)
  return out
}

function decisionsBlock(text, rel) {
  const all = newestFirst(entries(text), true)
  if (all.length === 0) return []
  const shown = all.slice(0, DECISIONS_SHOWN)
  const out = [`DECISIONS, newest ${shown.length} of ${all.length} (${rel}):`]
  for (const d of shown) {
    const paras = paragraphs(d.lines)
    const chosen = paras.find((p) => /^\*\*Decision[.:]?\*\*/.test(p)) ?? paras[0] ?? ''
    const title = clip(d.heading.replace(/^(\d{4}-\d{2}-\d{2}|YYYY-MM-DD)\s*[—–-]*\s*/, ''), 140)
    out.push(`  - ${d.date === '0000-00-00' ? 'undated' : d.date} ${title}${chosen ? ` — ${firstSentence(chosen)}` : ''}`)
  }
  return out
}

/** The latest entry, fitted to `room` bytes; its Next paragraph is kept whole if it can be. */
function progressBlock(text, rel, room) {
  const latest = newestFirst(entries(text), false)[0]
  if (!latest) return []
  const lead = latest.lines.findIndex((l) => l.trim() !== '')
  const body = trimBlank(latest.lines)
  const end = latest.start + latest.lines.length
  const head = `PROGRESS, latest entry (${rel}, lines ${latest.start}–${end}):`
  const lines = [`  ## ${latest.heading}`, ...body.map((l) => (l === '' ? '' : `  ${l}`))]
  const size = (ls) => ls.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0)
  if (size(lines) + head.length <= room) return [head, ...lines]

  const nextAt = body.findIndex((l) => /^(\*\*Next[.:]?\*\*|#+\s*Next\b|Next[.:]\s)/.test(l.trim()))
  let tail = nextAt >= 0 ? body.slice(nextAt).map((l) => (l === '' ? '' : `  ${l}`)) : []
  if (size(tail) > room / 2) tail = [...tail.slice(0, 8), '  […]']
  const kept = [head, lines[0]]
  let used = size(kept) + size(tail) + 120
  let i = 1
  const limit = nextAt >= 0 ? nextAt + 1 : lines.length
  while (i < limit && used + Buffer.byteLength(lines[i]) + 1 <= room) {
    used += Buffer.byteLength(lines[i]) + 1
    kept.push(lines[i])
    i += 1
  }
  const skipped = limit - i
  const first = latest.start + Math.max(lead, 0) + i
  if (skipped > 0) kept.push(`  […${skipped} lines not shown: ${rel} lines ${first}–${first + skipped - 1}]`)
  return [...kept, ...tail]
}

function featuresBlock(text, rel) {
  let list
  try {
    const raw = JSON.parse(text)
    list = Array.isArray(raw) ? raw : raw.features ?? []
  } catch {
    // A feature list that does not parse is validate's to report.
    return []
  }
  if (list.length === 0) return []
  const counts = new Map()
  for (const f of list) {
    const state = String(f.state ?? f.status ?? 'unknown')
    counts.set(state, (counts.get(state) ?? 0) + 1)
  }
  const tally = [...counts].map(([s, n]) => `${n} ${s}`).join(' · ')
  const out = [`FEATURES (${rel}): ${tally}`]
  const active = list.filter((f) => ['active', 'in_progress'].includes(String(f.state ?? f.status)))
  for (const f of active.slice(0, 2)) out.push(`  now: ${oneLine(f.id ?? '?')} — ${clip(oneLine(f.title ?? ''), 120)}`)
  return out
}

const COUNTS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']

/** `a and b`, or `a, b and c`. */
const andList = (items) => (items.length <= 2 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`)

/** More than one manifest: name them, and say that none is read until one is left. */
function severalBlock(found) {
  const manifests = found.map((h) => `${h.dir}/harness.json`)
  return [`HARNESS: ${COUNTS[found.length] ?? found.length} harness manifests: ${andList(manifests)}; keep one. Until then none of them is read, and the guard holds this repository to pull requests.`]
}

/** Where the guard reads the mode, and what it found there, for a working tree that says otherwise. */
function followed(committed) {
  const ref = committed.ref ?? 'origin/HEAD'
  if (committed.why === null) return `${ref}, which says ${committed.mode}`
  if (committed.why === 'no-ref') return 'origin/HEAD, which this repository does not have (nor origin/main or origin/master), so pull-request'
  if (committed.why === 'no-harness') return `${ref}, which holds no harness manifest, so pull-request`
  if (committed.why === 'several') return `${ref}, which holds more than one harness manifest, so pull-request`
  if (committed.why === 'too-big') return `${ref}, whose harness manifest is over 1 MiB and is not read, so pull-request`
  if (committed.why === 'missing') return `${ref}, whose harness manifest this partial clone does not have (a checkout fetches it; the guard never does), so pull-request`
  return `${ref}, which git did not answer for in time, so pull-request`
}

/**
 * How this repository lands its work, which is what the guard enforces: the
 * mode committed at origin/HEAD, named with where it was read. When the
 * working tree's manifest says otherwise, one line more says so, because the
 * guard follows the commit. A delivery the guard cannot read as a mode is
 * named, so a typo is visible here rather than as a refusal nobody can
 * explain. Then the template version the harness came from, when the
 * manifest records one.
 */
function deliveryBlock(manifest, dir, committed, deliveryOf) {
  const shown = committed.manifest ?? manifest
  const rel = committed.manifest ? `${committed.dir}/harness.json at ${committed.ref}` : `${dir}/harness.json`
  const delivery = shown.delivery
  const said = delivery !== null && typeof delivery === 'object' && !Array.isArray(delivery) ? delivery.mode : delivery
  let line = committed.mode === 'trunk'
    ? `DELIVERY (${rel}): this repository lands work on main (trunk). Commit on main and push it; the guard still refuses force pushes, deleting main, --mirror, --all and --no-verify.`
    : `DELIVERY (${rel}): this repository lands work through pull requests. Branch off main and open a pull request; the guard refuses a commit or a push to main.`
  if (said !== undefined && said !== deliveryOf(shown)) {
    line += ` It reads as pull-request because delivery is ${clip(oneLine(JSON.stringify(delivery)), 80)}, and the modes are {"mode": "pull-request"} and {"mode": "trunk"}.`
  }
  const out = [line]
  const here = deliveryOf(manifest)
  if (here !== committed.mode) out.push(`  The working tree says ${here}; the guard follows ${followed(committed)}.`)
  const version = manifest.template?.version
  if ((typeof version === 'string' && version.trim() !== '') || Number.isFinite(version)) {
    out.push(`TEMPLATE: harness template version ${clip(oneLine(version), 80)}.`)
  }
  return out
}

/**
 * How Claude Code comes to have the instructions file, if it does: 'link'
 * when CLAUDE.md is a link to it, 'import' when CLAUDE.md imports it
 * (`@AGENTS.md` or `@./AGENTS.md`, a word of its own outside code spans and
 * fences, which is what Claude Code reads as an import), 'absent' when there
 * is no CLAUDE.md here, and null when there is one that does neither: a
 * CLAUDE.md is read in place of AGENTS.md, not beside it.
 *
 * With no CLAUDE.md it depends on the Claude Code: from v2.1.277 it reads
 * AGENTS.md on its own when no CLAUDE.md (here, above here, or a
 * CLAUDE.local.md) applies, unless a setting says otherwise, and before that
 * it reads none. A hook cannot see which one is running, so it says neither.
 */
function agentsLoaded(root, instructions) {
  const claude = join(root, 'CLAUDE.md')
  let link
  try {
    link = lstatSync(claude).isSymbolicLink()
  } catch {
    // No CLAUDE.md: whether the instructions file is loaded turns on the Claude Code version (above).
    return 'absent'
  }
  try {
    if (link) return readlinkSync(claude).endsWith(instructions) ? 'link' : null
    const path = instructions.replace(/^\.\//, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const imports = new RegExp(`(^|\\s)@(\\./)?${path}(?=\\s|$)`)
    let fence = false
    for (const line of readFileSync(claude, 'utf8').split('\n')) {
      if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue }
      if (!fence && imports.test(line.replace(/`[^`]*`/g, ''))) return 'import'
    }
    return null
  } catch {
    // A CLAUDE.md this process cannot read: nothing says it imports the instructions file.
    return null
  }
}

/* ── assemble ──────────────────────────────────────────────────────────── */

const HEAD = 'Harness orientation, from .claude/hooks/session-start.mjs: the newest state only, capped at 6 KB. The files are the record; open them for more.'

async function orient(start) {
  if (process.env.BB_HARNESS_ORIENT === '0') return ''
  // Found by the rule the guard enforces with, so the two never disagree.
  const { committedDelivery, deliveryOf, harnessesIn, GIT_ENV } = await import('./guard.mjs')
  const root = rootOf(start, GIT_ENV)
  const found = harnessesIn(root)
  if (found.length === 0) return ''
  if (found.length > 1) return `${[HEAD, '', ...severalBlock(found)].join('\n')}\n`

  const { dir, manifest } = found[0]
  const declared = manifest.paths !== null && typeof manifest.paths === 'object' ? manifest.paths : {}
  const cli = typeof declared.cli === 'string' && declared.cli.trim() !== '' ? declared.cli : `${dir}/bin/bb-harness.mjs`
  const hasCli = existsSync(resolve(root, cli))
  const keys = ['instructions', 'mission', 'decisions', 'progress', 'features', 'goldenRules', 'knowledge']
  const p = hasCli ? Object.fromEntries(await Promise.all(keys.map(async (k) => [k, await pathOf(root, cli, k)]))) : {}

  const out = [HEAD]
  const add = (block) => { if (block.length > 0) out.push('', ...block) }

  add(deliveryBlock(manifest, dir, committedDelivery(root), deliveryOf))
  const mission = read(root, p.mission)
  if (mission) add(missionBlock(mission, p.mission))
  const decisions = read(root, p.decisions)
  if (decisions) add(decisionsBlock(decisions, p.decisions))
  const features = read(root, p.features)
  const featureLines = features ? featuresBlock(features, p.features) : []

  const more = ['MORE:']
  if (p.instructions) {
    const loaded = agentsLoaded(root, p.instructions)
    const how = loaded === 'import' ? `CLAUDE.md imports it (@${p.instructions}), so it is already loaded.`
      : loaded === 'link' ? 'CLAUDE.md is a link to it, so it is already loaded.'
        : loaded === 'absent' && p.instructions === 'AGENTS.md'
          ? 'There is no CLAUDE.md here: Claude Code reads AGENTS.md on its own from v2.1.277 when no CLAUDE.md applies, and not before. If it is not in your context, read it before changing anything.'
          : 'Claude Code does not load it by itself: read it before changing anything.'
    more.push(`  ${p.instructions} is the map and the loop. ${how}`)
  }
  const refs = [p.goldenRules && `golden rules ${p.goldenRules}`, p.knowledge && `what was learned ${p.knowledge}/`].filter(Boolean)
  if (refs.length > 0) more.push(`  ${refs.join(' · ')}`)
  if (hasCli) more.push(`  any other path: node ${cli} path <key>`)

  const progress = read(root, p.progress)
  if (progress) {
    const spent = Buffer.byteLength([...out, ...featureLines, ...more].join('\n')) + 8
    add(progressBlock(progress, p.progress, Math.min(PROGRESS_MAX, Math.max(1200, MAX_BYTES - spent))))
  }
  add(featureLines)
  if (more.length > 1) add(more)

  // Count what prints, not the entries that print it: one entry can hold
  // newlines, and a feature title written over several came out at 130 lines.
  let lines = out.join('\n').split('\n')
  if (lines.length > MAX_LINES) lines = [...lines.slice(0, MAX_LINES - 1), '[…cut at 100 lines]']
  let text = `${lines.join('\n')}\n`
  if (Buffer.byteLength(text) > MAX_BYTES) text = `${Buffer.from(text).subarray(0, MAX_BYTES - 40).toString('utf8').replace(/\uFFFD$/, '')}\n[…cut at 6 KB]\n`
  return text
}

try {
  const given = input()
  const start = process.env.CLAUDE_PROJECT_DIR || (typeof given.cwd === 'string' && given.cwd) || process.cwd()
  process.stdout.write(await orient(start))
} catch {
  // Orientation is a convenience. It never stops a session from starting.
}
