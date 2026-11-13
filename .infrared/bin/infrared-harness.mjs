#!/usr/bin/env node
/**
 * infrared-harness: the manifest-driven harness CLI.
 *
 * The upstream harness tooling (walkinglabs/learn-harness-engineering,
 * tools/audit-harness.sh) hardcodes every path it checks: PROGRESS.md at the
 * root, .harness/arch-rules.json, a Makefile with named targets. That is fine
 * for a tutorial and wrong for us: we keep the harness in a directory of its
 * own, and we run npm scripts, not make.
 *
 * So paths are DATA, in the manifest (harness.json, in the harness directory),
 * and this is the only thing that reads them. CI asks `infrared-harness path
 * progress` rather than knowing where PROGRESS.md lives. Moving a file is a
 * one-line change to the manifest and nothing else.
 *
 * THE HARNESS DIRECTORY IS FOUND, NOT NAMED. It is the one top-level entry of
 * the repository whose name starts with a dot (never .git), that is a
 * directory, and that holds a harness.json parsing to an object with a numeric
 * `harness`. A repository may call it what it likes, so nothing that ships
 * into a repository writes the name down: this finds it, the scripts locate
 * themselves, and the hooks apply the same rule. The manifest's `root` says the same name, and `validate` holds it
 * to that.
 *
 * Zero dependencies, on purpose: this runs in a scaffolded repo before
 * anything is installed.
 *
 *   infrared-harness init     [--target DIR] [--product NAME] [--root .NAME]
 *   infrared-harness sync     [--target DIR] [--from CHECKOUT] [--dry-run] [--adopt] [--force]
 *   infrared-harness path     <key>                   one path; exit 3 when the manifest keeps none
 *   infrared-harness validate [--target DIR] [--json] the gate; exit 1 on any failure
 *   infrared-harness tailored [--target DIR] [--json] has this repo been made about its business?
 *   infrared-harness vcr      [--target DIR]          passing / activated, the completion ratio
 */

import process from 'node:process'
import { Buffer } from 'node:buffer'
import { createHash, randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  accessSync, closeSync, constants, existsSync, fchmodSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync,
  readlinkSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, join, posix, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/**
 * Where `init` and `sync` take the template from by default: the
 * harness-template checkout this copy runs in, which holds `template/` and the
 * version. A copy vendored into a repository has neither beside it, and says
 * so rather than guessing.
 */
const CHECKOUT = resolve(HERE, '..')
/** The manifest's name inside the harness directory. The directory is found; this is how. */
const MANIFEST = 'harness.json'
/** How work reaches main. The guard reads `delivery.mode`; `validate` holds it to these. */
const DELIVERY_MODES = ['pull-request', 'trunk']
/** `path`'s exit status for a key the manifest does not keep: an answer, not an error. */
const NOT_KEPT = 3
/**
 * The keys whose place is the template's layout, not the manifest's: a script
 * finds the harness as the directory above its own, and runs the CLI at bin/
 * in it. `validate` refuses a manifest that moves either; `sync` puts each
 * where the template has it.
 */
const LAYOUT = ['cli', 'scripts']

const argv = process.argv.slice(2)
const cmd = argv[0]
const has = (name) => argv.includes(`--${name}`)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const value = argv[i + 1]
  if (value === undefined || value.startsWith('--')) die(`--${name} needs a value`)
  return value
}
/** The repository being acted on. Set once the arguments are read, inside the try below. */
let target = resolve('.')

