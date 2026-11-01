#!/usr/bin/env node
/**
 * PreToolUse guard for the Bash tool: the mechanical half of the "Do not"
 * table in AGENTS.md.
 *
 * The deny rules in settings.json match the text of each command after Claude
 * Code splits it at `&&`, `;` and `|`. They miss a flag written later
 * (`git push origin main --force`), a program run another way (`git -C dir`,
 * `bash -c '...'`, `sudo`, `find -exec`), a command inside a shell keyword
 * (`if …; then …; fi`, `for … do … done`, `{ …; }`, `! …`), and anything that
 * depends on where the command runs, such as which branch a commit lands on.
 * This hook reads the whole command with a small shell parser and refuses
 * those shapes, with the reason and what to do instead, because a block
 * without a reason gets routed around in good faith.
 *
 * Which branch work may land on is the repository's to say, in its harness
 * manifest: `delivery.mode` is `pull-request` (the default), where work
 * reaches main through a pull request and a commit or push to main is
 * refused, or `trunk`, where work lands on main and both are allowed. Trunk
 * still refuses every force push (--force-with-lease too), --mirror, --all,
 * deleting main and --no-verify, and every rule that does not depend on the
 * branch. Those refusals are decided before the mode is read, so nothing
 * about a manifest can hold them up.
 *
 * The mode is the one the repository has committed: the manifest in the
 * commit its remote's default branch points at (origin/HEAD), found by the
 * rule the CLI uses, never the working tree, so an edit nobody has pushed
 * cannot switch a repository to trunk; nor can a remote-tracking ref
 * rewritten by hand, or a replace ref, both of which are refused. See
 * committedDelivery() and refRewritten(). A repository with nothing there
 * that could be a manifest, nested inside the session's project directory
 * (its working tree and its git directories, all of them), takes the mode
 * the project has committed instead, read the same way, and a refusal says
 * so: a workspace's component clones deliver as the workspace does. See
 * deliveryIn(). And it is the mode of the repository a command acts on,
 * found as git finds it, where a `..` after a link goes up from where the
 * link leads (dirsAfter()), in each directory the shell may be in by then: a
 * cd that can fail leaves it where it was (moves()). Or it is pull-request: a
 * command that names its repository another way (--git-dir, --work-tree,
 * GIT_DIR) is held to pull requests, and refused outright where git cannot
 * read that repository. In
 * trunk, so is a push or commit whose effect git config given on the command
 * line, or an option the guard cannot read, could change, and a push to
 * anywhere but origin. See landing().
 *
 * No git call here reaches the network or follows a replace ref: each runs
 * with lazy fetching off, every transport refused and replace refs ignored,
 * so a partial clone missing an object reads as missing, never as something
 * to fetch, and every object reads as itself. See git().
 *
 * Contract (https://code.claude.com/docs/en/hooks):
 *   stdin   the tool call, as JSON: { cwd, tool_input: { command } }, read to
 *           EOF however long it is
 *   exit 2  a deliberate block; stderr is shown to the model. A command too
 *           big or too tangled to check inside the limits in walk() is one:
 *           it is refused, never let through unread.
 *   exit 0  everything else, INCLUDING a bug in this file. A broken guard
 *           must never stop work, so an error allows the command, and no
 *           command should be able to cause one. The delivery mode is the
 *           exception: a manifest that cannot be found, or read within its
 *           limits (1 MiB, and two seconds), or that names no mode this file
 *           knows, means pull-request, the stricter, unless the repository
 *           has none at all and takes its project's (deliveryIn()).
 *
 * Zero dependencies, Node 22 or newer. Every host global is imported rather
 * than assumed, so the file lints clean in any repository it is copied into.
 */

import process from 'node:process'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/* ── the lexer ──────────────────────────────────────────────────────────────
 *
 * Not a full shell: enough of one to find every simple command in a command
 * line, with quotes removed and redirections set aside. A word remembers
 * whether it came from an expansion (`$VAR`, `$(...)`, `d`): such a word
 * cannot be known here, and a rule that needs it declines to guess rather
 * than block. It also remembers whether an expansion in it is unquoted
 * (`u`), or is "$@": the shell splits that into as many words as its value
 * holds, so it can put options of its own on the command line.
 *
 * Items produced: { kind: 'cmd', words, heredoc }, { kind: 'op', op } and
 * { kind: 'open' } / { kind: 'close' } for subshell parentheses.
 */

const SPACE = new Set([' ', '\t', '\r'])
const BREAK = new Set([' ', '\t', '\r', '\n', ';', '&', '|', '(', ')', '<', '>'])

/**
 * The index just past the end of a `$(` opened before `start` ('paren'), or of
 * a double-quoted string ('double'). The two nest inside each other; the
 * nesting is kept on an array, not the call stack, so no input is deep enough
 * to overflow it.
 */
function closeFrom(s, start, first) {
  const open = [{ paren: first === 'paren' ? 1 : 0 }]
  let i = start
  while (i < s.length) {
    const c = s[i]
    const top = open[open.length - 1]
    if (c === '\\') { i += 2; continue }
    if (top.paren === 0) {
      // Inside "…": it ends at `"`, and `$(` opens a substitution.
      if (c === '"') { open.pop(); i += 1; if (open.length === 0) return i; continue }
      if (c === '$' && s[i + 1] === '(') { open.push({ paren: 1 }); i += 2; continue }
      i += 1
      continue
    }
    // Inside $(…): quotes are skipped, and parentheses count.
    if (c === "'") { const j = s.indexOf("'", i + 1); i = j < 0 ? s.length : j + 1; continue }
    if (c === '"') { open.push({ paren: 0 }); i += 1; continue }
    if (c === '(') top.paren += 1
    if (c === ')') {
      top.paren -= 1
      if (top.paren === 0) { open.pop(); if (open.length === 0) return i + 1 }
    }
    i += 1
  }
  return s.length
}

/** The index just past the `)` that closes a `$(` opened before `start`. */
const closeParen = (s, start) => closeFrom(s, start, 'paren')

/** The index just past the `"` that closes a double-quoted string. */
const closeDouble = (s, start) => closeFrom(s, start, 'double')

/** Command substitutions inside a stretch of text that the shell expands. */
function substitutions(text) {
  const found = []
  let i = 0
  while (i < text.length) {
    if (text[i] === '\\') { i += 2; continue }
    if (text[i] === '$' && text[i + 1] === '(' && text[i + 2] !== '(') {
      const end = closeParen(text, i + 2)
      found.push(text.slice(i + 2, end - 1))
      i = end
      continue
    }
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1)
      found.push(text.slice(i + 1, end < 0 ? text.length : end))
      i = end < 0 ? text.length : end + 1
      continue
    }
    i += 1
  }
  return found
}