const out = (line) => process.stdout.write(`${line}\n`)
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const isDir = (p) => { try { return statSync(p).isDirectory() } catch { return false } }
const isFile = (p) => { try { return statSync(p).isFile() } catch { return false } }
const digest = (bytes) => `sha256-${createHash('sha256').update(bytes).digest('hex')}`
/** A path with its symlinks resolved, so two spellings of one directory compare equal (macOS's /var is /private/var). */
const real = (p) => { try { return realpathSync(p) } catch { return resolve(p) } }
const posixRel = (from, to) => relative(from, to).split(sep).join('/')
/** A path as the person running this would type it: relative to where they are, unless it is elsewhere. */
const shown = (p) => {
  const rel = relative(process.cwd(), p)
  return rel === '' ? '.' : rel.startsWith('..') ? p : rel
}
/** "a", "a and b", "a, b and c". */
const named = (names) => (names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`)
/** An error from the system (a read, a write, a rename), as opposed to one of this file's own. */
const isSystemError = (error) => error instanceof Error && typeof error.code === 'string' && typeof error.syscall === 'string'
/** What a system error says, without the path it carries: "EACCES: permission denied". The caller names the file. */
const because = (error) => `${error.code}: ${String(error.message).replace(/^\w+: /, '').split(', ')[0]}`

/**
 * Abort with a message.
 *
 * `process.exit()` is deliberately NOT used here or in `report()`: when stdout
 * is a pipe — which is every CI consumer of `--json` — it discards whatever has
 * not flushed yet, so the exit code arrived and the findings did not. Setting
 * `process.exitCode` and unwinding lets Node drain and then exit.
 */
class Abort extends Error {}
function die(msg) { process.stderr.write(`infrared-harness: ${msg}\n`); process.exitCode = 2; throw new Abort(msg) }

/* ── finding the harness ────────────────────────────────────────────────── */

/**
 * Every harness directory directly under `dir`, and the near misses.
 *
 * The rule, which the hooks and credentials.mjs apply too: a top-level entry
 * whose name starts with a dot, other than .git; a directory (a symlink to one
 * counts, as it does for `test -d`, here, in credentials.mjs and in
 * session-start's read of the working tree, but not in the guard's: it reads
 * the commit at origin/HEAD, where a link is only a link); holding a
 * harness.json that parses to a JSON object with a numeric `harness`. A
 * harness.json that does not qualify is a near miss: not a harness, but worth
 * naming when nothing else is found.
 */
function findHarness(dir) {
  let names
  try {
    names = readdirSync(dir).sort()
  } catch {
    return { found: [], near: [] }
  }
  const found = []
  const near = []
  for (const name of names) {
    if (!name.startsWith('.') || name === '.git' || !isDir(join(dir, name))) continue
    const file = join(dir, name, MANIFEST)
    if (!existsSync(file)) continue
    let parsed
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      near.push(`${name}/${MANIFEST} is not a manifest: ${error.message}`)
      continue
    }
    if (!isObject(parsed) || typeof parsed.harness !== 'number') {
      near.push(`${name}/${MANIFEST} is not a manifest: it has no numeric "harness"`)
      continue
    }
    found.push({ name, manifest: parsed })
  }
  return { found, near }
}

/** The one harness directory under `dir`: { name, manifest }. None, or two, and it says which. */
function discover(dir) {
  const { found, near } = findHarness(dir)
  if (found.length === 1) return found[0]
  if (found.length > 1) {
    die(`${shown(dir)} holds ${found.length} harness directories, ${named(found.map((h) => h.name))}\n` +
      '  keep one: every tool finds the harness by looking for it, and two is a question none of them can answer')
  }
  die(`no harness manifest under ${shown(dir)}${near.map((n) => `\n  ${n}`).join('')}\n` +
    `  run: node <harness-template checkout>/bin/infrared-harness.mjs init --target ${shown(dir)}`)
}

/** The target's harness: its manifest, its directory's name, and the manifest's path. */
function load() {
  const { name, manifest } = discover(target)
  return { m: manifest, root: name, file: `${name}/${MANIFEST}` }
}

/** A path key's value, or undefined: a key the manifest leaves out is not kept here. */
function pathOf(m, key) {
  const value = m.paths?.[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** A repository-relative path in one spelling: `./a/b/` and `a//b` are `a/b`. */
const tidy = (p) => posix.normalize(p).replace(/^(\.\/)+/, '').replace(/\/+$/, '')

/* ── findings ───────────────────────────────────────────────────────────── */

const findings = []
const skipped = []
const fail = (id, msg, fix) => findings.push({ level: 'fail', id, msg, fix })
const warn = (id, msg, fix) => findings.push({ level: 'warn', id, msg, fix })
/** A check that did not run because the manifest does not keep what it checks. Said, never silent. */
const skip = (id, msg) => skipped.push({ id, msg })

/* ── commands ───────────────────────────────────────────────────────────── */

function cmdPath() {
  const key = argv[1]
  if (!key || key.startsWith('--')) die('usage: infrared-harness path <key>')
  const { m, file } = load()
  const value = pathOf(m, key)
  if (value === undefined) {
    process.stderr.write(`infrared-harness: paths.${key} is not in ${file}: not kept here\n` +
      `  kept: ${Object.keys(m.paths ?? {}).join(', ') || 'nothing'}\n`)
    process.exitCode = NOT_KEPT
    return
  }
  out(value)
}

function cmdVcr() {
  const { m } = load()
  if (pathOf(m, 'features') === undefined) {
    out('no feature list is kept here (paths.features is not in the manifest): nothing to count')
    return
  }
  const fl = readFeatures(m)
  if (!fl) die(`no feature list at ${m.paths.features}`)
  if (fl.error) die(fl.error)
  const activated = fl.features.filter((f) => stateOf(f) !== 'planned').length
  const passing = fl.features.filter((f) => stateOf(f) === 'passing').length
  const ratio = activated === 0 ? 0 : passing / activated
  out(`${passing}/${activated} passing (${(ratio * 100).toFixed(0)}%)`)
}

/** The feature list: { raw, features }, { error } when it does not parse, or null when there is none. */
function readFeatures(m) {
  const rel = pathOf(m, 'features')
  if (rel === undefined || !isFile(join(target, rel))) return null
  try {
    const raw = JSON.parse(readFileSync(join(target, rel), 'utf8'))
    // Accept both shapes: a bare array, or { features: [...] } as the template writes it.
    const features = Array.isArray(raw) ? raw : Array.isArray(raw?.features) ? raw.features : []
    return { raw, features }
  } catch (error) {
    return { error: `${rel} does not parse: ${error.message}`, features: [] }
  }
}

/**
 * A feature's state, under either name — the template writes `state`, and a
 * list kept before the harness may say `status`. `readFeatures` accepts both
 * shapes, so every command asks through here: `vcr` once read `state` alone
 * and reported 0/20 over a backlog with 9 passing.
 */
function stateOf(f) {
  return f.state ?? f.status
}

/* ── writing ────────────────────────────────────────────────────────────── */

/**
 * Put `files` ({ path, bytes, mode }, repository-relative, in the order they
 * are to land) into the target: all of them, or none, as far as one process
 * can see to it. `init` and `sync` write through this and nothing else. An
 * entry `{ path, remove: true }` takes that file away instead, in its turn.
 *
 * Every file is STAGED first: written to a new file beside its destination,
 * opened exclusively so it is one this made and never a link, with any
 * directory it needs made on the way. Only once every one is staged are they
 * renamed into place, in order, so the last, the manifest with its stamp,
 * lands last. A rename replaces what is at the destination; it never writes
 * through it.
 *
 * A destination this process may not write is not replaced around its
 * permission. Renaming over a read-only file succeeds, and a file somebody
 * made read-only is not one they meant to have rewritten. Nor taken away: a
 * removal is asked the same before anything is renamed.
 *
 * A failure while staging takes away every staged file and every directory
 * made for one: nothing was written. A failed rename or removal takes away
 * what had not landed and lists what had. Either way it is exit 2 and one
 * line, never a stack trace, and never the exit 1 that means "refused".
 */
function land(files) {
  const made = []
  const staged = []
  const unstage = (from) => {
    for (const s of staged.slice(from)) {
      if (s.tmp === undefined) continue
      try { unlinkSync(s.tmp) } catch { /* gone already */ }
    }
    for (const dir of [...made].reverse()) {
      try { rmdirSync(dir) } catch { /* not empty: what landed in it stays */ }
    }
  }
  for (const file of files) {
    const at = join(target, file.path)
    try {
      if (file.remove) {
        accessSync(at, constants.W_OK)
        accessSync(dirname(at), constants.W_OK)
        staged.push({ path: file.path, at, remove: true })
        continue
      }
      makeDirs(dirname(at), made)
      if (existsSync(at)) accessSync(at, constants.W_OK)
      const tmp = join(dirname(at), `.${basename(at)}.${randomBytes(6).toString('hex')}.harness-staged`)
      const fd = openSync(tmp, 'wx', 0o600)
      staged.push({ path: file.path, at, tmp })
      try {
        writeFileSync(fd, file.bytes)
        fchmodSync(fd, file.mode)
      } finally {
        closeSync(fd)
      }
    } catch (error) {
      unstage(0)
      if (!isSystemError(error)) throw error
      die(`could not ${file.remove ? 'remove' : 'write'} ${shown(at)} (${because(error)}): nothing was written`)
    }
  }
  for (const [i, s] of staged.entries()) {
    try {
      if (s.remove) unlinkSync(s.at)
      else renameSync(s.tmp, s.at)
    } catch (error) {
      unstage(i)
      if (!isSystemError(error)) throw error
      for (const done of staged.slice(0, i)) out(`  ${done.remove ? 'removed' : 'landed '}    ${done.path}`)
      die(`could not ${s.remove ? `remove ${shown(s.at)}` : `move ${shown(s.at)} into place`} (${because(error)}): ` +
        `${i} of ${staged.length} landed, listed above, and the rest did not, ${shown(staged.at(-1).at)} among them; ` +
        'settle that, then run this again')
    }
  }
}

/**
 * The first symbolic link on the way from the target down to `rel`, `rel`
 * itself included, as a repository-relative path; undefined when there is
 * none. lstat, never stat: a write through a link lands wherever the link
 * points, over a file the repository owns or outside the repository, and
 * through a dangling one it makes a file there. Above the target is the
 * caller's to choose (macOS's /tmp is a link), so the walk starts below it.
 */
function linkOnPath(rel) {
  const segments = rel.split('/')
  for (let i = 1; i <= segments.length; i += 1) {
    const sub = segments.slice(0, i).join('/')
    let stat
    try {
      stat = lstatSync(join(target, sub))
    } catch {
      return undefined // nothing there, so nothing under it either
    }
    if (stat.isSymbolicLink()) return sub
  }
  return undefined
}

/** Where the link at `link` points, as a refusal names it: " (to X)", or " (to X, which does not exist)". */
function pointsTo(link) {
  const at = join(target, link)
  let to
  try {
    to = readlinkSync(at)
  } catch {
    return ''
  }
  return existsSync(at) ? ` (to ${to})` : ` (to ${to}, which does not exist)`
}

/** Make `dir` and every parent it lacks, recording each one made, so a write that fails can take them away again. */
function makeDirs(dir, made) {
  if (existsSync(dir)) return
  makeDirs(dirname(dir), made)
  mkdirSync(dir)
  made.push(dir)
}

/* ── init ───────────────────────────────────────────────────────────────── */

/** `p` with the template's harness directory swapped for `to`, when `p` is in it. */
function underRoot(p, from, to) {
  if (p === from) return to
  return p.startsWith(`${from}/`) ? `${to}${p.slice(from.length)}` : p
}

/**
 * The template's harness directory renamed wherever a repository-owned file
 * names it as a path segment: `<dir>/PROGRESS.md`, the `<dir>` directory, the
 * escaped `\\<dir>/` in a grep. A word that merely contains the name (a host
 * name, say) is left alone. The template's own files never name the
 * directory, so they install byte for byte and are never passed through here.
 */
function renamedIn(text, from, to) {
  const name = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.replace(new RegExp(`(?<![\\w.-])${name}(?![\\w-]|\\.\\w)`, 'g'), to)
}

/**
 * The files the template owns, by template-relative path: every file under
 * each `template.vendor` key that the template's `paths` declares.
 */
function vendoredFiles(manifest, dir) {
  const files = new Map()
  for (const key of Array.isArray(manifest.template?.vendor) ? manifest.template.vendor : []) {
    const rel = pathOf(manifest, key)
    if (rel === undefined) continue
    const abs = join(dir, rel)
    for (const file of isDir(abs) ? walk(abs) : isFile(abs) ? [abs] : []) files.set(posixRel(dir, file), key)
  }
  return files
}

/** The template's version: package.json's, the one place it is written. */
function templateVersion(checkout) {
  let version
  try {
    version = JSON.parse(readFileSync(join(checkout, 'package.json'), 'utf8')).version
  } catch {
    // Said below: a checkout with no readable package.json has no version.
  }
  if (typeof version !== 'string' || version === '') {
    die(`${shown(join(checkout, 'package.json'))} has no version: the template's version is written there and nowhere else`)
  }
  return version
}

/**
 * Scaffold the harness into a repository, under the directory name `--root`
 * gives (the template's own by default). What is already there is kept; the
 * manifest records the template's version and the hash of every file of the
 * template's it installed, which is what `validate` and `sync` read later.
 */
function cmdInit() {
  const src = join(CHECKOUT, 'template')
  if (!isDir(src)) die(`template not found at ${src}`)
  const from = discover(src)
  const root = flag('root', from.name)
  const carried = readdirSync(src).filter((name) => name !== from.name)
  if (!/^\.[^/\\]+$/.test(root) || root === '..' || root === '.git' || carried.includes(root)) {
    die(`--root ${root} cannot be a harness directory: that is one name, starting with a dot, and none of .git, ${carried.join(', ')}`)
  }
  if (isDir(target)) {
    const { found } = findHarness(target)
    if (found.length > 0) {
      die(`${shown(target)} already has a harness, in ${named(found.map((h) => h.name))}: init makes one, and a second is one nothing could find\n` +
        `  to bring it up to date: node ${shown(join(CHECKOUT, 'bin', 'infrared-harness.mjs'))} sync --target ${shown(target)}`)
    }
    if (existsSync(join(target, root, MANIFEST))) {
      die(`${shown(join(target, root, MANIFEST))} is there and is not a harness manifest: move it aside, then init`)
    }
  }
  const version = templateVersion(CHECKOUT)
  const vendored = vendoredFiles(from.manifest, src)

  // Every write decided before any is made: each of the template's files that
  // is not there already, read once, so what is stamped is what was written.
  // A symbolic link on the way to one is refused: init would write through it,
  // into whatever it points at. So is one on the way to any of the template's
  // own files, which init stamps. A file of the repository's that is there
  // already is kept, link or not: init does not write it, or read it.
  const writes = new Map()
  const kept = []
  const ours = new Map()
  const linked = new Map()
  for (const abs of walk(src)) {
    const rel = posixRel(src, abs)
    const dst = underRoot(rel, from.name, root)
    const bytes = readFileSync(abs)
    ours.set(rel, bytes)
    const there = existsSync(join(target, dst))
    const link = linkOnPath(dst)
    if (link !== undefined && (!there || vendored.has(rel))) {
      linked.set(link, [...(linked.get(link) ?? []), dst])
      continue
    }
    if (there) {
      kept.push(dst)
      continue
    }
    const renamed = root !== from.name && !vendored.has(rel) && !bytes.includes(0)
      ? Buffer.from(renamedIn(bytes.toString('utf8'), from.name, root), 'utf8')
      : bytes
    writes.set(dst, { path: dst, bytes: renamed, mode: statSync(abs).mode & 0o777 })
  }
  if (linked.size > 0) {
    out(`init ${shown(target)}: refused, and nothing written`)
    for (const [link, under] of linked) {
      const more = under.length > 1 ? ` and ${under.length - 1} more` : ''
      out(`  refused    ${link}: a symbolic link${pointsTo(link)}${under[0] === link ? '' : `, on the way to ${under[0]}${more}`}`)
    }
    out('  init writes nothing through a symbolic link: make each a real directory or file, or remove it, then init again')
    process.exitCode = 1
    return
  }

  // The manifest is always one of them (a target that has one was refused
  // above), and it is made here and written last, stamp and all.
  const file = `${root}/${MANIFEST}`
  const manifest = writes.get(file)
  writes.delete(file)
  const m = JSON.parse(manifest.bytes.toString('utf8'))
  m.root = root
  for (const [key, value] of Object.entries(m.paths ?? {})) {
    if (typeof value === 'string') m.paths[key] = underRoot(value, from.name, root)
  }
  const product = flag('product', null)
  if (product) m.product = product
  const files = {}
  const unstamped = []
  for (const rel of [...vendored.keys()].sort()) {
    const dst = underRoot(rel, from.name, root)
    const want = digest(ours.get(rel))
    const have = writes.get(dst)?.bytes ?? (isFile(join(target, dst)) ? readFileSync(join(target, dst)) : undefined)
    if (have !== undefined && digest(have) === want) files[dst] = want
    else unstamped.push(dst)
  }
  m.template = { ...(isObject(m.template) ? m.template : {}), version, files }
  land([...writes.values(), { ...manifest, bytes: Buffer.from(`${JSON.stringify(m, null, 2)}\n`) }])

  out(`harness scaffolded into ${shown(target)}, in ${root}/, from template ${version}`)
  if (kept.length > 0) out(`  kept what was already there: ${kept.join(', ')}`)
  if (unstamped.length > 0) {
    out(`  not the template's copy, so not stamped: ${unstamped.join(', ')}\n` +
      '    sync --adopt replaces them with the template\'s, and stamps them')
  }
  out(`  next: fill in the verify commands in ${root}/${MANIFEST}, then run node ${pathOf(m, 'cli') ?? `${root}/bin/infrared-harness.mjs`} validate`)
}

/* ── sync ───────────────────────────────────────────────────────────────── */

/**
 * Bring a repository's copy of the template's files up to a template checkout.
 *
 * Which files are the template's is the template's `template.vendor`, read
 * against the TARGET's `paths`: a key the repository leaves out is not kept
 * there, so nothing is installed for it, and each file lands where the
 * repository's manifest puts that key. Everything else in the repository, the
 * manifest's other keys included, is the repository's and is not touched.
 *
 * Every file is decided before any is written. A copy edited since it was
 * stamped, or one never stamped at all, is refused unless --force or --adopt
 * says to replace it, and so is a path git would ignore. A symbolic link on
 * the way to one is refused whatever the flags. One refusal and nothing is
 * written. A file already byte for byte the template's is unchanged whatever
 * its stamp says: there is nothing of the repository's in it to lose.
 */
function cmdSync() {
  const checkout = resolve(flag('from', CHECKOUT))
  const src = join(checkout, 'template')
  if (!isDir(src)) {
    die(has('from')
      ? `${shown(checkout)} is not a harness-template checkout: it has no template/`
      : 'this copy of infrared-harness is not in a harness-template checkout, so it has nothing to sync from\n' +
        '  run the checkout\'s copy, or pass --from <harness-template checkout>')
  }
  const version = templateVersion(checkout)
  const from = discover(src)
  const vendor = from.manifest.template?.vendor
  if (!Array.isArray(vendor) || vendor.length === 0) {
    die(`the template in ${shown(checkout)} names no template.vendor, so it does not say which files are its own`)
  }
  if (real(target) === real(src)) die(`${shown(target)} is the template itself: sync copies it into a repository, never into itself`)
  const { m, root, file } = load()
  const stamped = m.template?.files ?? {}
  if (!isObject(stamped)) die(`${file}: template.files is not an object of path -> sha256\n  remove it, then sync --adopt`)
  const options = { adopt: has('adopt'), force: has('force') }
  const header = `sync ${shown(target)} (${root}/): template ${m.template?.version ?? '(never stamped)'} -> ${version}, from ${shown(checkout)}`

  // The stamp is written into the manifest, so a symbolic link on the way to
  // it is refused before anything else is planned. That is the harness
  // directory being one, too: every file in it would go through the link, to
  // wherever it points. validate and path read through it; sync writes nothing
  // through it.
  const linked = linkOnPath(file)
  if (linked !== undefined) {
    const [what, kind] = linked === root ? ['harness directory', 'directory'] : ['manifest', 'file']
    out(header)
    out(`  refused    ${linked}: the ${what} is a symbolic link${pointsTo(linked)}`)
    out('  to settle the refusals:')
    out(`    make ${linked} a real ${kind}, then sync again: sync writes nothing through a link, the stamp included`)
    out('  nothing written: settle each refusal, then sync again')
    process.exitCode = 1
    return
  }

  const plan = []
  const leaving = []
  const left = new Set()
  const moves = []
  const notKept = []
  const taken = new Set()
  for (const key of vendor) {
    const theirs = pathOf(m, key)
    if (theirs === undefined) {
      notKept.push(key)
      continue
    }
    const ours = pathOf(from.manifest, key)
    const abs = ours === undefined ? undefined : join(src, ours)
    if (abs === undefined || !existsSync(abs)) die(`the template's template.vendor names ${key}, and the template has no file for it`)
    // Where the CLI and the scripts sit is the template's layout, not the
    // manifest's: they go where the template has them, under this repository's
    // harness directory, and a key the template has moved moves here too.
    const was = tidy(theirs)
    const base = LAYOUT.includes(key) ? underRoot(tidy(ours), from.name, root) : was
    if (base !== was) moves.push({ key, from: was, to: base })
    const pairs = isDir(abs) ? walk(abs).map((f) => [f, `/${posixRel(abs, f)}`]) : [[abs, '']]
    for (const [source, sub] of pairs) {
      const rel = `${base}${sub}`
      if (taken.has(rel)) continue
      taken.add(rel)
      plan.push(decide(source, rel, stamped[rel], options))
      if (base === was) continue
      left.add(`${was}${sub}`)
      const gone = leave(`${was}${sub}`, rel, stamped[`${was}${sub}`], options)
      if (gone !== undefined) leaving.push(gone)
    }
  }
  plan.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  leaving.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  // A vendored file git ignores is one the next commit leaves out without a
  // word: the CLI is there on the machine that ran this and nowhere else. The
  // check asks git about the index too, so a file already tracked despite a
  // rule is not refused; a new one under that rule is.
  const git = ignoredBy(plan.filter((p) => p.action !== 'refused').map((p) => p.path))
  for (const p of plan) {
    const hit = git.ignored?.get(p.path)
    if (!hit) continue
    const flat = !hit.pattern.replace(/^\/|\/$/g, '').includes('/')
    const negate = hit.pattern.endsWith('/') ? `!${posix.dirname(p.path)}/` : `!/${p.path}`
    Object.assign(p, {
      action: 'refused',
      why: `git ignores it, by ${hit.rule}`,
      fix: `${flat ? `anchor the rule to the top (/${hit.pattern.replace(/^\//, '')}) if that is what it means, or ` : ''}negate it for the harness path (${negate}) on a line after it`,
    })
  }

  const dropped = Object.keys(stamped).filter((p) => !taken.has(p) && !left.has(p)).sort()
  const all = [...plan, ...leaving]
  out(header)
  for (const p of all) out(`  ${p.action.padEnd(10)} ${p.path}${p.why ? `: ${p.why}` : ''}`)
  for (const key of notKept) {
    out(`  not kept   paths.${key} is not in ${file}, so the template's ${from.manifest.paths?.[key] ?? key} is not installed`)
  }
  for (const p of dropped) out(`  dropped    ${p}: no longer the template's; its stamp goes, and the file stays as this repository's`)
  for (const move of moves) {
    out(`  moved      paths.${move.key} from ${move.from} to ${move.to}, where the template's layout has it: ` +
      `change whatever else here names ${move.from} (a Makefile, CI, a script, AGENTS.md) in the same commit`)
  }
  if (git.skipped) out(`  ${git.skipped}: the check for ignored paths was skipped`)

  const count = (action) => all.filter((p) => p.action === action).length
  out(`\n  ${['added', 'updated', 'unchanged', 'refused'].map((a) => `${count(a)} ${a}`).join(', ')}` +
    `${count('removed') > 0 ? `, ${count('removed')} removed` : ''}${dropped.length > 0 ? `, ${dropped.length} dropped` : ''}`)
  if (count('refused') > 0) {
    // Each way out once: seven files never stamped want one --adopt, not seven.
    out('  to settle the refusals:')
    for (const fix of new Set(all.filter((p) => p.action === 'refused').map((p) => p.fix))) out(`    ${fix}`)
    out('  nothing written: settle each refusal, then sync again')
    process.exitCode = 1
    return
  }
  if (has('dry-run')) {
    out('  dry run: nothing written')
    return
  }

  for (const move of moves) m.paths[move.key] = move.to
  const files = Object.fromEntries(plan.map((p) => [p.path, p.hash]))
  m.template = { ...(isObject(m.template) ? m.template : {}), version, files }
  // The stamp goes last: a sync that stops short leaves the old one, and the
  // next finds whatever did land already the template's, so unchanged. A file
  // moved away goes just before it, once its replacement has landed.
  land([
    ...plan.filter((p) => p.action === 'added' || p.action === 'updated'),
    ...leaving.filter((p) => p.action === 'removed'),
    { path: file, bytes: Buffer.from(`${JSON.stringify(m, null, 2)}\n`), mode: statSync(join(target, file)).mode & 0o777 },
  ])
  out(`  written, and stamped in ${file}: template ${version}`)
}

/** What sync does with one of the template's files: added, updated, unchanged, or refused and why. */
function decide(source, rel, recorded, { adopt, force }) {
  // Read once: the buffer hashed for the plan and the stamp is the one that is
  // written, so a checkout that changes under a sync cannot stamp one version
  // of a file and install another.
  const bytes = readFileSync(source)
  const hash = digest(bytes)
  const entry = { path: rel, source, bytes, hash, mode: statSync(source).mode & 0o777 }
  const refuse = (why, fix) => ({ ...entry, action: 'refused', why, fix })
  const at = resolve(target, rel)
  if (!at.startsWith(target.endsWith(sep) ? target : `${target}${sep}`)) {
    return refuse('outside the repository', 'the manifest puts this key outside the repository: fix its path')
  }
  // A link here, or on the way here, is refused whatever its bytes: a write
  // would land where it points, and even one sync need not write is a link in
  // the repository where the template's file should be, which is what git
  // would commit.
  const link = linkOnPath(rel)
  if (link !== undefined) {
    const [what, kind] = link === rel ? ['a', 'file'] : [`${link} is a`, 'directory']
    return refuse(`${what} symbolic link${pointsTo(link)}`,
      `make ${link} a real ${kind}, or remove it, then sync again: sync writes nothing through a link`)
  }
  const segments = rel.split('/')
  for (let i = 1; i < segments.length; i += 1) {
    const up = segments.slice(0, i).join('/')
    if (existsSync(join(target, up)) && !isDir(join(target, up))) {
      return refuse(`${up} is a file here, where the template has a directory`, `move ${up} aside, or point the manifest elsewhere`)
    }
  }
  if (!existsSync(at)) return { ...entry, action: 'added' }
  if (!isFile(at)) return refuse('a directory here, where the template has a file', 'move it aside')
  const have = digest(readFileSync(at))
  if (have === hash) return { ...entry, action: 'unchanged' }
  if (recorded === undefined) {
    return adopt
      ? { ...entry, action: 'updated', why: 'adopted' }
      : refuse('never stamped, so nothing says whether it was edited here',
        '--adopt takes the template\'s copy; then read git diff for anything this repository had changed')
  }
  if (recorded !== have) {
    return force
      ? { ...entry, action: 'updated', why: 'forced over an edit' }
      : refuse('edited here since it was stamped', 'move the change into harness-template, or --force to replace it')
  }
  return { ...entry, action: 'updated' }
}

/**
 * What sync does with a copy of one of the template's files at a place the
 * template's layout has left, now that the template's is at `to`: removed,
 * refused and why, or undefined when nothing is there. Removed only when it
 * is the template's by its stamp, as decide() would replace it: an edit or a
 * missing stamp is refused, unless --force or --adopt says to take it away.
 */
function leave(rel, to, recorded, { adopt, force }) {
  const entry = { path: rel, remove: true }
  const refuse = (why, fix) => ({ ...entry, action: 'refused', why, fix })
  const at = resolve(target, rel)
  if (!at.startsWith(target.endsWith(sep) ? target : `${target}${sep}`)) {
    return refuse('outside the repository', 'the manifest puts this key outside the repository: fix its path')
  }
  const link = linkOnPath(rel)
  if (link !== undefined) {
    const [what, kind] = link === rel ? ['a', 'file'] : [`${link} is a`, 'directory']
    return refuse(`${what} symbolic link${pointsTo(link)}`,
      `make ${link} a real ${kind}, or remove it, then sync again: sync writes nothing through a link`)
  }
  if (!existsSync(at)) return undefined
  if (!isFile(at)) return refuse(`a directory here, where the template's file was until it moved to ${to}`, 'move it aside')
  const moved = `the template's, moved to ${to}`
  if (recorded === undefined) {
    return adopt
      ? { ...entry, action: 'removed', why: `${moved} (adopted)` }
      : refuse('never stamped, so nothing says whether it was edited here',
        '--adopt takes the template\'s copy; then read git diff for anything this repository had changed')
  }
  if (recorded !== digest(readFileSync(at))) {
    return force
      ? { ...entry, action: 'removed', why: `${moved} (forced over an edit)` }
      : refuse('edited here since it was stamped', 'move the change into harness-template, or --force to replace it')
  }
  return { ...entry, action: 'removed', why: moved }
}

/**
 * Which of `paths` git ignores, with the rule that does it: { ignored: Map },
 * or { skipped: why } where there is no git to ask. Asked once, for all of
 * them, of the target's own repository.
 */
function ignoredBy(paths) {
  const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: target, encoding: 'utf8' })
  if (inside.error) return { skipped: 'git is not installed here' }
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') return { skipped: 'not a git work tree' }
  const ignored = new Map()
  if (paths.length === 0) return { ignored }
  const asked = spawnSync('git', ['check-ignore', '--verbose', '-z', '--stdin'], {
    cwd: target,
    input: paths.map((p) => `${p}\0`).join(''),
    encoding: 'utf8',
  })
  if (asked.status !== 0 && asked.status !== 1) die(`git check-ignore failed in ${shown(target)}: ${String(asked.stderr).trim()}`)
  const fields = asked.stdout.split('\0')
  for (let i = 0; i + 3 < fields.length; i += 4) {
    const [source, line, pattern, path] = fields.slice(i, i + 4)
    // A negated rule that matched means NOT ignored.
    if (!pattern.startsWith('!')) ignored.set(path, { rule: `${source}:${line}:${pattern}`, pattern })
  }
  return { ignored }
}

/* ── validate ───────────────────────────────────────────────────────────── */

/**
 * Has this repository been made about its own business yet?
 *
 * A SEPARATE COMMAND, not part of `validate`, and the distinction is the whole
 * point. A repository that was scaffolded ten seconds ago is *valid* — the
 * harness is intact, the paths resolve, nothing lies. It is simply not yet
 * about anything, and failing `validate` for that would make every fresh repo
 * red for a state it is supposed to pass through.
 *
 * So this is the runtime layer of F-001 and nothing else runs it. It goes green
 * once, and then stays green because a tailored repo does not untailor itself.
 *
 * See `agents/tailor.md` in the harness directory for what an agent is asked
 * to do about each of these.
 */
function cmdTailored() {
  const { m } = load()

  const missionRel = pathOf(m, 'mission')
  if (missionRel === undefined) {
    skip('mission-not-kept', 'no mission is kept here (paths.mission): nothing to check for CHANGE-ME')
  } else {
    const mission = isFile(join(target, missionRel)) ? readFileSync(join(target, missionRel), 'utf8') : ''
    if (mission.includes('CHANGE-ME')) {
      fail('mission-untailored', 'MISSION.md still says CHANGE-ME',
        'write what this repo is, one thing to do next, and how you would know it worked — see agents/tailor.md')
    }
  }

  if (pathOf(m, 'features') === undefined) {
    skip('features-not-kept', 'no feature list is kept here (paths.features): nothing to check for real features')
  } else {
    const fl = readFeatures(m)
    if (fl?.error) fail('features-invalid', fl.error, 'fix the JSON: nothing can read a feature list that does not parse')
    const others = (fl?.features ?? []).filter((f) => f.id !== 'F-001')
    if (others.length === 0) {
      fail('no-real-features', 'the only feature is the one that says to write features',
        'replace F-001 with three to six behaviours a customer would notice')
    }

    // A behaviour is somebody doing something. "Add a schedule component" is a
    // component; "Someone can see when the next session runs" is a behaviour, and
    // the difference is whether there is anyone in the sentence. Checked loosely
    // on purpose — this is a nudge with a name, not a grammar checker.
    const SUBJECT = /\b(someone|somebody|a (customer|visitor|person|reader|buyer)|people|they|the owner|anyone)\b/i
    for (const f of others) {
      const said = String(f.user_visible_behavior ?? '')
      if (said && !SUBJECT.test(said)) {
        warn('behaviour-has-no-subject', `${f.id}: "${said.slice(0, 60)}…" names no one`,
          'say who notices it: "Someone can see …", not "Add a … component"')
      }
    }
  }

  const knowledge = pathOf(m, 'knowledge')
  if (knowledge === undefined) {
    skip('knowledge-not-kept', 'no knowledge bundle is kept here (paths.knowledge): no product note to look for')
  } else if (!existsSync(join(target, knowledge, 'product.md'))) {
    fail('no-product-knowledge', 'knowledge/product.md does not exist',
      'record what you inferred from the brief and — more usefully — what the brief did not say')
  }

  report()
}

function cmdValidate() {
  const { m, root, file } = load()
  // The template still says {{PRODUCT}} where a scaffold has a name. Nothing
  // else in the manifest tells the two apart, and adding a flag would be a
  // second thing to keep true.
  const isTemplate = /\{\{[A-Z_]+\}\}/.test(String(m.product ?? ''))

  // 0. The manifest's root is the directory it was found in. Every tool finds
  //    the harness by looking, so a `root` that says otherwise describes some
  //    other repository, and whoever reads it is misled.
  if (m.root !== root) {
    fail('root-mismatch',
      m.root === undefined ? `${file} has no root; the harness directory is ${root}` : `${file} says root is "${m.root}", but the harness directory is ${root}`,
      `set "root": "${root}" in ${file}: the directory is what every tool finds`)
  }

  // 1. Every declared path exists. A manifest that lies is worse than no manifest.
  for (const [key, rel] of Object.entries(m.paths ?? {})) {
    if (typeof rel !== 'string' || rel === '') {
      fail('path-invalid', `paths.${key} is not a path`, `make it a repository-relative path, or remove paths.${key} from ${file}`)
    } else if (!existsSync(join(target, rel))) {
      fail('path-missing', `paths.${key} points at ${rel}, which does not exist`,
        `create ${rel}, or remove paths.${key} from ${file}`)
    }
  }

  // 2. The root instruction file must stay at the root. Claude Code and Codex
  //    auto-load AGENTS.md/CLAUDE.md from the repo root; a file in the harness
  //    directory is never read unless something points at it. This is the one
  //    path that is NOT free to move, and it is worth failing loudly on.
  const inst = pathOf(m, 'instructions')
  if (inst === undefined) {
    skip('instructions-not-kept', 'no root instructions are kept here (paths.instructions): nothing to hold at the root')
  } else if (inst.includes('/')) {
    fail('instructions-not-at-root', `paths.instructions is "${inst}" — agents only auto-load a root AGENTS.md or CLAUDE.md`,
      `keep a thin AGENTS.md at the repo root that points into ${root}/`)
  }

  // 2b. Where the CLI and the scripts sit is the template's layout, not the
  //     manifest's to move. A script finds the harness directory as the one
  //     above its own, and runs the CLI in it at bin/: a `paths.cli` or
  //     `paths.scripts` that says otherwise names files the scripts never find.
  const layout = [
    ['cli', `${root}/bin/infrared-harness.mjs`, 'the scripts run the CLI from there', 'no CLI is kept here (paths.cli): where it sits was not checked'],
    ['scripts', `${root}/scripts`, 'a script finds the harness as the directory above its own',
      'no scripts are kept here (paths.scripts): where they sit was not checked'],
  ]
  for (const [key, want, why, notKept] of layout) {
    const have = pathOf(m, key)
    if (have === undefined) {
      skip(`${key}-not-kept`, notKept)
    } else if (tidy(have) !== want) {
      fail('layout-moved', `paths.${key} is "${have}", not ${want}, and ${why}`,
        `put it back at ${want}, or let sync move it there: where the CLI and the scripts sit in the harness directory is part of the template, not the manifest's to move`)
    }
  }

  if (pathOf(m, 'features') === undefined) {
    skip('features-not-kept', 'no feature list is kept here (paths.features): the feature checks did not run')
  }
  const fl = readFeatures(m)
  if (fl?.error) fail('features-invalid', fl.error, 'fix the JSON: nothing can read a feature list that does not parse')
  if (fl && !fl.error) {
    const states = new Set(m.rules?.featureStates ?? ['planned', 'active', 'passing'])
    const seen = new Set()

    for (const f of fl.features) {
      const id = f.id ?? '(no id)'
      if (!f.id) fail('feature-no-id', 'a feature has no id', 'give every feature a stable id')
      if (seen.has(f.id)) fail('feature-dup-id', `duplicate feature id ${id}`, 'ids must be unique')
      seen.add(f.id)

      const state = stateOf(f)
      if (!states.has(state)) {
        fail('feature-bad-state', `${id} has state "${state}"`, `use one of: ${[...states].join(', ')}`)
      }

      // 3. The rule the whole thing exists for: passing requires evidence.
      //    An exit code somebody remembers is not evidence, and neither are
      //    `notes`: retrofitted lists write long notes on every feature, so
      //    while they counted, a feature set to passing by hand validated
      //    clean. `evidence` is the field the gate writes.
      if (state === 'passing' && m.rules?.statusRequiresEvidence !== false) {
        const evidence = f.evidence
        if (!evidence || String(evidence).trim().length < 12) {
          const scripts = pathOf(m, 'scripts')
          const gate = scripts ? `bash ${scripts}/verify-feature.sh ${id}` : `verify-feature.sh ${id}`
          fail('passing-without-evidence', `${id} is passing with no evidence${f.notes ? ' (notes are not evidence)' : ''}`,
            `run ${gate}: it records what ran into ${id}.evidence, which is what passing needs`)
        }
      }

      // 4. Layers are how a verification step becomes runnable rather than prose.
      //    `repair` is the half that matters: it tells the next agent what to do
      //    when the layer fails, instead of leaving it to guess.
      // A feature inherits the repo's layers unless it declares its own. Most
      // features verify the way the repo verifies; writing that out per feature
      // is one fact copied N times, which is the thing this manifest exists to
      // stop.
      const layers = Array.isArray(f.layers) ? f.layers : m.verify?.layers
      if (Array.isArray(layers)) {
        layers.forEach((l, i) => {
          if (!l.cmd) fail('layer-no-cmd', `${id} layer[${i}] has no cmd`, 'each layer needs a runnable cmd')
          if (!l.repair) warn('layer-no-repair', `${id} layer[${i}] has no repair`, 'add repair: what to do when this layer fails')
        })
      } else if (state === 'active' || state === 'passing') {
        warn('feature-no-layers', `${id} has no layers[] and the manifest declares no default`,
          'add verify.layers to the manifest, or layers: [{ label, cmd, repair }] to the feature')
      }
    }

    // 5. WIP is per agent, not per repo — see the manifest comment. We can only
    //    check the repo-wide count, so this is a warning with the reason attached.
    const active = fl.features.filter((f) => stateOf(f) === 'active')
    const wip = m.rules?.wip?.perAgent ?? 1
    if (active.length > wip) {
      warn('wip-exceeded', `${active.length} features are active (wip.perAgent is ${wip}): ${active.map((f) => f.id).join(', ')}`,
        'fine if that many agents hold leases; otherwise finish one before activating the next')
    }
  }

  // 6. The knowledge bundle is OKF v0.2 — every concept needs a `type`, which is
  //    the spec's one required field. Cheap to check, and it is the whole
  //    difference between a bundle and a folder of notes.
  const knowledge = pathOf(m, 'knowledge')
  if (knowledge === undefined) {
    skip('knowledge-not-kept', 'no knowledge bundle is kept here (paths.knowledge): the OKF checks did not run')
  } else if (isDir(join(target, knowledge)) && String(m.rules?.knowledgeFormat ?? '').startsWith('okf/')) {
    for (const each of walk(join(target, knowledge))) {
      if (!each.endsWith('.md')) continue
      const base = each.split(sep).pop()
      if (base === 'index.md' || base === 'log.md') continue
      const head = readFileSync(each, 'utf8').slice(0, 600)
      if (!/^---\r?\n/.test(head) || !/^type:\s*\S/m.test(head)) {
        fail('okf-no-type', `${posixRel(target, each)} has no \`type\` in its frontmatter`,
          'OKF v0.2 requires exactly one field: type. Add it.')
      }
    }
  }

  // 7. A placeholder the scaffolder does not know about is a placeholder that
  //    ships to a user verbatim. Every {{TOKEN}} in the payload must be declared
  //    in scaffold.substitute, and every declared token must actually appear.
  //    In the template, a vendored file carries no token at all: the seed
  //    fills tokens into every file but the CLI, so a seeded copy of that file
  //    would not be the template's bytes, and its stamp would mean nothing.
  const declared = Object.keys(m.scaffold?.substitute ?? {})
  const vendored = new Set(Array.isArray(m.template?.vendor) ? m.template.vendor : [])
  const found = new Set()
  for (const [key, rel] of Object.entries(m.paths ?? {})) {
    // The CLI is the thing doing the substituting; it is not substituted. It
    // also necessarily contains the token pattern in its own source.
    if (key === 'cli' || typeof rel !== 'string' || rel === '') continue
    const abs = join(target, rel)
    if (!existsSync(abs)) continue
    const files = isDir(abs) ? walk(abs) : [abs]
    for (const each of files) {
      if (/\.(png|jpg|gif|ico|woff2?)$/.test(each)) continue
      for (const tok of readFileSync(each, 'utf8').match(/\{\{[A-Z_]+\}\}/g) ?? []) {
        found.add(tok)
        if (!declared.includes(tok)) {
          fail('undeclared-token', `${posixRel(target, each)} carries ${tok}, which scaffold.substitute does not declare`,
            `add ${tok} to scaffold.substitute, or remove it`)
        } else if (isTemplate && vendored.has(key)) {
          fail('vendored-token', `${posixRel(target, each)} carries ${tok}, and it is one of the template's own files`,
            'keep tokens out of vendored files: the seed fills them in, and the copy would stop being the template\'s')
        }
      }
    }
  }
  // A DECLARED TOKEN NOTHING USES is dead weight IN THE TEMPLATE, and it is the
  // ordinary state of a SCAFFOLDED REPO — every token there has been used and
  // replaced, which is the whole point. Warning about it in a tenant's
  // repository is four lines of noise about something they did not do and
  // cannot fix, on the first command they ever run.
  if (isTemplate) {
    for (const tok of declared) {
      if (!found.has(tok)) {
        warn('unused-token', `scaffold.substitute declares ${tok}, which nothing uses`, `remove it, or use it`)
      }
    }
  }

  // 8. Claude Code reads .claude/settings.json from a fixed place and runs each
  //    hook by the path written in it — the one path this manifest cannot own.
  //    A hook whose file is gone turns every matching tool call into an error
  //    instead of a check, and settings that do not parse are ignored whole.
  //    Both are refused here, where the second copy of the path gets checked.
  const settingsRel = pathOf(m, 'claudeSettings')
  if (settingsRel === undefined) {
    skip('claude-settings-not-kept', 'no Claude Code settings are kept here (paths.claudeSettings): the settings checks did not run')
  } else if (existsSync(join(target, settingsRel))) {
    let settings = null
    try {
      settings = JSON.parse(readFileSync(join(target, settingsRel), 'utf8'))
    } catch {
      fail('claude-settings-invalid', `${settingsRel} is not valid JSON`,
        'Claude Code ignores a settings file it cannot parse, hooks and all: fix the JSON')
    }
    for (const groups of Object.values(settings?.hooks ?? {})) {
      for (const group of Array.isArray(groups) ? groups : []) {
        for (const hook of group?.hooks ?? []) {
          const runs = /\$\{?CLAUDE_PROJECT_DIR\}?\/([^"'\s]+)/.exec(String(hook?.command ?? ''))
          if (runs && !existsSync(join(target, runs[1]))) {
            fail('claude-hook-missing', `${settingsRel} runs ${runs[1]}, which does not exist`,
              `restore ${runs[1]}, or take the hook out of ${settingsRel}`)
          }
        }
      }
    }
  }

  // 9. The template's files are the template's. A copy edited here is a fork
  //    nobody can see — the next sync either refuses it or overwrites it — so
  //    an edit fails here, naming the file, while it is still one diff. Only a
  //    repository that records its stamp is checked: one that was never
  //    stamped has nothing to check against, and is told so.
  const version = typeof m.template?.version === 'string' ? m.template.version : undefined
  const stamp = m.template?.files
  const of = version ? ` (template ${version})` : ''
  if (stamp === undefined) {
    if (!isTemplate) {
      skip('no-template-stamp', 'no template version is recorded here (template.files): the vendored files were not checked; infrared-harness sync records one')
    }
  } else if (!isObject(stamp)) {
    fail('template-stamp-invalid', 'template.files is not an object of path -> sha256',
      'restore it with infrared-harness sync --adopt (node <harness-template checkout>/bin/infrared-harness.mjs sync --adopt)')
  } else {
    for (const [rel, want] of Object.entries(stamp).sort(([a], [b]) => (a < b ? -1 : 1))) {
      const abs = join(target, rel)
      if (!isFile(abs)) {
        fail('vendored-missing', `${rel} is the template's${of}, and it is missing`,
          'move the change into harness-template, or restore it with infrared-harness sync (node <harness-template checkout>/bin/infrared-harness.mjs sync)')
      } else if (typeof want !== 'string' || !/^sha256-[0-9a-f]{64}$/.test(want)) {
        fail('template-stamp-invalid', `template.files says ${JSON.stringify(want)} for ${rel}, which is not sha256-<hex>`,
          'restore it with infrared-harness sync --adopt (node <harness-template checkout>/bin/infrared-harness.mjs sync --adopt)')
      } else if (digest(readFileSync(abs)) !== want) {
        fail('vendored-modified', `${rel} is the template's${of}, and it was edited here`,
          'move the change into harness-template, or restore it with infrared-harness sync --force (node <harness-template checkout>/bin/infrared-harness.mjs sync --force)')
      }
    }
  }

  // 10. How work reaches main: through a pull request, or straight onto it.
  //     The guard reads this, so a value it does not know is refused here
  //     rather than read as whichever mode a typo resembles.
  if (m.delivery !== undefined && !(isObject(m.delivery) && DELIVERY_MODES.includes(m.delivery.mode))) {
    fail('delivery-mode-invalid', `delivery.mode is ${JSON.stringify(isObject(m.delivery) ? m.delivery.mode : m.delivery)}`,
      `use one of: ${DELIVERY_MODES.join(', ')} — pull-request lands work through a pull request, trunk commits to main`)
  }

  // 11. In the template, every key it calls its own is one it declares: a key
  //     `paths` leaves out is one sync would install nothing for, silently.
  const vendor = m.template?.vendor
  if (vendor !== undefined && (!Array.isArray(vendor) || vendor.some((key) => typeof key !== 'string'))) {
    fail('template-vendor-invalid', 'template.vendor is not a list of path keys', 'list the keys whose files the template owns')
  } else if (isTemplate) {
    for (const key of vendor ?? []) {
      if (pathOf(m, key) === undefined) {
        fail('vendor-key-undeclared', `template.vendor names ${key}, which paths does not declare`,
          `declare paths.${key}, or take ${key} out of template.vendor`)
      }
    }
  }

  report(version)
}

/** Every file under `dir`, sorted, so the same tree always comes out the same. */
function walk(dir, files = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name)
    if (isDir(p)) walk(p, files)
    else files.push(p)
  }
  return files
}

function report(version) {
  const fails = findings.filter((f) => f.level === 'fail')
  const warns = findings.filter((f) => f.level === 'warn')

  if (has('json')) {
    out(JSON.stringify({ ok: fails.length === 0, findings, skipped, ...(version ? { template: version } : {}) }, null, 2))
  } else {
    for (const s of skipped) out(`  [SKIP] ${s.msg}`)
    for (const f of findings) {
      const tag = f.level === 'fail' ? 'FAIL' : 'WARN'
      out(`  [${tag}] ${f.msg}\n         ${f.fix}`)
    }
    out(findings.length === 0
      ? `  harness ok${version ? ` (template ${version})` : ''}`
      : `\n  ${fails.length} failing, ${warns.length} warning`)
  }
  process.exitCode = fails.length === 0 ? 0 : 1
}

/* ── dispatch ───────────────────────────────────────────────────────────── */

try {
  target = resolve(flag('target', '.'))
  switch (cmd) {
    case 'init': cmdInit(); break
    case 'sync': cmdSync(); break
    case 'path': cmdPath(); break
    case 'vcr': cmdVcr(); break
    case 'validate': cmdValidate(); break
    case 'tailored': cmdTailored(); break
    default:
      out('infrared-harness <init|sync|path|validate|tailored|vcr> [--target DIR] [--json]')
      process.exitCode = cmd ? 2 : 0
  }
} catch (error) {
  if (error instanceof Abort) {
    // Said already, with its exit status set.
  } else if ((cmd === 'init' || cmd === 'sync') && isSystemError(error)) {
    // Every write of theirs goes through land(), which answers for its own
    // failures, so an I/O error that reaches here came before any write:
    // reading the template or the repository. One line and exit 2: an uncaught
    // throw would exit 1, which from these two means "refused".
    process.stderr.write(`infrared-harness: could not ${error.syscall}${error.path ? ` ${shown(String(error.path))}` : ''} ` +
      `(${because(error)}): nothing was written\n`)
    process.exitCode = 2
  } else {
    throw error
  }
}