export function lex(s) {
  const items = []
  let cur = { kind: 'cmd', words: [], heredoc: null }
  let pendingHeredocs = []
  let i = 0

  const finish = () => {
    if (cur.words.length > 0 || cur.heredoc !== null) items.push(cur)
    cur = { kind: 'cmd', words: [], heredoc: null }
  }
  const op = (value) => { finish(); items.push({ kind: 'op', op: value }) }

  const readWord = () => {
    const word = { t: '', d: false, q: false, u: false, subs: [] }
    while (i < s.length && !BREAK.has(s[i])) {
      const c = s[i]
      if (c === '\\') {
        if (s[i + 1] !== '\n') word.t += s[i + 1] ?? ''
        word.q = true
        i += 2
      } else if (c === "'") {
        word.q = true
        const j = s.indexOf("'", i + 1)
        word.t += s.slice(i + 1, j < 0 ? s.length : j)
        i = j < 0 ? s.length : j + 1
      } else if (c === '$' && s[i + 1] === "'") {
        let j = i + 2
        while (j < s.length && s[j] !== "'") {
          if (s[j] === '\\' && j + 1 < s.length) {
            const e = s[j + 1]
            word.t += e === 'n' ? '\n' : e === 't' ? '\t' : e
            j += 2
          } else {
            word.t += s[j]
            j += 1
          }
        }
        i = j + 1
      } else if (c === '"') {
        word.q = true
        const end = closeDouble(s, i + 1)
        const inner = s.slice(i + 1, end - 1)
        const subs = substitutions(inner)
        if (subs.length > 0 || /\$[A-Za-z_{0-9@*#?!$-]/.test(inner)) word.d = true
        // "$@" and "${list[@]}" are as many words as they hold, quotes or not.
        if (/\$\{?@|\[@\]\}/.test(inner)) word.u = true
        for (const sub of subs) word.subs.push(sub)
        word.t += inner.replace(/\\(["\\$`])/g, '$1')
        i = end
      } else if (c === '$' && s[i + 1] === '(') {
        const end = closeParen(s, i + 2)
        if (s[i + 2] !== '(') word.subs.push(s.slice(i + 2, end - 1))
        word.t += s.slice(i, end)
        word.d = true
        word.u = true
        i = end
      } else if (c === '`') {
        const end = s.indexOf('`', i + 1)
        word.subs.push(s.slice(i + 1, end < 0 ? s.length : end))
        word.t += '`'
        word.d = true
        word.u = true
        i = end < 0 ? s.length : end + 1
      } else if (c === '$' && s[i + 1] === '{') {
        const end = s.indexOf('}', i + 2)
        word.t += s.slice(i, end < 0 ? s.length : end + 1)
        word.d = true
        word.u = true
        i = end < 0 ? s.length : end + 1
      } else if (c === '$' && /[A-Za-z_0-9@*#?!$-]/.test(s[i + 1] ?? '')) {
        const m = /^[A-Za-z_][A-Za-z_0-9]*|^./.exec(s.slice(i + 1))
        word.t += `$${m[0]}`
        word.d = true
        word.u = true
        i += 1 + m[0].length
      } else {
        word.t += c
        i += 1
      }
    }
    return word
  }

  const readHeredocs = () => {
    for (const h of pendingHeredocs) {
      let body = ''
      while (i < s.length) {
        const nl = s.indexOf('\n', i)
        const line = s.slice(i, nl < 0 ? s.length : nl)
        i = nl < 0 ? s.length : nl + 1
        if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break
        body += `${line}\n`
      }
      h.cmd.heredoc = (h.cmd.heredoc ?? '') + body
      if (!h.quoted) h.cmd.words.push({ t: '', d: true, subs: substitutions(body), hidden: true })
    }
    pendingHeredocs = []
  }

  while (i < s.length) {
    const c = s[i]
    if (SPACE.has(c)) { i += 1; continue }
    if (c === '\\' && s[i + 1] === '\n') { i += 2; continue }
    if (c === '#' && (i === 0 || BREAK.has(s[i - 1]))) {
      const nl = s.indexOf('\n', i)
      i = nl < 0 ? s.length : nl
      continue
    }
    if (c === '\n') { op('\n'); i += 1; readHeredocs(); continue }
    if (c === ';') { op(';'); i += s[i + 1] === ';' ? 2 : 1; continue }
    if (c === '|') { op(s[i + 1] === '|' ? '||' : '|'); i += s[i + 1] === '|' || s[i + 1] === '&' ? 2 : 1; continue }
    if (c === '&' && s[i + 1] === '&') { op('&&'); i += 2; continue }
    if (c === '&' && s[i + 1] !== '>') { op('&'); i += 1; continue }
    if (c === '(') { finish(); items.push({ kind: 'open' }); i += 1; continue }
    if (c === ')') { finish(); items.push({ kind: 'close' }); i += 1; continue }

    // Process substitution, `<(cmd)` or `>(cmd)`: a word whose command runs.
    if ((c === '<' || c === '>') && s[i + 1] === '(') {
      const end = closeParen(s, i + 2)
      cur.words.push({ t: s.slice(i, end), d: true, subs: [s.slice(i + 2, end - 1)] })
      i = end
      continue
    }

    // A redirection: `>`, `>>`, `2>&1`, `&>`, `<<EOF`, `<<<`. Its target is
    // not an argument, so it is read and set aside.
    const redir = /^(\d*)(<<<|<<-|<<|&>>|&>|>>|>&|<&|>\||<>|>|<)/.exec(s.slice(i))
    if (redir) {
      const kind = redir[2]
      i += redir[0].length
      while (SPACE.has(s[i])) i += 1
      const target = readWord()
      if (kind === '<<' || kind === '<<-') {
        pendingHeredocs.push({ delim: target.t, strip: kind === '<<-', quoted: target.q, cmd: cur })
      } else if (kind === '<<<') {
        cur.heredoc = (cur.heredoc ?? '') + `${target.t}\n`
        if (target.subs.length > 0) cur.words.push({ t: '', d: true, subs: target.subs, hidden: true })
      } else if (target.subs.length > 0) {
        cur.words.push({ t: '', d: true, subs: target.subs, hidden: true })
      }
      continue
    }

    const at = i
    const word = readWord()
    if (i === at) { i += 1; continue }
    cur.words.push(word)
  }
  finish()
  return items
}

/* ── wrappers ───────────────────────────────────────────────────────────────
 *
 * A program that runs another program: `sudo rm -rf x` is `rm -rf x`. Each
 * entry names the short options that take a separate value, so the wrapped
 * command is found rather than mistaken for an option's argument, and
 * whether it takes NAME=value words before the command (`assigns`): those set
 * the command's environment, which a rule may need to read (GIT_DIR=…).
 */
const WRAPPERS = {
  sudo: { values: 'CDghpRrTtUu', long: ['--user', '--group', '--chdir', '--prompt'], assigns: true },
  doas: { values: 'Cu' },
  env: { values: 'uCS', long: ['--unset', '--chdir', '--split-string'], assigns: true },
  nice: { values: 'n', long: ['--adjustment'] },
  ionice: { values: 'cnp' },
  timeout: { values: 'sk', long: ['--signal', '--kill-after'], positional: 1 },
  stdbuf: { values: 'ioe' },
  xargs: { values: 'EeIiLlnPsda', long: ['--max-args', '--max-procs', '--delimiter', '--arg-file', '--max-lines'] },
  nohup: {},
  time: { values: 'of', long: ['--output', '--format'] },
  command: {},
  builtin: {},
  exec: { values: 'a' },
  noglob: {},
  nocorrect: {},
  setsid: {},
  caffeinate: { values: 'tw' },
  unbuffer: {},
  chronic: {},
  busybox: {},
  flock: { values: 'wEc', positional: 1 },
  '-': {},
  arch: { args: ['-arch', '-e', '-d'] },
  chrt: { values: 'TPD', positional: 1 },
  taskset: { positional: 1 },
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'])
const ASSIGN = /^[A-Za-z_][A-Za-z_0-9]*=/

/**
 * Peel wrappers off a simple command.
 *
 * Returns the words of the command that actually runs, the wrappers it went
 * through (`via`), command STRINGS that some program will hand to a shell
 * (`bash -c`, `eval`, `watch`, `ssh host cmd`), commands `find -exec` runs,
 * a directory change a wrapper makes (`env -C dir`), and the NAME=value
 * words a wrapper sets the command's environment with (`env`).
 */
export function unwrap(input) {
  let words = input
  const via = []
  const nested = []
  const exec = []
  const env = []
  let chdir = null
  let remote = false
  const out = (rest, extra) => ({ words: rest, via, nested, exec, chdir, remote, env, ...extra })

  for (let guard = 0; words.length > 0; guard += 1) {
    // Past this many, the command is not being read; walk refuses it.
    if (guard === MAX_WRAPPERS) return out([], { overflow: true })
    const name = basename(words[0].t)
    const spec = Object.hasOwn(WRAPPERS, name) ? WRAPPERS[name] : undefined

    if (name === 'command' && /^-[vV]/.test(words[1]?.t ?? '')) return out([])

    if (spec) {
      let i = 1
      let positional = spec.positional ?? 0
      while (i < words.length) {
        const a = words[i].t
        if (a === '--') { i += 1; break }
        if (spec.assigns && ASSIGN.test(a)) { env.push(words[i]); i += 1; continue }
        if ((spec.args ?? []).includes(a)) { i += 2; continue }
        if (a.startsWith('--')) {
          if (!a.includes('=') && (spec.long ?? []).includes(a)) {
            if ((name === 'env' && a === '--split-string')) nested.push(words[i + 1]?.t ?? '')
            if ((name === 'env' || name === 'sudo') && a === '--chdir') chdir = words[i + 1]?.t ?? null
            i += 2
          } else {
            if (name === 'env' && a.startsWith('--chdir=')) chdir = a.slice(8)
            i += 1
          }
          continue
        }
        if (a.startsWith('-') && a.length > 1) {
          const flags = a.slice(1)
          const at = [...flags].findIndex((f) => (spec.values ?? '').includes(f))
          if (at >= 0) {
            const letter = flags[at]
            const value = at < flags.length - 1 ? flags.slice(at + 1) : words[i + 1]?.t ?? ''
            if (name === 'env' && letter === 'S') nested.push(value)
            if (name === 'env' && letter === 'C') chdir = value
            if (name === 'flock' && letter === 'c') { nested.push(value); return out([]) }
            i += at < flags.length - 1 ? 1 : 2
          } else {
            i += 1
          }
          continue
        }
        if (positional > 0) { positional -= 1; i += 1; continue }
        break
      }
      // `env -- NAME=value cmd`: the assignments still come before the command.
      while (spec.assigns && i < words.length && ASSIGN.test(words[i].t)) { env.push(words[i]); i += 1 }
      via.push(name)
      words = words.slice(i)
      continue
    }

    if (SHELLS.has(name)) {
      // `bash -c 'string'`, `sh -ec 'string'`, `zsh -lc 'string'`.
      const at = words.findIndex((w, k) => k > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(w.t))
      if (at > 0) {
        const script = words.slice(at + 1).find((w) => !w.t.startsWith('-'))
        if (script) nested.push(script.t)
        return out([], { via: [...via, name] })
      }
      break
    }

    if (name === 'eval' || name === 'watch') {
      let i = 1
      while (i < words.length && words[i].t.startsWith('-')) i += name === 'watch' && /^-[nd]$/.test(words[i].t) ? 2 : 1
      nested.push(words.slice(i).map((w) => w.t).join(' '))
      return out([], { via: [...via, name] })
    }

    if (name === 'su') {
      const at = words.findIndex((w) => w.t === '-c' || w.t === '--command')
      if (at > 0 && words[at + 1]) nested.push(words[at + 1].t)
      return out([], { via: [...via, name] })
    }

    if (name === 'ssh') {
      // Everything after the host is a command line the REMOTE shell parses,
      // in a directory nobody here can know.
      let i = 1
      while (i < words.length && words[i].t.startsWith('-')) {
        i += /^-[bcDEeFIiJLlmOopQRSWw]$/.test(words[i].t) ? 2 : 1
      }
      if (words.length > i + 1) {
        nested.push(words.slice(i + 1).map((w) => w.t).join(' '))
        remote = true
      }
      return out([], { via: [...via, name] })
    }

    if (name === 'find') {
      for (let i = 1; i < words.length; i += 1) {
        if (!/^-(exec|execdir|ok|okdir)$/.test(words[i].t)) continue
        const end = words.findIndex((w, k) => k > i && (w.t === ';' || w.t === '+'))
        exec.push(words.slice(i + 1, end < 0 ? words.length : end))
        i = end < 0 ? words.length : end
      }
      break
    }

    break
  }

  return out(words)
}

/* ── shell grammar around a simple command ──────────────────────────────────
 *
 * The lexer splits at `;`, `&&`, `|` and newlines, so `if x; then git push
 * origin main; fi` arrives as three simple commands, the second starting with
 * `then`. A reserved word is only reserved where a command starts, and only
 * unquoted, so it is peeled off there and what follows is the command that
 * runs. `compound` reads one lexed command into events, in order:
 *
 *   { open: 'cond' | 'brace' | 'fn' }  if, while, until, for, select, case,
 *                                      repeat; a `{`; a function body's `{`
 *   { close: true }                    fi, done, esac, `}`
 *   { bind: NAME, words }              the variable a for or select header sets
 *   { run: words, negated, async }     a simple command that runs
 *
 * `for NAME in WORDS` and `case WORD in` are headers: none of their words is a
 * command (their substitutions are, and are walked anyway). `time [-p]`,
 * `repeat N`, `coproc`, `!` and `function NAME` are prefixes. zsh also takes
 * a body in braces on the same line (`if [[ -n x ]] { cmd }`, `{ a } always
 * { b }`), so once a keyword or brace has been read, a lone `{` or `}` ends a
 * command. It is one pass over the words, however deep the nesting.
 */

const OPENS = new Set(['if', 'while', 'until', 'case', 'for', 'select', 'foreach'])
const HEADERS = new Set(['case', 'for', 'select', 'foreach'])
const CLOSES = new Set(['fi', 'done', 'esac', '}'])
const INSIDE = new Set(['then', 'else', 'elif', 'do', 'always'])
const NAME = /^[A-Za-z_][A-Za-z_0-9]*$/
const reserved = (w, t) => w !== undefined && !w.q && !w.d && (t === undefined || w.t === t)

export function compound(words, fnBody = false) {
  const events = []
  let fn = fnBody
  let active = false
  let negated = false
  let async = false
  let i = 0
  while (i < words.length) {
    const t = reserved(words[i]) ? words[i].t : null
    if (t === '{') {
      events.push({ open: fn ? 'fn' : 'brace' })
      fn = false
      active = true
      i += 1
    } else if (CLOSES.has(t)) {
      events.push({ close: true })
      active = true
      i += 1
    } else if (INSIDE.has(t) || t === '!') {
      if (t === '!') negated = true
      active = true
      i += 1
    } else if (t === 'time' && !/^-(?!p$|-$)/.test(words[i + 1]?.t ?? '')) {
      // The shell's `time`. /usr/bin/time with options of its own is unwrap's.
      i += reserved(words[i + 1], '-p') ? 2 : 1
      if (reserved(words[i], '--')) i += 1
      active = true
    } else if (t === 'coproc') {
      async = true
      i += reserved(words[i + 2], '{') ? 2 : 1
      active = true
    } else if (t === 'function') {
      fn = true
      i += reserved(words[i + 1], '{') ? 1 : 2
      active = true
    } else if (t === 'repeat') {
      events.push({ open: 'cond' })
      i += 2
      active = true
    } else if (OPENS.has(t)) {
      events.push({ open: 'cond' })
      active = true
      if (!HEADERS.has(t)) { i += 1; continue }
      let end = i + 1
      while (end < words.length && !reserved(words[end], '{')) end += 1
      if (t !== 'case' && reserved(words[i + 1]) && NAME.test(words[i + 1].t)) {
        events.push({ bind: words[i + 1].t, words: reserved(words[i + 2], 'in') ? words.slice(i + 3, end) : [] })
      }
      i = end
    } else {
      let end = words.length
      if (active) {
        end = i + 1
        while (end < words.length && !reserved(words[end], '{') && !reserved(words[end], '}')) end += 1
      }
      events.push({ run: words.slice(i, end), negated, async })
      negated = false
      async = false
      i = end
    }
  }
  return events
}

/* ── where a variable came from ─────────────────────────────────────────────
 *
 * Nothing here knows a variable's value, but it can know where the value came
 * from. `for p in $(pgrep x)` and `p=$(pgrep x)` bind `p` to the substitutions
 * that produced it, and a word that expands `$p` then carries them in `subs`,
 * so a rule reads `kill $p` the way it reads `kill $(pgrep x)`. Binding the
 * name again, to anything, replaces what it carried. A prefix assignment
 * (`p=… cmd`) binds nothing: the shell expands that line before it applies.
 * Each source is kept once, so a chain of assignments that each double the
 * last (`x1=$x0$y0; y1=$x1; …`) stays the size it started, and both the
 * sources and the variables are capped.
 */

const DECLARES = new Set(['export', 'local', 'declare', 'typeset', 'readonly'])
const REF = /\$\{?([A-Za-z_][A-Za-z_0-9]*)/g
const assigned = (word) => word.t.slice(0, word.t.indexOf('='))

function sourced(word, vars) {
  if (!word.d || vars.size === 0) return word
  let from = null
  for (const m of word.t.matchAll(REF)) {
    const subs = vars.get(m[1])
    if (subs === undefined) continue
    from ??= new Set(word.subs)
    for (const s of subs) from.add(s)
  }
  return from === null ? word : { ...word, subs: [...from] }
}

function bind(world, name, words) {
  const sources = new Set()
  for (const word of words) {
    for (const s of sourced(word, world.vars).subs) {
      sources.add(s)
      if (sources.size > MAX_SOURCES) throw new TooComplex()
    }
  }
  if (sources.size === 0 && !world.vars.has(name)) return world
  const vars = new Map(world.vars)
  if (sources.size > 0) vars.set(name, [...sources])
  else vars.delete(name)
  if (vars.size > MAX_VARS) throw new TooComplex()
  return { ...world, vars }
}

/* ── the environment git runs with ──────────────────────────────────────────
 *
 * Some variables change what a git command does without appearing in it:
 * GIT_DIR, GIT_WORK_TREE and GIT_COMMON_DIR choose the repository, GIT_CONFIG_*
 * add configuration, and HOME and XDG_CONFIG_HOME choose the files git reads
 * its own configuration from. A world keeps each of those the line sets:
 * before a command (`GIT_DIR=x git …`, `env GIT_DIR=x git …`, `sudo GIT_DIR=x
 * git …`) for that command and what it runs, and alone or under `export` for
 * what follows. One set alone counts as exported (HOME always is): whether it
 * already was cannot be seen from here, and counting it costs no more than a
 * refusal the plain command does not get. Nothing unsets one.
 */

const ENV_VAR = /^(GIT_[A-Za-z_0-9]*|HOME|XDG_CONFIG_HOME)=/
const NO_ENV = new Map()

/** `world`, with the variables among ENV_VAR that the assignments among `words` set, as { value, d }. */
function withEnv(world, words) {
  let env = null
  for (const word of words) {
    if (!ENV_VAR.test(word.t)) continue
    env ??= new Map(world.env)
    env.set(assigned(word), { value: word.t.slice(word.t.indexOf('=') + 1), d: word.d })
    if (env.size > MAX_VARS) throw new TooComplex()
  }
  return env === null ? world : { ...world, env }
}

/* ── walking a command line ─────────────────────────────────────────────────
 *
 * A world is how things may stand when a command runs: `cwd` (null once it
 * cannot be known, after `cd "$DIR"` for instance), `vbranch`, the branch a
 * directory will be on by then because an earlier command switched or
 * created it (`git switch -c feat/x && git commit ...` commits on feat/x),
 * `vars`, where each variable's value came from, and `env`, the GIT_*
 * variables the line has set.
 *
 * What a command changes counts as done for the commands after it when it
 * surely ran: at the top level, or in a `{ …; }` group. Inside an if, a loop,
 * a case, a function body or a subshell, negated, or beside `||`, `|` or
 * `&`, it may not have, so what follows is checked in every world it leaves:
 * `if false; then git switch -c x; fi; git commit` is checked on main and on
 * x, and refused. A member of an `&&` chain runs only once the ones before it
 * succeeded, so inside the chain their changes are done.
 *
 * A cd can fail, and then the shell stays where it was: `cd /missing; git
 * commit` commits where the session already was. So where one may (moves()),
 * what follows the end of its `&&` chain is checked where the shell stayed as
 * well as where the cd would have taken it, and refused if either refuses it.
 * The rest of its own chain runs only if it moved, so is checked only there.
 *
 * The walk is a loop over a queue of command strings, never a recursion, and
 * crossing any limit below refuses the command. Nothing is let through
 * because it was too big or too tangled to read.
 */

const MAX_INPUT = 1 << 20      // characters in one command
const MAX_DEPTH = 8            // command strings inside command strings: $(…), bash -c, eval
const MAX_COMMANDS = 100_000   // simple commands checked in one call
const MAX_NESTING = 256        // if, loop, case and brace open at once
const MAX_WORLDS = 16          // ways things may stand at once
const MAX_SOURCES = 64         // substitutions one variable carries
const MAX_VARS = 256           // variables carrying substitutions at once
const MAX_WRAPPERS = 16        // sudo, env, nice … in front of one command
const DEADLINE_MS = 5000       // well inside the hook's 10 s timeout

class TooComplex extends Error {}
let budget = null

const home = () => process.env.HOME || homedir()

/** `target` with a leading ~ or $HOME filled in; null where it cannot be known: another expansion, or `cd -`. */
function expandHome(target) {
  if (target === null || target === undefined) return null
  let t = target
  if (t === '~' || t.startsWith('~/')) t = home() + t.slice(1)
  if (t === '$HOME' || t.startsWith('$HOME/')) t = home() + t.slice(5)
  if (t.includes('$') || t.includes('`') || t === '-') return null
  return t
}

/**
 * The directory after `cd target` from `cwd`, read off the path the way a
 * shell's cd reads it by default: a `..` takes the last name off. null when
 * it cannot be known. Where a link comes before a `..`, that need not be
 * where chdir() goes: see dirsAfter().
 */
export function dirAfter(cwd, target) {
  const t = expandHome(target)
  if (t === null) return null
  if (isAbsolute(t)) return resolve(t)
  return cwd ? resolve(cwd, t) : null
}

/**
 * The real path of `path` as realpath(3) finds it, or null where nothing is
 * there. Not realpathSync() without .native: that takes each `..` off the path
 * before it follows a single link.
 */
function realPath(path) {
  try {
    return realpathSync.native(path)
  } catch {
    // Nothing there, a loop of links, or a directory this process cannot search.
    return null
  }
}

/** Whether `path` is a directory now, as chdir() would find it: following each link before the `..` after it. */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    // Nothing there, a link to nowhere, a loop of links, or a directory this process cannot search.
    return false
  }
}

/**
 * Where a change to the directory `target` from `cwd` can land, as an array.
 *
 * dirAfter() reads a `..` off the path, so comp/link/.. is comp. chdir()
 * follows the link first and goes up from where it leads, as git -C, env -C
 * and cd -P do. A plain cd is the shell's own: it reads the path by default,
 * and follows the link under an option the guard cannot see (set -P, or zsh's
 * chase_links).
 *
 * So where `target` holds a `..` and the two answers name different
 * directories, `physical` (git -C, env -C, cd -P) gives chdir()'s, and a plain
 * cd gives both: what follows is checked in each, and refused if either
 * refuses it. Everywhere else it is dirAfter()'s answer alone, as it always
 * was: a path with no `..` reaches the same directory however it is read.
 *
 * Where chdir() finds nothing there now (a name missing before the `..`, a
 * link to nowhere, a loop of links), the change fails: git -C and env -C run
 * nothing, and a cd leaves the shell where it was (moves()). Unless a command
 * before it makes the path first, and then it lands where the path says if
 * what was made is plain directories, or wherever a link made there leads.
 * So it is both: the path's reading, the one 0.3.1 judged, and a directory
 * nobody can know (null), which is pull-request. Never null alone for a
 * target the guard can read.
 */
function dirsAfter(cwd, target, physical) {
  const logical = dirAfter(cwd, target)
  if (logical === null) return [null]
  const t = expandHome(target)
  if (!t.split('/').includes('..')) return [logical]
  const reached = realPath(isAbsolute(t) ? t : `${cwd}/${t}`)
  if (reached === null) return [logical, null]
  if (reached === realPath(logical)) return [logical]
  return physical ? [reached] : [logical, reached]
}

/* ── cd, pushd and popd ─────────────────────────────────────────────────────
 *
 * Their options, in bash or zsh. A word made only of these letters, before
 * the first operand, is options, and `--` ends them, so the word after it is
 * the target, whatever it looks like. bash's cd takes L, P, e and @, zsh's L,
 * P, q and s; bash's pushd and popd take only n, zsh's L, P, q and s.
 */
const DIR_OPTIONS = { cd: /^-[LPe@qs]+$/, pushd: /^-[LPnqs]+$/, popd: /^-[LPnqs]+$/ }

/**
 * Where a cd, pushd or popd leaves the shell, as { to, mayFail }.
 *
 * `to` is where it moves when it succeeds, as an array (dirsAfter()); null
 * where that cannot be known. What follows it with && runs only there. The
 * target is in `to` even when it is not there now: a command before it may
 * make it (`git clone … x; cd x`), and it is the directory 0.3.1 judged.
 *
 * `mayFail` says it can fail instead, which leaves the shell where it was, so
 * what follows it with `;`, a newline, `||` or `&` runs there too, and is
 * checked in both (walkLine()). It can fail when:
 *   - its target is one nobody can know ($DIR, `cd -`, any popd), or is not a
 *     directory chdir() can reach now (`cd /missing`, `cd -P nosuch/..`, a
 *     link to nowhere). Where chdir() can, a plain cd gets there too: bash
 *     and zsh both take chdir()'s reading where the path's is not there;
 *   - it is given an option only one of bash and zsh takes, which the other
 *     refuses: for cd any but -L and -P, and for pushd any at all;
 *   - it is given more than one operand. bash 5 refuses that, and bash 3.2
 *     goes to the first. zsh puts the second in place of the first in the
 *     current directory's name, and fails where the name does not hold it;
 *     where that leads is a directory nobody can know, so `to` holds one.
 * pushd -n and popd -n never move: bash leaves the directory as it is, and
 * zsh refuses -n. A pushd with no operand is read as staying where it is.
 */
function moves(cmd, state) {
  const args = cmd.words.slice(1)
  let k = 0
  let options = ''
  while (k < args.length && DIR_OPTIONS[cmd.name].test(args[k].t)) { options += args[k].t.slice(1); k += 1 }
  if (args[k]?.t === '--') k += 1
  const operands = args.slice(k)
  if (cmd.name !== 'cd' && options.includes('n')) return { to: [state.cwd], mayFail: false }
  if (cmd.name === 'popd') return { to: [null], mayFail: true }
  const oneShell = cmd.name === 'pushd' ? options !== '' : /[^LP]/.test(options)
  const target = operands[0]
  if (target === undefined) return { to: [cmd.name === 'cd' ? home() : state.cwd], mayFail: oneShell }
  if (target.d && !/^\$HOME(\/|$)/.test(target.t)) return { to: [null], mayFail: true }
  // -P resolves the way chdir() does. With -L beside it, bash takes the last and zsh -P, so that reads as both.
  const physical = options.includes('P') && !options.includes('L')
  const to = dirsAfter(state.cwd, target.t, physical)
  if (to.includes(null)) return { to, mayFail: true }
  // zsh reads a second operand as a substitution in the current directory's name, which the guard does not work out.
  if (operands.length > 1) return { to: [...to, null], mayFail: true }
  const t = expandHome(target.t)
  const there = isDirectory(isAbsolute(t) ? t : `${state.cwd}/${t}`)
  return { to, mayFail: oneShell || !there }
}

const fork = (world, remote = false) => ({
  cwd: remote ? null : world.cwd,
  vbranch: remote ? {} : { ...world.vbranch },
  vars: world.vars,
  // ssh does not carry this shell's environment to the remote one.
  env: remote ? NO_ENV : world.env,
})

const varsKeys = new WeakMap()
const envKeys = new WeakMap()
function worldKey(world) {
  let vars = varsKeys.get(world.vars)
  if (vars === undefined) {
    vars = [...world.vars].map(([name, subs]) => `${name}=${subs.join('\u0001')}`).sort().join('\u0002')
    varsKeys.set(world.vars, vars)
  }
  let env = envKeys.get(world.env)
  if (env === undefined) {
    env = [...world.env].map(([name, set]) => `${name}=${set.value}`).sort().join('\u0002')
    envKeys.set(world.env, env)
  }
  const branches = Object.keys(world.vbranch).sort().map((dir) => `${dir}=${world.vbranch[dir]}`).join('\u0002')
  return `${world.cwd}\u0000${branches}\u0000${vars}\u0000${env}`
}

/** The worlds in `a` and `b`, each once. */
function merge(a, b = []) {
  const all = b.length === 0 ? a : a.concat(b)
  if (all.length <= 1) return all
  const seen = new Map()
  for (const world of all) seen.set(worldKey(world), world)
  if (seen.size > MAX_WORLDS) throw new TooComplex()
  return [...seen.values()]
}

function tick() {
  budget.commands += 1
  if (budget.commands > MAX_COMMANDS || Date.now() > budget.until) throw new TooComplex()
}

/**
 * Visit every simple command in `src`, nested ones included. `visit(cmd,
 * state)` returns a block (anything truthy) or null to carry on; the first
 * block wins. A rule may call walk again: the inner walk spends the outer
 * one's budget.
 */
export function walk(src, start, visit) {
  const outer = budget === null
  if (outer) {
    budget = { commands: 0, until: Date.now() + DEADLINE_MS }
    answers.clear()
    modes.clear()
    applied.clear()
  }
  try {
    const world = {
      cwd: start?.cwd ?? null,
      vbranch: { ...start?.vbranch },
      vars: start?.vars instanceof Map ? start.vars : new Map(),
      env: start?.env instanceof Map ? start.env : NO_ENV,
    }
    const queue = [{ src, world, depth: 0 }]
    while (queue.length > 0) {
      const hit = walkLine(queue.pop(), visit, queue)
      if (hit) return hit
    }
    return null
  } catch (error) {
    if (error instanceof TooComplex) return TOO_COMPLEX
    throw error
  } finally {
    if (outer) budget = null
  }
}

/** Walk one command string; the strings inside it go onto `queue`. */
function walkLine({ src, world, depth }, visit, queue) {
  if (typeof src !== 'string' || src.trim() === '') return null
  if (depth > MAX_DEPTH) throw new TooComplex()
  tick()
  let worlds = [world]     // for a command that starts a chain
  let chain = worlds       // for the next member of an && chain
  let stayed = []          // where the shell is if a cd in this && chain failed: what follows the chain runs there too
  const subshells = []
  const constructs = []
  let conditional = 0      // how many of `constructs` are not plain braces
  let fnBody = false       // `name()` was just read: the next `{` is its body
  let prevOp = null
  let piped = null         // what the command before a `|` printed, when that is known
  const items = lex(src)
  for (let k = 0; k < items.length; k += 1) {
    const item = items[k]
    if (item.kind === 'op') { prevOp = item.op; continue }
    const runIn = prevOp === '&&' ? chain : worlds
    const nextOp = items[k + 1]?.kind === 'op' ? items[k + 1].op : null
    // An && chain that ends here hands what follows it every world a failed cd in it left.
    const chainEnds = () => {
      if (nextOp === '&&') return
      worlds = merge(worlds, stayed)
      stayed = []
    }

    if (item.kind === 'open') {
      if (items[k + 1]?.kind === 'close') { fnBody = true; k += 1; continue }
      subshells.push({ worlds, runIn, stayed })
      worlds = runIn.map((w) => fork(w))
      chain = worlds
      stayed = []
      prevOp = null
      continue
    }
    if (item.kind === 'close') {
      const outer = subshells.pop()
      if (outer === undefined) continue   // the `)` after a case pattern
      // A subshell's cwd and variables end with it; a branch it switched stays switched, if it ran.
      const changed = []
      for (const o of outer.runIn) for (const w of merge(worlds, chain)) changed.push({ ...o, vbranch: w.vbranch })
      worlds = merge(outer.worlds, changed)
      chain = merge(outer.runIn, changed)
      stayed = outer.stayed
      chainEnds()
      prevOp = null
      continue
    }

    // Substitutions run where the command does; they are walked after this string.
    for (const word of item.words) {
      for (const sub of word.subs) for (const w of runIn) queue.push({ src: sub, world: fork(w), depth: depth + 1 })
    }

    let certain = runIn
    let maybe = false
    let negated = false
    for (const ev of compound(item.words.filter((w) => !w.hidden), fnBody)) {
      if (ev.open) {
        constructs.push(ev.open)
        if (ev.open !== 'brace') conditional += 1
        if (constructs.length > MAX_NESTING) throw new TooComplex()
      } else if (ev.close) {
        const kind = constructs.pop()
        if (kind !== undefined && kind !== 'brace') conditional -= 1
      } else if (ev.bind) {
        certain = certain.map((w) => bind(w, ev.bind, ev.words))
      } else {
        maybe ||= conditional > 0 || ev.negated || ev.async
        negated ||= ev.negated
        const next = []
        const failed = []
        for (const w of certain) {
          const hit = run(ev.run, w, item, prevOp === '|' ? piped : null, visit, queue, depth, next, failed)
          if (hit) return hit
        }
        certain = merge(next)
        stayed = merge(stayed, failed)
      }
    }
    fnBody = false
    maybe ||= ['||', '|'].includes(prevOp) || ['||', '|', '&'].includes(nextOp)
    chain = negated || prevOp === '||' ? merge(runIn, certain) : certain
    worlds = maybe ? merge(worlds, certain) : certain
    chainEnds()
    piped = nextOp === '|' ? printed(item) : null
  }
  return null
}

/**
 * Check one simple command in one world, push the world it leaves onto
 * `next`, and onto `failed` the world a cd leaves if it fails (moves()).
 */
function run(words, world, item, piped, visit, queue, depth, next, failed) {
  tick()
  let i = 0
  while (i < words.length && ASSIGN.test(words[i].t)) i += 1
  if (i === words.length) {
    // `x=$(…)` alone sets x for what follows; `x=… cmd` only sets cmd's environment.
    let after = world
    for (const word of words) after = bind(after, assigned(word), [word])
    next.push(withEnv(after, words))
    return null
  }
  const inner = unwrap(words.slice(i).map((word) => sourced(word, world.vars)))
  if (inner.overflow) throw new TooComplex()
  const cmd = inner.words.length === 0 ? null : commandOf(inner.words, item, inner.via)
  // The command runs with the assignments before it, and those a wrapper makes (env, sudo).
  // A wrapper changes directory with chdir(), which follows a link before a `..`, and may reach more than one: each is checked.
  const wheres = inner.chdir === null ? [world] : dirsAfter(world.cwd, inner.chdir, true).map((cwd) => ({ ...world, cwd }))
  for (const moved of wheres) {
    const here = withEnv(moved, [...words.slice(0, i), ...inner.env])
    for (const src of inner.nested) queue.push({ src, world: fork(here, inner.remote), depth: depth + 1 })
    for (const found of inner.exec) {
      if (found.length === 0) continue
      const hit = visit(commandOf(found, item, [...inner.via, 'find']), here)
      if (hit) return hit
    }
    if (cmd === null) continue
    // A shell given no script reads one from stdin: a heredoc, or what `echo …|` printed.
    const script = SHELLS.has(cmd.name) && readsStdin(cmd.argv) ? (item.heredoc ?? piped) : null
    if (script) queue.push({ src: script, world: fork(here), depth: depth + 1 })
    const hit = visit(cmd, here)
    if (hit) return hit
    if (!Object.hasOwn(DIR_OPTIONS, cmd.name)) next.push(...effects(cmd, world, here))
  }
  if (cmd === null) { next.push(world); return null }
  if (Object.hasOwn(DIR_OPTIONS, cmd.name)) {
    // A cd can reach more than one directory, or fail and leave the shell where it was: see moves().
    const { to, mayFail } = moves(cmd, world)
    for (const cwd of to) next.push({ ...world, cwd })
    if (mayFail) failed.push(world)
  }
  return null
}

/** What a command prints, where that can be read off it: echo, printf, or cat of a heredoc. */
function printed(item) {
  const runs = compound(item.words.filter((w) => !w.hidden)).filter((ev) => ev.run)
  if (runs.length === 0) return null
  const words = runs[runs.length - 1].run
  let i = 0
  while (i < words.length && ASSIGN.test(words[i].t)) i += 1
  const argv = unwrap(words.slice(i)).words.map((w) => w.t)
  const name = argv.length > 0 ? basename(argv[0]) : null
  if (name === 'cat' && argv.length === 1) return item.heredoc
  if (name !== 'echo' && name !== 'printf') return null
  let k = 1
  while (name === 'echo' && k < argv.length && /^-[neE]+$/.test(argv[k])) k += 1
  return argv.slice(k).join(' ').replace(/\\n/g, '\n').replace(/\\t/g, '\t')
}

/** Whether a shell run with these arguments reads its script from stdin: no script file, or -s. */
function readsStdin(argv) {
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '-') return true
    if (a === '--') return i === argv.length - 1
    if (['-o', '+o', '-O', '+O', '--rcfile', '--init-file'].includes(a)) { i += 1; continue }
    if (/^-[A-Za-z]*s/.test(a)) return true
    if (/^[-+]/.test(a)) continue
    return false
  }
  return true
}

function commandOf(words, item, via) {
  return { name: basename(words[0].t), argv: words.map((w) => w.t), words, heredoc: item.heredoc, via }
}

/**
 * What a command other than cd, pushd and popd (moves()) changes for the ones
 * after it, as the worlds it may leave: a branch, a variable. `here` is how
 * things stand for the command itself, with what goes before it on its own
 * line (`GIT_DIR=x`, `env -C dir`): a branch is switched in the directory and
 * repository the command acts on, and in each, when git may act in more than
 * one.
 */
function effects(cmd, state, here = state) {
  if (DECLARES.has(cmd.name)) {
    let next = state
    for (const w of cmd.words.slice(1)) if (ASSIGN.test(w.t)) next = bind(next, assigned(w), [w])
    return [withEnv(next, cmd.words.slice(1))]
  }
  if (cmd.name !== 'git') return [state]

  const g = parseGit(cmd.argv.slice(1))
  // A switch in a repository named another way leaves this directory's checkout as it was.
  if (namedElsewhere(g, here).length > 0) return [state]
  // One world for each directory git may act in (gitDirsOf()). In one nobody can know, it switched nothing the guard can see.
  return gitDirsOf(here, g).map((dir) => {
    const next = dir === null ? undefined : branchAfter(g, dir, state)
    return next === undefined ? state : { ...state, vbranch: { ...state.vbranch, ...next } }
  })
}

/* ── git ────────────────────────────────────────────────────────────────── */

/**
 * `git [globals] <sub> <rest>`, with the globals that change where it acts or
 * what it does: -C, --git-dir and --work-tree, and the configuration -c and
 * --config-env give it. `configAt` holds the index in `args` of each -c
 * value, and `subAt` the subcommand's.
 */
export function parseGit(args) {
  const g = { dirs: [], gitDir: null, workTree: null, configs: [], configEnv: [], configAt: [], sub: null, subAt: -1, rest: [] }
  let i = 0
  while (i < args.length) {
    const a = args[i]
    if (a === '-C') { g.dirs.push(args[i + 1] ?? null); i += 2; continue }
    if (a === '-c') { g.configs.push(args[i + 1] ?? ''); g.configAt.push(i + 1); i += 2; continue }
    if (a === '--config-env') { g.configEnv.push(args[i + 1] ?? ''); i += 2; continue }
    if (a.startsWith('--config-env=')) { g.configEnv.push(a.slice(13)); i += 1; continue }
    if (a === '--git-dir') { g.gitDir = args[i + 1] ?? null; i += 2; continue }
    if (a === '--work-tree') { g.workTree = args[i + 1] ?? null; i += 2; continue }
    if (a.startsWith('--git-dir=')) { g.gitDir = a.slice(10); i += 1; continue }
    if (a.startsWith('--work-tree=')) { g.workTree = a.slice(12); i += 1; continue }
    if (['--namespace', '--super-prefix', '--attr-source'].includes(a)) { i += 2; continue }
    if (a.startsWith('-')) { i += 1; continue }
    g.sub = a
    g.subAt = i
    g.rest = args.slice(i + 1)
    break
  }
  return g
}

/**
 * Each directory a git command may act in, after `cd` and each -C, which git
 * changes to with chdir(), following a link before a `..` (dirsAfter()). One,
 * unless chdir() finds nothing there now: then the path's reading and one
 * nobody can know (null). A rule checks each, and refuses if any refuses.
 */
export function gitDirsOf(state, g) {
  let dirs = [state.cwd]
  for (const d of g.dirs) dirs = [...new Set(dirs.flatMap((dir) => dirsAfter(dir, d, true)))]
  return dirs
}

/** The first of gitDirsOf(): where chdir() goes, or the path's reading where it finds nothing; null if unknowable. */
export function gitDirOf(state, g) {
  return gitDirsOf(state, g)[0]
}

/**
 * Ask git something read-only. Any failure is "no answer", never an error.
 * Each question is asked once per walk: the checkout does not change while
 * the guard reads a command, and a command can ask the same thing many times.
 * `g` carries what chooses the repository the command acts on, so the answer
 * is about that one: --git-dir and --work-tree, and in `g.env` the GIT_DIR,
 * GIT_WORK_TREE and GIT_COMMON_DIR it sets. `until` cuts the usual two
 * seconds short. The answer is trimmed, unless `raw`: a file's bytes are
 * not, since trim() would take a byte-order mark off JSON that does not parse
 * with one.
 *
 * Every question runs with GIT_ENV, which both hooks give every git call
 * they make. Nothing it asks reaches the network. In a partial clone, an
 * object the clone lacks would otherwise be fetched from the promisor remote
 * mid-question: GIT_NO_LAZY_FETCH stops that from git 2.44, and an empty
 * GIT_ALLOW_PROTOCOL, which allows no transport at all, stops it on any git.
 * GIT_TERMINAL_PROMPT=0 keeps git from asking a terminal for credentials.
 * And nothing it reads goes through a replace ref: `git replace` makes git
 * read one object as another, so the commit at origin/HEAD could otherwise
 * be read with a tree it does not hold, and a pull-request repository as
 * trunk. GIT_NO_REPLACE_OBJECTS turns replace refs off.
 */
export const GIT_ENV = Object.freeze({ GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' })
const answers = new Map()
function git(dir, g, args, until = Infinity, raw = false) {
  const pre = []
  if (g?.gitDir) pre.push(`--git-dir=${g.gitDir}`)
  if (g?.workTree) pre.push(`--work-tree=${g.workTree}`)
  const env = g?.env ?? {}
  const key = [dir, raw, ...pre, ...Object.entries(env).flat(), ...args].join('\u0000')
  if (answers.has(key)) return answers.get(key)
  let answer = null
  const ms = Math.min(2000, until - Date.now())
  try {
    if (ms > 0) {
      answer = execFileSync('git', [...pre, ...args], {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: ms,
        maxBuffer: 8 << 20,
        env: { ...process.env, ...env, GIT_OPTIONAL_LOCKS: '0', ...GIT_ENV },
      })
      if (!raw) answer = answer.trim()
    }
  } catch {
    // Not a repository, no such ref, no git on the PATH, out of time: nothing to decide on.
  }
  answers.set(key, answer)
  return answer
}

/**
 * The branch `dir` is on (or will be, by then), or null when detached or
 * unknown. A command that names its repository another way (`g.named`) is on
 * whatever branch that repository is on: what earlier commands switched in
 * `dir` says nothing about it, so git is asked.
 */
function branchAt(dir, g, state) {
  if (g.named.length === 0 && Object.hasOwn(state.vbranch, dir)) {
    const planned = state.vbranch[dir]
    return planned ? { name: planned, unborn: false } : null
  }
  const name = git(dir, g, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  if (!name) return null
  return { name, unborn: git(dir, g, ['rev-parse', '--verify', '--quiet', 'HEAD']) === null }
}

/**
 * When a question asked only to refuse more, or to say more, stops being
 * asked: the walk's own deadline. Past it, the answer is no answer, so what
 * turns on it is refused, and the guard never runs on into the hook's timeout,
 * which would let the command through.
 */
const deadline = () => budget?.until ?? Infinity

/**
 * Whether git can read the repository a command in `dir` acts on. Not when
 * it names one by a path the shell has yet to fill in (GIT_DIR=$PWD/.git,
 * --git-dir="$(pwd)/.git"), which the guard sees as written, or one that is
 * no repository: then git answers nothing about it, its branch included.
 */
const readable = (dir, g) => dir !== null && git(dir, g, ['rev-parse', '--git-dir'], deadline()) !== null

/** main, master, and whatever the remote calls its default branch. */
function protectedNames(dir, g) {
  const names = new Set(['main', 'master'])
  const remoteHead = dir === null ? null : git(dir, g, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  if (remoteHead) names.add(remoteHead.replace(/^[^/]+\//, ''))
  return names
}

/* ── the harness, and how its repository delivers ───────────────────────────
 *
 * The harness directory is not a fixed name: each organisation names its own.
 * It is found by one rule here, in session-start.mjs (which imports what it
 * needs from here) and in the CLI: the single top-level directory whose name
 * starts with a dot, .git aside, holding a harness.json that parses to a JSON
 * object with a numeric `harness`. harnessesIn() applies it to a working tree,
 * for the orientation; committedDelivery() to a commit, for the guard.
 *
 * Neither reads a manifest over MAX_MANIFEST, so none can hold the guard up.
 * The CLI has no such limit, and reads the working tree, where a harness
 * directory that is a link counts; committedDelivery() reads a commit, where
 * a link is only a link, and where an edit nobody has pushed is not yet. Where
 * they differ, the guard holds the repository to pull requests.
 */

const PULL_REQUEST = 'pull-request'
const TRUNK = 'trunk'
export const MAX_MANIFEST = 1 << 20

/** `text` as a harness manifest, a JSON object with a numeric `harness`; null if it is not one. */
function asManifest(text) {
  try {
    const m = JSON.parse(text)
    return m !== null && typeof m === 'object' && !Array.isArray(m) && typeof m.harness === 'number' ? m : null
  } catch {
    // JSON that does not parse is not a manifest.
    return null
  }
}

/**
 * The harnesses in a working tree's root: each entry there whose name starts
 * with a dot (.git aside), that is a directory, and that holds a harness.json
 * of at most MAX_MANIFEST bytes parsing to a JSON object with a numeric
 * `harness`. Sorted by name, as { dir, manifest }. Exactly one is the
 * repository's harness; none, or more than one, means it has none. Never
 * throws: what cannot be read is not a harness.
 */
export function harnessesIn(root) {
  let names
  try {
    names = readdirSync(root).sort()
  } catch {
    // Not a directory, or not one this process can read.
    return []
  }
  const found = []
  for (const name of names) {
    if (!name.startsWith('.') || name === '.git') continue
    try {
      if (!statSync(join(root, name)).isDirectory()) continue
      const file = join(root, name, 'harness.json')
      // A file, not a fifo or a device, which could wait forever; and not one too big to read in time.
      const stat = statSync(file)
      if (!stat.isFile() || stat.size > MAX_MANIFEST) continue
      const manifest = asManifest(readFileSync(file, 'utf8'))
      if (manifest) found.push({ dir: name, manifest })
    } catch {
      // No harness.json, a link to nowhere, a file this process cannot read: not a harness.
    }
  }
  return found
}

/** A manifest's delivery mode: trunk when it says exactly that, pull-request for anything else. */
export function deliveryOf(manifest) {
  return manifest?.delivery?.mode === TRUNK ? TRUNK : PULL_REQUEST
}

/** Where a repository's mode is read from, in this order: its remote's default branch, then main, then master. */
const REMOTE_DEFAULTS = ['origin/HEAD', 'origin/main', 'origin/master']
const MODE_MS = 2000

/**
 * The delivery mode a repository has committed: the manifest in the commit
 * at origin/HEAD (or else origin/main, or else origin/master), never the
 * working tree, so an edit nobody has pushed and fetched cannot switch it.
 * The worktrees of a repository share those refs, so they share the answer.
 * `dir` is any directory inside the repository. `until` is when git stops
 * being asked: MODE_MS from now, all told, unless a caller shares its own.
 *
 * Returns { mode, ref, dir, manifest, why, candidates }. `ref` is the one it
 * was read from, null when none resolves; `dir` and `manifest` the harness
 * there, when there is exactly one. Anything short of that is pull-request,
 * and `why` says which: 'no-ref', 'no-harness', 'several', 'too-big' (a
 * manifest over MAX_MANIFEST, which is never read), 'missing' (a manifest
 * whose blob this clone does not have: a partial clone, which is never asked
 * to fetch it) or 'unread' (git did not answer within MODE_MS, all told, even
 * about which of those refs there are). The last three say nothing of what
 * the manifest says, which could be trunk. A link, a directory or a submodule
 * where harness.json should be is not a manifest: a commit holds the link,
 * not what it points at. Never throws.
 *
 * `candidates` counts what in that commit could be a manifest: each
 * harness.json in a top-level directory whose name starts with a dot,
 * whatever kind of entry it is, and each top-level entry whose name starts
 * with a dot that is a link or a submodule, which a checkout makes into a
 * directory the commit does not show. Null where the listing was not read to
 * the end. 'no-harness' with none at all is a repository with no manifest,
 * the one kind that takes its project's mode (deliveryIn()); one that is
 * malformed, a link, or one of several is not.
 */
export function committedDelivery(dir, until = Math.min(budget?.until ?? Infinity, Date.now() + MODE_MS)) {
  const ask = (args, raw = false) => git(dir, null, args, until, raw)
  const pullRequest = (ref, why, candidates = null) => ({ mode: PULL_REQUEST, ref, dir: null, manifest: null, why, candidates })
  try {
    if (dir === null) return pullRequest(null, 'no-ref')
    let ref = null
    let commit = null
    for (const name of REMOTE_DEFAULTS) {
      commit = ask(['rev-parse', '--verify', '--quiet', `refs/remotes/${name}^{commit}`])
      if (commit) { ref = name; break }
    }
    // None resolves, or git ran out of time asking: a question cut off at the
    // deadline, or never asked past it, says nothing about whether one would.
    if (!commit) return pullRequest(null, Date.now() < until ? 'no-ref' : 'unread')
    // --full-tree: from a subdirectory, ls-tree would list only that part of the tree.
    const root = ask(['ls-tree', '--full-tree', '-z', commit])
    if (root === null) return pullRequest(ref, 'unread')
    const dirs = []
    let candidates = 0
    for (const entry of root.split('\0')) {
      const m = /^(\d+) (\w+) [0-9a-f]+\t(\..*)$/s.exec(entry)
      if (!m || m[3] === '.git') continue
      if (m[2] === 'tree') dirs.push(m[3])
      // A link or a submodule: checked out, a directory that may hold a manifest the commit cannot show.
      else if (m[1] === '120000' || m[1] === '160000') candidates += 1
    }
    if (dirs.length === 0) return pullRequest(ref, 'no-harness', candidates)
    const manifests = ['--', ...dirs.map((d) => `${d}/harness.json`)]
    const listed = ask(['--literal-pathspecs', 'ls-tree', '--full-tree', '-z', '-l', commit, ...manifests])
    if (listed === null) {
      // -l reads each blob for its size. A git older than 2.44 fails it for a
      // blob a partial clone lacks, since it may not fetch one; listing the
      // same entries without sizes tells that apart from git not answering.
      const names = ask(['--literal-pathspecs', 'ls-tree', '--full-tree', '-z', commit, ...manifests])
      return pullRequest(ref, names ? 'missing' : 'unread')
    }
    const found = []
    for (const entry of listed.split('\0')) {
      if (entry === '') continue
      // Each entry listed is one of those harness.json, of whatever kind: a directory is listed, not entered.
      candidates += 1
      // A regular file, sized before anything reads it. A size git cannot give
      // (BAD) is a blob this clone does not have, and nothing here fetches it.
      const m = /^(?:100644|100755) blob ([0-9a-f]+) +(\S+)\t(.*)\/harness\.json$/s.exec(entry)
      if (!m) continue
      if (!/^\d+$/.test(m[2])) return pullRequest(ref, 'missing')
      if (Number(m[2]) > MAX_MANIFEST) return pullRequest(ref, 'too-big')
      const text = ask(['cat-file', 'blob', m[1]], true)
      if (text === null) return pullRequest(ref, 'unread')
      const manifest = asManifest(text)
      if (manifest) found.push({ dir: m[3], manifest })
    }
    if (found.length !== 1) return pullRequest(ref, found.length === 0 ? 'no-harness' : 'several', candidates)
    return { mode: deliveryOf(found[0].manifest), ref, dir: found[0].dir, manifest: found[0].manifest, why: null, candidates }
  } catch {
    // Whatever went wrong, the stricter mode: a mode nobody could read grants nothing.
    return pullRequest(null, 'unread')
  }
}

/**
 * What the repository `dir` is in has committed (committedDelivery()), read
 * once per directory in a walk; null where `dir` cannot be known. `until` is
 * the first reading's deadline, when its caller shares one.
 */
const modes = new Map()
function committedIn(dir, until) {
  if (dir === null) return null
  if (!modes.has(dir)) modes.set(dir, committedDelivery(dir, until))
  return modes.get(dir)
}

/**
 * The session's project directory, which Claude Code gives every hook as
 * CLAUDE_PROJECT_DIR; null when it gives none, or a relative one. A command
 * cannot set it: the hook runs with Claude Code's environment, not the
 * command's.
 */
function projectDir() {
  const dir = process.env.CLAUDE_PROJECT_DIR
  return typeof dir === 'string' && isAbsolute(dir) ? dir : null
}

/** Whether the real path `child` is strictly inside the real path `parent`: up to a separator, so neither <parent>-evil nor <parent> is. */
const strictlyInside = (child, parent) => child !== parent && child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`)

/**
 * The delivery mode that applies in `dir`, as { mode, from }, read once per
 * directory in a walk. It is the mode the repository `dir` is in has
 * committed (committedIn()), with `from` null, unless all of these hold;
 * then it is the mode the session's project has committed, inherited, and
 * `from` is the project's directory:
 *
 *   - the repository has nothing at its remote default that could be a
 *     manifest: 'no-harness', with no candidates (committedDelivery()). One
 *     that is malformed, a link, one of several, too big, missing or unread
 *     stays pull-request, and one that reads keeps its own mode;
 *   - CLAUDE_PROJECT_DIR is set (projectDir());
 *   - the repository is strictly inside that directory, by real path on both
 *     sides: its top level, its git directory and its common git directory,
 *     all three (insideProject()). A link into the project from outside
 *     counts, and a link inside it to a repository elsewhere does not; nor
 *     does a linked worktree, a .git file or core.worktree that puts only a
 *     working tree inside;
 *   - the project's own manifest is found, as any repository's is
 *     (committedIn()). A project directory that is no repository, as a
 *     folder of clones side by side may be, or that commits no manifest,
 *     gives nothing to inherit.
 *
 * The git questions share one MODE_MS, inside the walk's deadline, and out of
 * time is pull-request. A command that names its repository another way
 * (--git-dir, --work-tree, GIT_DIR …) is held to pull requests before any
 * mode is read (landing(), gitRule()), so nothing here can reopen it.
 */
const applied = new Map()
function deliveryIn(dir) {
  if (dir === null) return { mode: PULL_REQUEST, from: null }
  if (!applied.has(dir)) applied.set(dir, ownOrInherited(dir))
  return applied.get(dir)
}

function ownOrInherited(dir) {
  const until = Math.min(deadline(), Date.now() + MODE_MS)
  const own = committedIn(dir, until)
  const kept = { mode: own.mode, from: null }
  const project = projectDir()
  if (own.why !== 'no-harness' || own.candidates !== 0 || project === null) return kept
  if (!insideProject(dir, project, until)) return kept
  const theirs = committedIn(project, until)
  return theirs.why === null ? { mode: theirs.mode, from: project } : kept
}

/**
 * Whether the repository a command in `dir` acts on is strictly inside
 * `project`, by real path: its top level, its git directory and its common
 * git directory, all three. They can each be somewhere else. A linked
 * worktree's top level is wherever it was added, while its refs, remotes
 * and configuration are in the common git directory of the repository it
 * belongs to; a .git file names a git directory anywhere; core.worktree puts
 * a working tree anywhere; and a worktree's own git directory, which holds
 * its HEAD and index, names its common one in a file. Inside by one of them
 * is not inside.
 *
 * git prints a git directory relative to the directory it runs in, which is
 * the real path of `dir`, so that is what a relative answer is resolved
 * against. Each path is then compared by its real path as realpath(3) finds
 * it, the project's too, which also settles a name's case on a file system
 * that ignores it. An answer that does not come, or a path that does not
 * resolve, is not inside.
 */
function insideProject(dir, project, until) {
  const top = git(dir, null, ['rev-parse', '--show-toplevel'], until)
  const dirs = top ? git(dir, null, ['rev-parse', '--git-dir', '--git-common-dir'], until)?.split('\n') : null
  if (!dirs || dirs.length !== 2 || dirs.includes('')) return false
  const here = realPath(dir)
  const root = realPath(project)
  if (here === null || root === null) return false
  return [top, ...dirs.map((d) => resolve(here, d))].every((path) => {
    const real = realPath(path)
    return real !== null && strictlyInside(real, root)
  })
}

/** The delivery mode that applies in `dir`: its repository's own, or its project's (deliveryIn()). */
const deliveryMode = (dir) => deliveryIn(dir).mode

/* ── when a commit or push may land on main ─────────────────────────────── */

/** The variables that choose a repository other than the one a command runs in. */
const ELSEWHERE_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']

/** What a git command names its repository with, other than where it runs: --git-dir, GIT_DIR …; none, most often. */
function namedElsewhere(g, state) {
  const named = []
  if (g.gitDir !== null) named.push('--git-dir')
  if (g.workTree !== null) named.push('--work-tree')
  for (const name of ELSEWHERE_ENV) if (state.env?.has(name)) named.push(name)
  return named
}

/** GIT_DIR, GIT_WORK_TREE and GIT_COMMON_DIR as the command sets them, for git's answers about it. */
function repositoryEnv(state) {
  const env = {}
  for (const name of ELSEWHERE_ENV) {
    const set = state.env?.get(name)
    if (set) env[name] = set.value
  }
  return env
}

/** Config keys that decide where or how a push goes: a remote, its refspecs, its mirror flag, push.default, a branch's push remote, a URL rewrite. */
const DECIDES = /^(remote|push|branch|url)\./i

/**
 * git configuration given on the command line that could change where or how
 * a push goes, named; or null. A -c whose key DECIDES matches; any
 * --config-env, whose value is out of sight; any GIT_CONFIG_* variable; and a
 * -c the shell fills in, when it could fill in the key (`-c "$KV"`) or split
 * into more words, another -c among them (`-c core.editor=$E`). `words` are
 * the command's words after `git`.
 */
function configured(g, state, words) {
  const key = g.configs.find((c) => DECIDES.test(c))
  if (key !== undefined) return `-c ${key.split('=')[0]}`
  if (g.configEnv.length > 0) return `--config-env ${g.configEnv[0].split('=')[0]}`
  for (const name of (state.env ?? NO_ENV).keys()) if (name.startsWith('GIT_CONFIG')) return name
  const filled = g.configAt.some((k) => words[k]?.d && (words[k].u || !/^[^$`]*=/.test(words[k].t)))
  return filled ? 'a -c that comes from an expansion' : null
}

/** A config key that reads more configuration from a file: include.path, or includeIf.<condition>.path. */
const INCLUDES = /^include(if\.[^=]*)?\.path(=|$)/i

/** Variables that choose the files git reads its own configuration from, or that it reads none. */
const CONFIG_FILES = ['HOME', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM']

/**
 * Whether git's hooks are, or may be, switched off, as the refusal to give;
 * or null. core.hooksPath set through -c, --config-env, GIT_CONFIG_KEY_<n> or
 * GIT_CONFIG_PARAMETERS is NO_VERIFY. Configuration the guard cannot read,
 * which could set it, is refused too (configElsewhere): a file brought in by
 * include.path or includeIf.<condition>.path, through any of those four, and
 * a global or system configuration other than the one git would read, or
 * none (CONFIG_FILES).
 */
function hooksOff(g, state) {
  if (g.configs.some((c) => /^core\.hookspath(=|$)/i.test(c))) return NO_VERIFY
  if (g.configEnv.some((c) => /^core\.hookspath=/i.test(c))) return NO_VERIFY
  const env = state.env ?? NO_ENV
  for (const [name, set] of env) {
    if (/^GIT_CONFIG_KEY_\d+$/.test(name) && /^core\.hookspath$/i.test(set.value)) return NO_VERIFY
    if (name === 'GIT_CONFIG_PARAMETERS' && /core\.hookspath/i.test(set.value)) return NO_VERIFY
  }
  const included = g.configs.find((c) => INCLUDES.test(c))
  if (included !== undefined) return configElsewhere(`-c ${included.split('=')[0]}`, g.sub)
  const viaEnv = g.configEnv.find((c) => INCLUDES.test(c))
  if (viaEnv !== undefined) return configElsewhere(`--config-env ${viaEnv.split('=')[0]}`, g.sub)
  for (const [name, set] of env) {
    if (/^GIT_CONFIG_KEY_\d+$/.test(name) && INCLUDES.test(set.value)) return configElsewhere(`${name}=${set.value}`, g.sub)
    if (name === 'GIT_CONFIG_PARAMETERS' && /include(if\.[^=]*)?\.path/i.test(set.value)) return configElsewhere(name, g.sub)
  }
  const file = CONFIG_FILES.find((name) => env.has(name))
  return file === undefined ? null : configElsewhere(file, g.sub)
}

/**
 * Whether an expansion in `word` could put an option on the command line
 * that the guard cannot read. Unquoted (or "$@"), the shell splits it into as
 * many words as its value holds, so it could be any number of options, even
 * where an option's value was expected; quoted, it is one word, and an option
 * only when the expansion decides how that word starts. `value` says the word
 * is an option's value, and `settled` matches a start that already says which
 * option the word is: `--message=$M`, `-m$M`.
 */
function mayAddOption(word, value, settled) {
  if (!word?.d || word.hidden) return false
  if (word.u) return true
  if (value) return false
  const at = word.t.search(/[$`]/)
  const head = at < 0 ? word.t : word.t.slice(0, at)
  return head === '' || (head.startsWith('-') && !settled.test(head))
}

const heldElsewhere = (named) => ({
  why: `it names its repository with ${named.join(' and ')}, and the guard reads a delivery mode only from the repository a command runs in`,
  instead: 'run it in that repository instead (cd <dir> && git …, or git -C <dir> …), where its own delivery mode applies',
})
const heldByConfig = (what, sub) => ({
  why: sub === 'push'
    ? `${what} sets git configuration that could make it a force push, a mirror or a push to somewhere else, and trunk lets only a plain push land on main`
    : `${what} sets git configuration whose effect the guard cannot see, and trunk lets only a plain commit land on main`,
  instead: `drop ${what} and run it plainly`,
})
const heldExpanded = (sub) => ({
  why: sub === 'push'
    ? 'an option or refspec in it comes from an expansion the guard cannot read, which could be --force, and trunk lets only a plain push land on main'
    : 'an option in it comes from an expansion the guard cannot read, which could be --no-verify, and trunk lets only a plain commit land on main',
  instead: sub === 'push' ? 'write the options and refspecs out in full' : 'write the options out in full',
})
const heldRemote = (remote) => ({
  why: `it pushes to ${remote ?? 'a remote the guard cannot read'}, and trunk was decided for ${ORIGIN}, the remote whose default branch the mode is read from`,
  instead: `push to ${ORIGIN} instead (git push ${ORIGIN} <branch>), or push your own branch to ${remote ?? 'that remote'} and open a pull request there`,
})

/** The remote trunk was decided for: the one whose default branch the mode is read from. */
const ORIGIN = 'origin'

/**
 * The remote a push with no repository argument goes to from `branch`, as
 * git chooses it (branch.<name>.pushRemote, remote.pushDefault,
 * branch.<name>.remote, else origin); null when git does not say.
 */
function pushRemote(dir, g, branch) {
  if (dir === null || !branch) return null
  const name = git(dir, g, ['for-each-ref', '--format=%(push:remotename)', `refs/heads/${branch}`], deadline())
  return name === null ? null : name || ORIGIN
}

/**
 * Whether a commit or push that lands on main may, in the repository `dir`.
 * undefined: it may, because the mode that applies there (deliveryIn(): the
 * repository's committed mode, or its project's) is trunk and nothing about
 * the command could change what it does. null: it may not, the mode is
 * pull-request. Otherwise it may not because the guard holds it to
 * pull requests, and this says why, as { why, instead }:
 *
 *   - it names its repository another way than where it runs (--git-dir,
 *     --work-tree, GIT_DIR, GIT_WORK_TREE, GIT_COMMON_DIR): the mode read here
 *     would be some other repository's, so none is read;
 *   - in trunk, configuration given on the command line could make it a force
 *     push, a mirror or a push somewhere else (see configured());
 *   - in trunk, an option or refspec in it comes from an expansion
 *     (`F=--force; git push $F origin main`);
 *   - in trunk, a push goes to a remote other than origin, or to a URL or a
 *     path: the mode was read from origin's default branch, so it says what
 *     may land there and nowhere else. `remote`, for a push, gives where it
 *     goes; null for a commit.
 *
 * Trunk's own refusals stand either way: being held to pull requests only
 * adds the refusal of what lands on main, it never allows a force push.
 */
function landing(g, state, dir, words, expanded, remote = null) {
  if (g.named.length > 0) return heldElsewhere(g.named)
  if (deliveryMode(dir) !== TRUNK) return null
  const config = configured(g, state, words)
  if (config !== null) return heldByConfig(config, g.sub)
  if (expanded) return heldExpanded(g.sub)
  const to = remote === null ? ORIGIN : remote()
  if (to !== ORIGIN) return heldRemote(to)
  return undefined
}

/* ── refs written by hand ───────────────────────────────────────────────────
 *
 * The mode is read through refs no command should write by hand: the
 * remote-tracking refs it is read from (origin/HEAD, else origin/main, else
 * origin/master), which only a fetch should move, and replace refs, which
 * make git read one object as another, so a commit there could be read with
 * another tree. Both are matched in any case: on a file system that ignores
 * case, refs/REMOTES/x is the same file.
 */
const GUARDED = /^refs\/(remotes|replace)\//i

/** The options of the commands that write refs, as readArgs() takes them: name: [long, short, takes a value]. */
const UPDATE_REF = {
  m: ['', 'm', true], d: ['', 'd'], z: ['', 'z'], stdin: ['stdin', ''], noDeref: ['no-deref', ''],
  createReflog: ['create-reflog', ''], batch: ['batch-updates', '0'],
}
const SYMBOLIC_REF = { quiet: ['quiet', 'q'], delete: ['delete', 'd'], short: ['short', ''], recurse: ['recurse', ''], m: ['', 'm', true] }
const SET_HEAD = { auto: ['auto', 'a'], delete: ['delete', 'd'] }
const REPLACE = {
  list: ['list', 'l'], delete: ['delete', 'd'], edit: ['edit', 'e'], graft: ['graft', 'g'], convert: ['convert-graft-file', ''],
  force: ['force', 'f'], raw: ['raw', ''], format: ['format', '', true],
}

/**
 * A subcommand's arguments read the way git's parse-options reads them, for
 * the commands that write refs, where every spelling counts: options
 * anywhere, until `--` or --end-of-options; short ones bundled, where one
 * that takes a value ends its bundle (`-dm why`, `-mwhy`); long ones cut to
 * any prefix that names only one (`--dele`, `--std`) and turned off with
 * --no-, the last spelling winning. `spec` names each option; one it does
 * not name is read as a flag, which git takes or fails on. `words` are the
 * lexer's words for `args`.
 *
 * Returns { on, positional, loose }: the options set at the end, by their
 * names in `spec`; the other words, as the lexer's; and how many of those
 * came before the first word whose meaning an expansion decides, or
 * Infinity. Such a word (`$R`, `-$X`, `--$Y`, `-m $MSG`) may be an option,
 * or several words, so from there on nothing says which word is which.
 */
function readArgs(args, words, spec) {
  const on = new Set()
  const positional = []
  let loose = Infinity
  const unsure = () => { loose = Math.min(loose, positional.length) }
  // An option's value in the word after it: split by the shell, it would move every word after it.
  const valueAt = (i) => { if (words[i]?.d && words[i].u) unsure() }
  const options = Object.entries(spec)
  const longOption = (text) => {
    for (const [name, [long]] of options) if (long === text) return [name, true]
    for (const [name, [long]] of options) if (long && text === `no-${long}`) return [name, false]
    const hits = options.filter(([, [long]]) => long && long.startsWith(text)).map(([name]) => [name, true])
    if (text.startsWith('no-')) hits.push(...options.filter(([, [long]]) => long && long.startsWith(text.slice(3))).map(([name]) => [name, false]))
    return hits.length === 1 ? hits[0] : null
  }
  let ended = false
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]
    const word = words[i] ?? { t: a, d: false, u: false }
    // Unquoted (or "$@"): the shell splits it into as many words as its value holds.
    if (word.d && word.u) unsure()
    if (ended || a === '-' || !a.startsWith('-')) { positional.push(word); continue }
    if (a === '--' || a === '--end-of-options') { ended = true; continue }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      const text = a.slice(2, eq < 0 ? a.length : eq)
      if (word.d && /[$`]/.test(text)) { unsure(); continue }
      const hit = longOption(text)
      if (hit === null) continue
      const [name, set] = hit
      if (!set) on.delete(name)
      else if (!spec[name][2]) on.add(name)
      else if (eq < 0) { i += 1; valueAt(i) }
      continue
    }
    for (let k = 1; k < a.length; k += 1) {
      if (word.d && /[$`]/.test(a[k])) { unsure(); break }
      const hit = options.find(([, [, short]]) => short === a[k])
      if (hit === undefined) continue
      const [name, [, , takesValue]] = hit
      if (!takesValue) { on.add(name); continue }
      // The rest of the bundle is its value, or else the next word is.
      if (k === a.length - 1) { i += 1; valueAt(i) }
      break
    }
  }
  return { on, positional, loose }
}

/**
 * How a command writes, or may write, a ref the mode is read through, said
 * for a refusal, as { what, replace, expanded }: `replace` when the ref is a
 * replace ref, `expanded` when an expansion hides which ref it is. Or null.
 * Reading a ref is fine.
 *
 *   - git update-ref writing or deleting one; with --stdin, input that names
 *     one, that holds an expansion, or that the line does not show (a pipe,
 *     a file). `stdin` is that input when the line shows it: a heredoc or a
 *     here-string.
 *   - git symbolic-ref writing or deleting one, or pointing a ref at one,
 *     which writes there whenever the ref is written through: HEAD, by every
 *     commit.
 *   - git remote set-head given a branch or -d, after any of remote's own
 *     options (-v): --auto asks the remote, as a fetch would.
 *   - git replace, but for a listing (-l, or no object named).
 *
 * Every spelling git takes counts (readArgs()). A ref the shell fills in
 * cannot be known here, so where one would be written, or where an
 * expansion could split into options or more words, it is refused.
 */
function refRewritten(g, words, stdin) {
  const r = g.rest
  const rewrites = (ref, what = `this rewrites ${ref} by hand`) => ({ what, replace: /^refs\/replace\//i.test(ref), expanded: false })
  const hidden = (what) => ({ what, replace: false, expanded: true })
  const writtenRef = (cmd) => hidden(`the ref ${cmd} writes comes from an expansion the guard cannot read, so it may be a remote-tracking ref`)

  if (g.sub === 'remote') {
    // remote's own options (-v, --verbose) come before its subcommand.
    let k = 0
    while (k < r.length && r[k].startsWith('-')) k += 1
    if (r[k] !== 'set-head') return null
    const { on, positional, loose } = readArgs(r.slice(k + 1), words.slice(k + 1), SET_HEAD)
    if (loose !== Infinity) return hidden("an expansion the guard cannot read decides what this git remote set-head does, so it may set or delete a remote's HEAD by hand")
    if (positional.length === 0 || on.has('auto') || (positional.length === 1 && !on.has('delete'))) return null
    return rewrites(`refs/remotes/${positional[0].t}/HEAD`)
  }

  if (g.sub === 'replace') {
    const { on, positional, loose } = readArgs(r, words, REPLACE)
    // -l lists, and git refuses -d, --edit or --graft beside it; with nothing named, git replace lists too.
    if (on.has('list')) return null
    if (positional.length === 0 && loose === Infinity && !['delete', 'edit', 'graft', 'convert'].some((mode) => on.has(mode))) return null
    return rewrites('refs/replace/', 'git replace writes a replace ref (refs/replace/…)')
  }

  if (g.sub === 'update-ref') {
    const { on, positional, loose } = readArgs(r, words, UPDATE_REF)
    if (on.has('stdin')) {
      if (stdin === null) return hidden('git update-ref --stdin writes whatever refs its input names, and the guard cannot see that input: it may name a remote-tracking ref')
      const named = /refs\/(remotes|replace)\//i.exec(stdin)
      if (named) {
        const kind = /^replace$/i.test(named[1]) ? 'a replace ref' : 'a remote-tracking ref'
        return rewrites(named[0], `this rewrites ${kind} by hand, through git update-ref --stdin`)
      }
      if (/[$`]/.test(stdin)) return hidden('git update-ref --stdin writes whatever refs its input names, and an expansion in that input is one the guard cannot read: it may name a remote-tracking ref')
      return null
    }
    const ref = positional[0]
    if (loose === 0 || ref?.d) return writtenRef('git update-ref')
    return ref !== undefined && GUARDED.test(ref.t) ? rewrites(ref.t) : null
  }

  // git symbolic-ref: one name reads it; a name and a target, or --delete, write.
  const { on, positional, loose } = readArgs(r, words, SYMBOLIC_REF)
  if (loose !== Infinity) return hidden('an expansion the guard cannot read decides what this git symbolic-ref writes, so it may write a remote-tracking ref, or point a ref at one')
  const [name, target] = positional
  if (name === undefined || (target === undefined && !on.has('delete'))) return null
  if (name.d) return writtenRef('git symbolic-ref')
  if (GUARDED.test(name.t)) return rewrites(name.t)
  if (target === undefined) return null
  if (target.d) return hidden(`the ref git symbolic-ref points ${name.t} at comes from an expansion the guard cannot read, so it may be a remote-tracking ref`)
  if (!GUARDED.test(target.t)) return null
  return rewrites(target.t, `this points ${name.t} at ${target.t}, so whatever writes ${name.t} (a commit writes HEAD) would write ${target.t} by hand`)
}

/** The branch a checkout, switch or `worktree add` leaves a directory on. */
function branchAfter(g, dir) {
  const r = g.rest
  if (g.sub === 'switch' || g.sub === 'checkout') {
    if (r.includes('--')) return undefined
    const creates = g.sub === 'switch' ? ['-c', '-C', '--create', '--force-create'] : ['-b', '-B', '--orphan']
    const at = r.findIndex((a) => creates.includes(a))
    if (at >= 0) return r[at + 1] ? { [dir]: r[at + 1] } : undefined
    const attached = r.find((a) => /^--(create|force-create|orphan)=/.test(a))
    if (attached) return { [dir]: attached.slice(attached.indexOf('=') + 1) }
    if (r.includes('--detach') || (g.sub === 'switch' && r.includes('-d'))) return { [dir]: '' }
    const args = r.filter((a) => !a.startsWith('-'))
    if (args.length !== 1) return undefined
    const target = args[0]
    if (target === '-') return { [dir]: null }
    if (git(dir, g, ['rev-parse', '--verify', '--quiet', `refs/heads/${target}`]) !== null) return { [dir]: target }
    if (git(dir, g, ['for-each-ref', '--count=1', '--format=%(refname)', `refs/remotes/*/${target}`])) return { [dir]: target }
    return g.sub === 'switch' ? { [dir]: target } : undefined
  }
  if (g.sub === 'worktree' && r[0] === 'add') {
    let branch = null
    let detach = false
    const positional = []
    for (let k = 1; k < r.length; k += 1) {
      const a = r[k]
      if (a === '-b' || a === '-B') { branch = r[k + 1] ?? null; k += 1; continue }
      if (a === '--reason') { k += 1; continue }
      if (a === '--detach' || a === '-d') { detach = true; continue }
      if (!a.startsWith('-')) positional.push(a)
    }
    const at = positional[0] ? dirAfter(dir, positional[0]) : null
    if (!at) return undefined
    if (branch) return { [at]: branch }
    if (detach) return { [at]: '' }
    const ref = positional[1]
    if (!ref) return { [at]: basename(at) }
    return { [at]: git(dir, g, ['rev-parse', '--verify', '--quiet', `refs/heads/${ref}`]) === null ? '' : ref }
  }
  return undefined
}

/* ── what is refused, and what to do instead ────────────────────────────── */

export const block = (what, instead) => ({ what, instead })

const NO_VERIFY = block('--no-verify (or core.hooksPath) skips the checks that CI runs anyway.',
  'fix what the hook reports, then run the command without it')
const RESET_HARD = block('git reset --hard throws away uncommitted work, and nothing brings it back.',
  'git stash push -m "<why>" to set work aside, or git restore <path> for one file')
const CLEAN = block('git clean -f deletes untracked files, and nothing brings them back.',
  'git clean -n to list them, then delete the ones you mean by name')
const RM_RF = block('rm -rf deletes without asking, and nothing brings it back.',
  'delete the specific paths you mean, by name')
const ADD_ALL = block('git add . / -A / --all stages scratch files, logs and secrets along with the change.',
  'stage the paths you changed: git add <path> ...')
const FORCE = block('a force push overwrites whatever landed on the remote since you last fetched.',
  'git fetch, then git push --force-with-lease')
const FORCE_IN_TRUNK = block("a force push rewrites what is already on the remote, and this repository's delivery mode is trunk: everyone builds on what was pushed, so no force push is allowed, --force-with-lease included.",
  'git pull --rebase to put your commits on top, then git push without force')
/**
 * One sentence more for a refusal that turned on a delivery mode inherited
 * from the project (deliveryIn()), so that it explains itself: nothing in the
 * repository names a mode, and its project's manifest does. '' for a
 * repository's own mode.
 */
const inheritedNote = ({ mode, from }) => (from === null ? ''
  : ` This repository has committed no harness manifest of its own, so its delivery mode, ${mode}, is inherited from the project at ${from}.`)
/** `refusal` as it is, or with inheritedNote() after it when the mode it turned on (`applied`, from deliveryIn()) was inherited. */
const explained = (refusal, applied) => (applied.from === null ? refusal : block(`${refusal.what}${inheritedNote(applied)}`, refusal.instead))
/**
 * A push or commit onto main, refused: the mode that applies is pull-request,
 * or (`held`, from landing()) the guard holds it to pull requests. `note`
 * follows the reason: see afterRefusal().
 */
const ontoMain = (did, name, held, instead, note) => (held === null
  ? block(`${did} ${name}, and this repository's delivery mode is pull-request: work reaches ${name} through a pull request.${note}`, instead)
  : block(`${did} ${name}, and ${held.why}: so the guard holds it to pull requests, where work reaches ${name} through a pull request.${note}`, held.instead))
const pushToMain = (name, held = null, note = '') => ontoMain('this pushes straight to', name, held,
  'push your own branch (git push -u origin <branch>) and open a pull request', note)
const commitOnMain = (name, held = null, note = '') => ontoMain('this commits straight onto', name, held,
  'git switch -c <type>/<short-name> first; staged changes come with you', note)
/** A commit or push that names a repository git cannot read: whether it lands on main cannot be known, so it is held to pull requests. */
const unreadable = (sub, named) => {
  const held = heldElsewhere(named)
  return block(`${sub === 'push' ? 'this pushes from' : 'this commits in'} a repository git cannot read from here (a path the shell has yet to fill in, or no repository), so it may land on main, and ${held.why}: so the guard holds it to pull requests, where work reaches main through a pull request.`,
    held.instead)
}
/** Configuration from a file the guard cannot read, or a global or system one other than git's own: see hooksOff(). */
const configElsewhere = (what, sub) => block(`${what} changes which git configuration applies, and the guard cannot read the result: it could switch git's hooks off (core.hooksPath), which skips the checks CI runs anyway${sub === 'push' ? ', or make the push a force push, a mirror or a push to somewhere else' : ''}.`,
  `drop ${what} and run it plainly`)
/** A remote-tracking ref rewritten by hand, or perhaps (`expanded`) through an expansion: see refRewritten(). */
const remoteRef = (what, expanded = false) => block(`${what}. A remote-tracking ref records what the remote has, and the guard reads the delivery mode from the commit at origin/HEAD (else origin/main, else origin/master): set by hand, it would change the mode with no commit on the remote.`,
  `${expanded ? 'write the ref out in full; ' : ''}git fetch to update a remote-tracking ref (git remote set-head origin --auto for origin/HEAD)`)
/** A replace ref written: see refRewritten(). */
const replaceRef = (what) => block(`${what}. A replace ref makes git read one object as another wherever it looks: the commit at origin/HEAD could be read with another tree in it, and another delivery mode, with no commit on the remote. The guard reads with replace refs off; every other git command follows them.`,
  'change what a commit holds with a commit of its own')
const deleteMain = (name) => block(`this deletes ${name} on the remote, the branch this repository's work lands on.`,
  `leave ${name} where it is; delete a branch you made by its own name`)
export const TOO_COMPLEX = block('this command is too big or too tangled for the guard to check, so it is refused rather than let through unchecked.',
  'split it into smaller commands, and run them one at a time')

/**
 * Whether `flag` (a long option, without its `=value`) is `name`, written in
 * full or cut short. git takes any prefix of a long option that names only
 * one: `--no-veri` is --no-verify, `--mirr` is --mirror, `--force-w` is
 * --force-with-lease. A prefix that names several (`--d`, --delete or
 * --dry-run) fails in git before anything runs, so reading it as the one that
 * is refused costs nothing.
 */
const isLong = (flag, name) => flag.length >= 3 && name.startsWith(flag)

/** Whether `args` switch git's hooks off with --no-verify, however it is spelled. */
function noVerifyIn(args) {
  for (const a of args) {
    if (a === '--') return false
    if (isLong(a, '--no-verify')) return true
  }
  return false
}

/**
 * Options of `git commit` that matter here, including the message it will
 * carry. Given the words `rest` was read from, `expanded` also says whether
 * an expansion could put an option there that cannot be read: a quoted
 * message (`-m "$(cat <<'EOF' …)"`) cannot, `$OPTS` can.
 */
export function commitOptions(rest, words = null) {
  const o = { noVerify: false, dryRun: false, messages: [], files: [], trailers: [], expanded: false }
  const values = new Set()
  let end = rest.length
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i]
    if (a === '--') { end = i; break }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      const flag = eq < 0 ? a : a.slice(0, eq)
      const value = () => {
        if (eq >= 0) return a.slice(eq + 1)
        i += 1
        values.add(i)
        return rest[i] ?? ''
      }
      if (isLong(flag, '--no-verify')) o.noVerify = true
      else if (flag === '--dry-run') o.dryRun = true
      else if (flag === '--message') o.messages.push(value())
      else if (flag === '--file') o.files.push(value())
      else if (flag === '--trailer') o.trailers.push(value())
      else if (eq < 0 && ['--author', '--date', '--fixup', '--squash', '--reuse-message', '--reedit-message',
        '--template', '--cleanup', '--pathspec-from-file'].includes(flag)) value()
      continue
    }
    if (!a.startsWith('-') || a.length < 2) continue
    for (let k = 1; k < a.length; k += 1) {
      const f = a[k]
      if (f === 'n') { o.noVerify = true; continue }
      if ('mFcCt'.includes(f)) {
        let v = a.slice(k + 1)
        if (k === a.length - 1) { i += 1; values.add(i); v = rest[i] ?? '' }
        if (f === 'm') o.messages.push(v)
        if (f === 'F') o.files.push(v)
        break
      }
      if (f === 'S' || f === 'u') break
    }
  }
  if (words !== null) o.expanded = words.some((w, k) => k < end && mayAddOption(w, values.has(k), /^(--[^=]+=|-[A-Za-z]*[mFcCt])/))
  return o
}

/**
 * Options of `git push` that matter here. The ones that are refused are read
 * however git would read them, cut short included (`--mirr`, `--al`, `--de`);
 * --dry-run and --tags, which only ever let a push through, are read in full.
 * `repo` is --repo's value, where it goes when no repository is named.
 * Given the words `rest` was read from, `expanded` also says whether an
 * option or a refspec could come from an expansion that cannot be read: even
 * after `--`, one could be `+main`.
 */
function pushOptions(rest, words = null) {
  const o = { force: false, lease: false, noVerify: false, dryRun: false, mirror: false, all: false, del: false, tags: false, repo: null, positional: [], expanded: false }
  const values = new Set()
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i]
    if (a === '--') { for (let j = i + 1; j < rest.length; j += 1) o.positional.push(rest[j]); break }
    if (a.startsWith('--')) {
      const flag = a.includes('=') ? a.slice(0, a.indexOf('=')) : a
      const is = (name) => isLong(flag, name)
      if (is('--force')) o.force = true
      if (is('--force-with-lease')) o.lease = true
      if (is('--no-verify')) o.noVerify = true
      if (is('--mirror')) o.mirror = true
      if (is('--all') || is('--branches')) o.all = true
      if (is('--delete')) o.del = true
      if (is('--repo')) o.repo = a.includes('=') ? a.slice(a.indexOf('=') + 1) : rest[i + 1] ?? null
      if (flag === '--dry-run') o.dryRun = true
      else if (flag === '--tags') o.tags = true
      else if (!a.includes('=') && ['--repo', '--receive-pack', '--exec', '--push-option'].includes(flag)) { i += 1; values.add(i) }
      continue
    }
    if (a.startsWith('-') && a.length > 1) {
      for (let k = 1; k < a.length; k += 1) {
        if (a[k] === 'f') o.force = true
        if (a[k] === 'n') o.dryRun = true
        if (a[k] === 'd') o.del = true
        if (a[k] === 'o') { if (k === a.length - 1) { i += 1; values.add(i) } break }
      }
      continue
    }
    o.positional.push(a)
  }
  if (words !== null) o.expanded = words.some((w, k) => mayAddOption(w, values.has(k), /^(--[^=]+=|-[A-Za-z]*o)/))
  return o
}

/** Whether `text` matches `pattern`, in which `*` stands for any run of characters. Linear, never a regex. */
function globMatch(pattern, text) {
  let p = 0
  let t = 0
  let star = -1
  let resume = 0
  while (t < text.length) {
    if (p < pattern.length && pattern[p] === '*') { star = p; resume = t; p += 1 }
    else if (p < pattern.length && pattern[p] === text[t]) { p += 1; t += 1 }
    else if (star >= 0) { p = star + 1; resume += 1; t = resume }
    else return false
  }
  while (pattern[p] === '*') p += 1
  return p === pattern.length
}

/**
 * Whether a refspec pushes every branch it can find rather than one: `:`,
 * which pushes each branch that exists on both sides, or a pattern whose
 * destination can land on one of `names` (`refs/heads/*:refs/heads/*`, `*:*`).
 * `refs/tags/*` and `refs/heads/feat/*` cannot, and are not.
 */
function pushesMany(spec, names) {
  const s = spec.replace(/^\+/, '')
  if (s === ':') return true
  if (!s.includes('*')) return false
  const dst = s.slice(s.indexOf(':') + 1)
  return [...names].some((name) => globMatch(dst, name) || globMatch(dst, `refs/heads/${name}`))
}

const everyBranch = (what) => block(`${what}, main included.`, 'push the one branch you mean: git push -u origin <branch>')

/**
 * Where a refspec lands on the remote, as a branch name, and whether it
 * deletes that branch (`--delete x`, `:x`). git reads heads/x as refs/heads/x
 * (refs/ goes in front of a name it is not given whole), so both are x; once
 * only, so refs/heads/heads/main is the branch heads/main, not main.
 */
function destination(spec, del, current) {
  const s = spec.replace(/^\+/, '')
  const branch = (ref) => (ref ? ref.replace(/^(?:refs\/)?heads\//, '') : null)
  if (del) return { name: branch(s), deletes: true }
  if (s.startsWith(':')) return { name: branch(s.slice(1)), deletes: true }
  const dst = s.includes(':') ? s.slice(s.indexOf(':') + 1) : s === 'HEAD' || s === '@' ? current() : s
  return { name: branch(dst), deletes: false }
}

/** Why committedDelivery() comes out pull-request without having read what the manifest says, which could be trunk. */
const UNREAD = new Set(['too-big', 'missing', 'unread'])

/**
 * One sentence more for a pull-request refusal of a commit or push onto main,
 * when the working tree's manifest says trunk and what is committed at
 * origin/HEAD was read and says otherwise (pull-request, or no manifest at
 * all): the mode is the one at origin/HEAD, so the commit that first switches
 * a repository to trunk is judged by the mode it replaces. Never when it was
 * not read (UNREAD): git out of time, a manifest the clone lacks or one too
 * big to read may say trunk too, and the sentence would blame a commit for
 * what a slow git did. '' otherwise.
 */
function bootstrapNote(dir, g) {
  const committed = committedIn(dir)
  if (committed === null || committed.mode === TRUNK || UNREAD.has(committed.why)) return ''
  const top = git(dir, g, ['rev-parse', '--show-toplevel'], deadline())
  const found = top ? harnessesIn(top) : []
  if (found.length !== 1 || deliveryOf(found[0].manifest) !== TRUNK) return ''
  return ` The working tree's ${found[0].dir}/harness.json says trunk, but the mode comes from the manifest committed at origin/HEAD, so the commit that first lands trunk goes through a branch and a pull request, by hand, or from a session without these hooks.`
}

/**
 * What follows the reason a commit or push onto main is refused:
 * inheritedNote() when the mode it turned on was inherited, then, when that
 * mode is pull-request (`held` null, from landing()), bootstrapNote(). A
 * command that names its repository another way had no mode read, so it
 * gets neither.
 */
function afterRefusal(dir, g, held) {
  if (g.named.length > 0) return ''
  return `${inheritedNote(deliveryIn(dir))}${held === null ? bootstrapNote(dir, g) : ''}`
}

function gitRule(cmd, state) {
  const g = parseGit(cmd.argv.slice(1))
  if (!g.sub) return null
  g.env = repositoryEnv(state)
  g.named = namedElsewhere(g, state)
  // Checked in each directory git may act in: a refusal in any is the answer.
  for (const dir of gitDirsOf(state, g)) {
    const hit = gitRuleIn(cmd, state, g, dir)
    if (hit) return hit
  }
  return null
}

/** gitRule() for one directory git may act in, `dir`; null where it cannot be known. */
function gitRuleIn(cmd, state, g, dir) {
  const off = hooksOff(g, state)
  const r = g.rest
  // The words after `git`, which say what came from an expansion; those of the subcommand's arguments.
  const words = cmd.words.slice(1)
  const restWords = words.slice(g.subAt + 1)
  // A repository named another way that git cannot read: no branch, remote default or mode can be read there.
  const lost = () => g.named.length > 0 && !readable(dir, g)

  if (g.sub === 'commit') {
    const o = commitOptions(r, restWords)
    if (o.noVerify) return NO_VERIFY
    if (off) return off
    if (o.dryRun) return null
    if (lost()) return unreadable('commit', g.named)
    if (dir === null) return null
    const b = branchAt(dir, g, state)
    if (!b || b.unborn || !protectedNames(dir, g).has(b.name)) return null
    const held = landing(g, state, dir, words, o.expanded)
    if (held === undefined) return null
    return commitOnMain(b.name, held, afterRefusal(dir, g, held))
  }

  if (g.sub === 'push') {
    const o = pushOptions(r, restWords)
    if (o.dryRun) return null
    // Refused whatever the mode, so decided before it is read: nothing about a manifest can hold these up.
    if (o.noVerify) return NO_VERIFY
    if (off) return off
    if (o.mirror || o.all) return everyBranch(`git push ${o.mirror ? '--mirror' : '--all'} pushes every branch`)
    const specs = o.positional.slice(1)
    let mode = null
    const trunk = () => {
      mode ??= g.named.length > 0 ? PULL_REQUEST : deliveryMode(dir)
      return mode === TRUNK
    }
    // Trunk's refusal names the mode, so it says where an inherited one came from.
    const forced = () => explained(FORCE_IN_TRUNK, deliveryIn(dir))
    // Refused either way; the mode only decides which way round to put it.
    if (o.force || specs.some((s) => s.startsWith('+'))) return trunk() ? forced() : FORCE
    const names = protectedNames(dir, g)
    const many = specs.find((s) => pushesMany(s, names))
    if (many !== undefined) {
      return everyBranch(many === ':' ? 'the refspec ":" pushes every branch that exists on both sides'
        : `the refspec "${many}" pushes every branch it matches`)
    }
    const current = () => (dir === null ? null : branchAt(dir, g, state)?.name ?? null)
    const dests = specs.map((spec) => destination(spec, o.del, current))
    const deleted = dests.find((to) => to.deletes && to.name && names.has(to.name))
    if (deleted) return deleteMain(deleted.name)
    if (lost()) return unreadable('push', g.named)

    // From here on, what is refused turns on the mode.
    if (o.lease && trunk()) return forced()
    // Where it goes: the repository it names, else --repo's, else the current branch's push remote.
    const remote = () => o.positional[0] ?? o.repo ?? pushRemote(dir, g, current())
    let asked = false
    let held
    const lands = () => {
      if (!asked) { held = landing(g, state, dir, words, o.expanded, remote); asked = true }
      return held
    }
    const refused = (name) => pushToMain(name, lands(), afterRefusal(dir, g, lands()))
    for (const to of dests) {
      if (to.deletes || !to.name || !names.has(to.name)) continue
      if (lands() !== undefined) return refused(to.name)
    }
    if (specs.length === 0 && !o.tags && dir !== null) {
      let target
      if (g.named.length === 0 && Object.hasOwn(state.vbranch, dir)) {
        target = state.vbranch[dir] || null
      } else {
        const push = git(dir, g, ['rev-parse', '--symbolic-full-name', '@{push}'])
        target = push ? push.replace(/^refs\/remotes\/[^/]+\//, '') : current()
      }
      if (target && names.has(target) && lands() !== undefined) return refused(target)
    }
    return null
  }

  if (['merge', 'pull', 'rebase', 'am', 'cherry-pick', 'revert'].includes(g.sub)) {
    return noVerifyIn(r) ? NO_VERIFY : off
  }
  if (['symbolic-ref', 'update-ref', 'remote', 'replace'].includes(g.sub)) {
    const hit = refRewritten(g, restWords, cmd.heredoc)
    if (hit === null) return null
    return hit.replace ? replaceRef(hit.what) : remoteRef(hit.what, hit.expanded)
  }
  if (g.sub === 'reset') return r.includes('--hard') ? RESET_HARD : null
  if (g.sub === 'clean') {
    const short = r.filter((a) => /^-[A-Za-z]+$/.test(a)).join('')
    const force = r.includes('--force') || short.includes('f')
    const dry = r.includes('--dry-run') || short.includes('n')
    return force && !dry ? CLEAN : null
  }
  if (g.sub === 'add') {
    const end = r.indexOf('--')
    const options = end < 0 ? r : r.slice(0, end)
    const all = options.some((a) => a === '--all' || a === '--no-ignore-removal' || (/^-[A-Za-z]+$/.test(a) && a.includes('A')))
    const everything = r.some((a) => ['.', './', ':/', ':', '*', ':/*'].includes(a))
    return all || everything ? ADD_ALL : null
  }
  return null
}

function rmRule(cmd) {
  let recursive = false
  let force = false
  for (const a of cmd.argv.slice(1)) {
    if (a === '--') break
    if (a === '--recursive') recursive = true
    else if (a === '--force') force = true
    else if (/^-[A-Za-z]+$/.test(a)) {
      if (/[rR]/.test(a)) recursive = true
      if (a.includes('f')) force = true
    }
  }
  return recursive && force ? RM_RF : null
}

/** The rules every repository gets. A workspace can add its own beside them. */
export function rules(cmd, state) {
  if (cmd.name === 'rm') return rmRule(cmd)
  if (cmd.name === 'git') return gitRule(cmd, state)
  return null
}

/* ── the hook ───────────────────────────────────────────────────────────── */

/** The first block for a PreToolUse input, or null. */
export function decide(input, check = rules) {
  const command = input?.tool_input?.command
  if (typeof command !== 'string' || command.trim() === '') return null
  if (command.length > MAX_INPUT) return TOO_COMPLEX
  const cwd = typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : process.cwd()
  return walk(command, { cwd, vbranch: {} }, check)
}

/**
 * All of stdin, in chunks, until EOF.
 *
 * `readFileSync(0)` throws EAGAIN when stdin is a non-blocking pipe the writer
 * has not finished filling, which is what a command longer than the pipe's
 * buffer looks like (from about 72 KB). The guard then allowed a command it
 * had never read. So this reads what is there, waits a moment when nothing
 * is, and stops at EOF. A writer that stays silent for IDLE_MS without closing
 * is an error, and an error fails open like any other.
 */
const IDLE_MS = 5000
export function readStdin(fd = 0) {
  const chunks = []
  const chunk = Buffer.alloc(1 << 16)
  const nap = new Int32Array(new SharedArrayBuffer(4))
  let heard = Date.now()
  for (;;) {
    let n
    try {
      n = readSync(fd, chunk, 0, chunk.length, null)
    } catch (error) {
      if (error?.code === 'EOF') break
      if (error?.code !== 'EAGAIN') throw error
      if (Date.now() - heard > IDLE_MS) throw new Error(`stdin stayed open and silent for ${IDLE_MS} ms`, { cause: error })
      Atomics.wait(nap, 0, 0, 2)
      continue
    }
    if (n === 0) break
    chunks.push(Buffer.from(chunk.subarray(0, n)))
    heard = Date.now()
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Read stdin, decide, and exit 2 with the reason on a block; exit 0 otherwise. */
export function runGuard(check = rules, by = '.claude/hooks/guard.mjs') {
  let hit = null
  try {
    hit = decide(JSON.parse(readStdin()), check)
  } catch (error) {
    // Fail open: a guard that crashes must not become a guard that blocks.
    process.stderr.write(`${by}: allowed without checking (${error instanceof Error ? error.message : error})\n`)
  }
  if (hit) {
    process.stderr.write(`Blocked by ${by}: ${hit.what}\nInstead: ${hit.instead}\n`)
    process.exitCode = 2
  }
}

const invokedDirectly = () => {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    // Imported from somewhere without a script path: not the entry point.
    return false
  }
}

if (invokedDirectly()) runGuard()
