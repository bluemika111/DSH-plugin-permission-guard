'use strict'

/**
 * dsh-plugin-permission-guard — a tool-layer fence for the ONE dimension the harness kernel does not
 * have: whether the model may read outside the session workspace.
 *
 * WHAT THIS PLUGIN DOES NOT DO, AND WHY THAT IS THE POINT
 *
 * It does NOT fence writes. The harness's own sandbox already confines them per session, and an
 * earlier version kept a second, four-valued opinion about them — which required keeping that opinion
 * in step with the kernel in both directions. That sync layer was the source of nearly every bug this
 * plugin has had: a state mapped to the wrong kernel value, a session-creation pin silently
 * overwriting an operator's choice, and a reverse direction that fired from only one of its three
 * possible triggers. All of it existed to answer a question the kernel already answers.
 *
 * So the model here is a single boolean, and this plugin never speaks to the kernel.
 *
 * THE COST, STATED PLAINLY: because it no longer sets kernel state, it cannot guarantee the kernel is
 * no stricter than it is. If the operator selects a permissive built-in preset, outside WRITES are
 * allowed and this plugin will not stop them. Writes are the operator's business through the harness's
 * own control, by design.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const modes = require('./modes.js')

/**
 * The state file, kept BESIDE THE PLUGIN rather than in the session workspace.
 *
 * `__dirname` rather than a literal path, so the same code works whether the plugin is being developed
 * inside a workspace or installed under the harness home. Under `${DSH_HOME}` a sibling control-plane
 * guard covers it too; the fence below is what stops the MODEL from flipping its own switch.
 *
 * `DSH_PERMISSION_GUARD_STATE_FILE` relocates it. That exists for TEST ISOLATION, and the need is
 * concrete: this directory is the live install, so the suite's writes used to land on the OPERATOR'S
 * REAL SETTING. The suite writes `false` and `true`, DELETES the file to test the missing case, and
 * renames it to test the handover — so a Ctrl-C or a crash partway through would leave live permissions
 * changed, or the file gone, which silently means "outside not readable". A test that can rewrite the
 * setting it is testing must not run against the real one.
 */
const STATE_FILE = (typeof process.env.DSH_PERMISSION_GUARD_STATE_FILE === 'string'
  && process.env.DSH_PERMISSION_GUARD_STATE_FILE !== '')
  ? path.resolve(process.env.DSH_PERMISSION_GUARD_STATE_FILE)
  : path.join(__dirname, 'permissions.json')

/**
 * Every file name this state file has ever had, for the self-escalation fence and the rename handover.
 *
 * The fence matches on the BASENAME because a path list is what drifts, and a rename must leave the
 * old name fenced too — otherwise the rename opens the hole the handover exists to close.
 */
const STATE_FILE_BASENAMES = ['permissions.json', '权限设置.json']

/** The field the state file stores, named so its meaning cannot be misread across versions. */
const STATE_FIELD = 'outsideRead'

const stats = { denied: 0, allows: 0, shellPathsChecked: 0, shellPathsAllowed: 0, selfFlipBlocks: 0 }
const audit = []

/** Set once the monotonic guard is registered: without it the tool must refuse to change anything. */
let guardArmed = false

/** How many times the tool narrowed the setting. Widening is refused, so this is the only direction. */
let narrowingsByTool = 0

// ---------------------------------------------------------------- path helpers

function normalizePath(value) {
  return String(value).replace(/\\/g, '/').replace(/\/+$/, '')
}

/** The workspace used only when a tool execution carries no session cwd. */
function fallbackWorkspace() {
  const override = process.env.DSH_PERMISSION_GUARD_WORKSPACE
  if (typeof override === 'string' && override !== '') return normalizePath(override)
  try {
    return normalizePath(os.homedir())
  } catch (error) {
    return normalizePath(path.parse(process.cwd()).root || process.cwd())
  }
}

/**
 * The workspace this call is judged against.
 *
 * `exec.agent.session.header.cwd` is the session's real workspace and is exact. The fallback exists
 * only for an execution carrying no session, and it is deliberately a location that cannot be a
 * workspace (the home directory) so a fallback misclassification DENIES rather than permits. It used
 * to be `process.cwd()`, which on DSH Desktop is the application install directory — observed in the
 * field, and it would have classified the operator's real workspace as outside.
 */
function resolveWorkspace(exec) {
  try {
    const cwd = exec && exec.agent && exec.agent.session && exec.agent.session.header
      ? exec.agent.session.header.cwd
      : undefined
    if (typeof cwd === 'string' && cwd !== '') return normalizePath(cwd)
  } catch (error) { /* fall through */ }
  return fallbackWorkspace()
}

function resolveCandidate(candidate, workspace) {
  const text = String(candidate)
  if (path.isAbsolute(text)) return normalizePath(text)
  return normalizePath(path.resolve(workspace, text))
}

function isUnder(target, root) {
  if (root === '') return false
  const t = target.toLowerCase()
  const r = root.toLowerCase()
  return t === r || t.startsWith(r + '/')
}

// ------------------------------------------------------------------ state

/**
 * Interpret a parsed state file, or undefined when it holds no recognisable state.
 *
 * MIGRATION FROM THE FOUR-MODE FILES. Earlier versions stored `mode: 1..4` across two axes; the old
 * meaning of the outside-read dimension is `mode >= 3`, written out rather than inferred because
 * getting it backwards would GRANT outside reads on upgrade:
 *
 *     old 1 "Workspace read"    outside not readable -> false
 *     old 2 "Workspace write"   outside not readable -> false
 *     old 3 "Outside readable"  outside readable     -> true
 *     old 4 "Full access"       outside readable     -> true
 */
function interpret(parsed) {
  if (parsed === null || typeof parsed !== 'object') return undefined
  if (typeof parsed[STATE_FIELD] === 'boolean') return { outsideRead: parsed[STATE_FIELD] }
  if (typeof parsed.mode === 'number') return { outsideRead: parsed.mode >= 3, legacyMode: parsed.mode }
  return undefined
}

/**
 * Adopt a state file left under a former name in the SAME directory.
 *
 * The one handover that survives the removal of all fallbacks, bounded in a way the removed ones were
 * not: it reads a sibling of the state file rather than another directory, runs only when the current
 * name is absent, PRESERVES the operator's setting instead of guessing one, and deletes the old file so
 * it cannot fire twice.
 */
function adoptRenamedStateFile() {
  for (let i = 0; i < STATE_FILE_BASENAMES.length; i++) {
    const name = STATE_FILE_BASENAMES[i]
    if (name === path.basename(STATE_FILE)) continue
    const candidate = path.join(path.dirname(STATE_FILE), name)
    try {
      const adopted = interpret(JSON.parse(fs.readFileSync(candidate, 'utf8')))
      if (adopted === undefined) continue
      persistState(adopted)
      try {
        fs.unlinkSync(candidate)
      } catch (error) {
        console.error('[permission-guard] adopted the former state file but could not remove it:', candidate, String(error))
      }
      console.log('[permission-guard] adopted state file', candidate, '->', STATE_FILE)
      return adopted
    } catch (error) { /* absent or malformed: try the next former name */ }
  }
  return undefined
}

/**
 * The effective state, read on every check (no cache: a stale permission decision is worse than a few
 * hundred bytes per tool call). Order: the current file, then a renamed sibling, then the restrictive
 * default — so a missing or broken file can only ever DENY outside reads, never allow them.
 */
function currentState() {
  try {
    const parsed = interpret(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')))
    if (parsed !== undefined) {
      if (parsed.legacyMode !== undefined) {
        console.log('[permission-guard] migrated legacy mode', parsed.legacyMode, '-> outsideRead', parsed.outsideRead)
        try { persistState(parsed) } catch (error) { /* re-migrated next call */ }
      }
      return { outsideRead: parsed.outsideRead }
    }
  } catch (error) { /* absent or malformed: try the handover */ }
  const adopted = adoptRenamedStateFile()
  if (adopted !== undefined) return { outsideRead: adopted.outsideRead }
  return { outsideRead: modes.DEFAULT_OUTSIDE_READ }
}

/**
 * Write the state file.
 *
 * THE GUARD IS THE POINT. `JSON.stringify` DROPS an `undefined` value, so a caller that passed a state
 * object without `outsideRead` produced a file containing only the note — a state file that no longer
 * states anything. The behaviour stayed safe (an unrecognised file falls back to the restrictive
 * default) which is exactly why it went unnoticed: the setting silently became "not what the file
 * said", and nothing anywhere reported it.
 *
 * Refusing here turns a silent corruption into a loud one, and the thrown message names the offending
 * value, so the next occurrence identifies its own caller instead of needing to be deduced.
 */
function persistState(state) {
  if (state === null || typeof state !== 'object' || typeof state.outsideRead !== 'boolean') {
    throw new TypeError('[permission-guard] refusing to write a state file without a boolean '
      + STATE_FIELD + '; received ' + JSON.stringify(state))
  }
  const payload = {
    [STATE_FIELD]: state.outsideRead,
    note: 'Read and written by the permission-guard plugin. This is the only setting it stores:'
      + ' whether the model may READ outside the workspace. Writes are confined by the harness sandbox.',
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2) + '\n', 'utf8')
}

function stateName(state) {
  const found = modes.stateByValue(state.outsideRead)
  return found === undefined ? 'unknown' : found.name
}

// ------------------------------------------------------------------ decisions

function record(entry) {
  audit.push(entry)
  if (audit.length > 200) audit.splice(0, audit.length - 200)
  console.log('[permission-guard] DENY', entry.tool, entry.reason)
}

function allow() {
  stats.allows += 1
  return null
}

/**
 * Deny access to a path outside the workspace while outside reads are disabled.
 *
 * THE WORDING NAMES THE SETTING, NOT THE OPERATION, on purpose: `fenceShell` also refuses commands
 * that only write outside (see there for why), so a message saying "read denied" would be wrong for
 * those.
 */
function denyOutside(tool, target, state) {
  stats.denied += 1
  const reason = 'Permission guard: ' + target + ' is outside the session workspace, and outside access is'
    + ' currently disabled (outsideRead: ' + String(state.outsideRead) + '). The model cannot change'
    + ' this setting itself. Ask the human to enable "Outside readable".'
  record({
    at: new Date().toISOString(),
    tool: tool,
    scope: 'outside the workspace',
    path: target,
    outsideRead: state.outsideRead,
    reason: reason,
  })
  void tool
  return { kind: 'deny', reason: reason }
}

/**
 * The read policy: everything inside the workspace is readable; everything outside it follows the one
 * setting. Writes are not judged here at all.
 */
function decideRead(tool, target, state, exec) {
  if (state.outsideRead) return allow()
  if (isUnder(target, resolveWorkspace(exec))) return allow()
  return denyOutside(tool, target, state)
}

// -------------------------------------------------------------------- fencing

/**
 * Split a shell command into tokens that look like filesystem paths.
 *
 * Best-effort by design: it catches the plain forms an agent writes (`cat D:\x`, `Get-Content ../y`)
 * and explicitly does not attempt to defeat deliberate obfuscation.
 */
function extractShellPaths(command) {
  const found = []
  const text = String(command)

  // Quoted spans first: a quoted path containing spaces must stay one token. Then REMOVE those spans
  // before the bare-token pass, or the same path is re-split on whitespace and each fragment is judged
  // separately — that bug resolved a fragment like `D:\DeepSeek` and denied a legitimate read.
  const quoted = /"[^"]*"|'[^']*'|`[^`]*`/g
  const spans = []
  let q
  while ((q = quoted.exec(text)) !== null) {
    const raw = q[0]
    const inner = raw.slice(1, -1)
    spans.push(raw)
    if (looksLikePath(inner)) found.push(inner)
  }
  let remaining = text
  for (let i = 0; i < spans.length; i++) remaining = remaining.split(spans[i]).join(' ')

  const bare = remaining.split(/\s+/)
  for (let i = 0; i < bare.length; i++) {
    const token = bare[i].replace(/^[("'`]+/, '').replace(/[)"'`,;]+$/, '')
    if (token === '' || token.length > 500) continue
    if (looksLikePath(token)) found.push(token)
  }
  return found
}

/**
 * Whether one shell token is a filesystem path.
 *
 * Strict about the bare-relative form on purpose: an earlier draft accepted any `word/word` token,
 * which classified the COMMAND NAME `Get-Content` as a path and denied legitimate reads.
 */
function looksLikePath(token) {
  if (typeof token !== 'string') return false
  const t = token.trim()
  if (t.length < 3) return false
  if (/^[A-Za-z]:[\\/]/.test(t)) return true                // C:\x or C:/x
  if (/^\\\\[^\\]/.test(t)) return true                     // UNC \\server\share
  if (t.startsWith('/') && !t.startsWith('//')) return true // POSIX absolute
  if (/^\.\.?[\\/]/.test(t)) return true                    // ./x or ../x
  return false
}

/**
 * Shell WRITE verbs, by cmdlet and by script API.
 *
 * Script APIs are included because a cmdlet-only list was a real hole: the state file was once moved
 * with `node -e "fs.renameSync(...)"`, which matched nothing and therefore ran unchecked.
 */
const SHELL_WRITE_VERBS = /\b(?:set-content|add-content|out-file|new-item|remove-item|move-item|copy-item|rename-item|mkdir|touch|rm|mv|cp|del|rd|md|tee|writeFileSync?|renameSync?|unlinkSync?|rmdirSync?|rmSync|mkdirSync?|copyFileSync?|cpSync|truncateSync?|appendFileSync?|createWriteStream|write_text|makedirs|rmtree|shutil\.(?:move|copy2?|copytree|rmtree)|os\.(?:rename|remove|unlink|rmdir|makedirs|mkdir)|\[IO\.File\]|\[System\.IO\.File\])\b/i

/** Does a MUTATING shell command name the state file anywhere in its text? */
function commandMentionsStateFile(command) {
  const slashed = String(command).replace(/\\/g, '/').toLowerCase()
  if (slashed.indexOf(normalizePath(STATE_FILE).toLowerCase()) !== -1) return true
  for (let i = 0; i < STATE_FILE_BASENAMES.length; i++) {
    const name = String(STATE_FILE_BASENAMES[i]).toLowerCase()
    if (name.length >= 3 && slashed.indexOf(name) !== -1) return true
  }
  return false
}

/**
 * Whether a path names a state file — the LIVE one by exact path, or any of its former names anywhere.
 *
 * The exact-path check is not redundant. The live file can be relocated and therefore not carry a
 * fenced name, and a fence that only recognised the historical basenames would then let the model write
 * the very file holding its own switch. The basename checks stay as well, so a rename or a stray copy
 * under an old name remains fenced.
 */
function isStateFile(target) {
  const normalized = normalizePath(target).toLowerCase()
  if (normalized === normalizePath(STATE_FILE).toLowerCase()) return true
  const base = normalized.split('/').pop()
  if (base === '') return false
  for (let i = 0; i < STATE_FILE_BASENAMES.length; i++) {
    const name = String(STATE_FILE_BASENAMES[i]).toLowerCase()
    if (name.length < 3) continue
    if (base === name) return true
  }
  return false
}

/**
 * Deny a MUTATING tool call whose target is the state file.
 *
 * Without this the plugin is self-defeating: the file holds the switch, so a model that could write it
 * would grant itself outside reads. The human is unaffected — an editor does not pass through the tool
 * seam.
 *
 * Reads are deliberately NOT fenced: knowing the current setting is not a capability.
 */
function fenceSelfWrite(exec, args) {
  const name = String(exec && exec.name ? exec.name : '')
  const targets = []

  const fields = (name === 'write' || name === 'edit')
    ? ['file_path']
    : (name === modes.STR_REPLACE_TOOL ? ['path'] : undefined)

  if (fields !== undefined) {
    for (let i = 0; i < fields.length; i++) {
      const value = args[fields[i]]
      if (typeof value === 'string' && value !== '') targets.push(value)
    }
  } else if (modes.SHELL_TOOLS.has(name)) {
    const command = typeof args.command === 'string' ? args.command : ''
    if (SHELL_WRITE_VERBS.test(command)) {
      // The raw-text signal is checked IN ADDITION to extracted paths: extraction misses a path buried
      // inside a script string, which is exactly how the original state-file move slipped past.
      if (commandMentionsStateFile(command)) targets.push(STATE_FILE)
      const extracted = extractShellPaths(command)
      for (let i = 0; i < extracted.length; i++) targets.push(extracted[i])
    }
  } else {
    return null
  }

  for (let i = 0; i < targets.length; i++) {
    const resolved = resolveCandidate(targets[i], resolveWorkspace(exec))
    if (!isStateFile(resolved)) continue
    stats.selfFlipBlocks += 1
    audit.push({
      at: new Date().toISOString(),
      tool: name,
      reason: 'self-escalation guard: attempted to modify the permission state file',
      path: resolved,
      outsideRead: currentState().outsideRead,
    })
    if (audit.length > 200) audit.splice(0, audit.length - 200)
    console.log('[permission-guard] DENY self-flip', name, resolved)
    return {
      kind: 'deny',
      reason: 'The DSH permission guard denied this call (self-escalation guard): the target is the'
        + ' permission state file itself (' + resolved + '). The model cannot change whether it may read'
        + ' outside the workspace — that is the CVE-2026-82533 shape. Ask the human to edit that file or'
        + ' to use the switch.',
    }
  }
  return null
}

/**
 * Shell commands, judged for the paths they name.
 *
 * OVER-BLOCKING IS DELIBERATE. Any command naming a path outside the workspace is refused while
 * outside reads are disabled, including one that only writes there. Two reasons:
 *
 *   1. Telling read positions from write positions in arbitrary shell text is not possible reliably,
 *      and getting it wrong leaves a trivial bypass: `Get-Content C:\secret > out.txt` writes INSIDE
 *      the workspace, which the kernel permits, while reading outside it — so a rule that skipped every
 *      command containing a write verb would fence nothing that matters.
 *   2. A refusal here is recoverable and visible; the alternative failure is a silent read of anything
 *      on the machine.
 *
 * The only cost is that an outside WRITE is refused earlier than the kernel would refuse it, and the
 * message names the setting rather than the operation so it stays accurate for both.
 */
function fenceShell(exec, args, state) {
  if (state.outsideRead) return allow()
  const command = typeof args.command === 'string' ? args.command : ''
  const candidates = extractShellPaths(command)
  for (let i = 0; i < candidates.length; i++) {
    const target = resolveCandidate(candidates[i], resolveWorkspace(exec))
    stats.shellPathsChecked += 1
    const decision = decideRead(exec.name, target, state, exec)
    if (decision !== null) {
      return { kind: 'deny', reason: decision.reason + ' (matched path "' + candidates[i] + '" in the shell command)' }
    }
    stats.shellPathsAllowed += 1
  }
  return null
}

/**
 * Inspect one pending tool call. Returns a deny decision or null.
 *
 * Fails OPEN on an internal error so a bug here cannot wedge every tool call, but logs loudly, because
 * a silent open failure would look identical to a pass.
 */
function inspect(exec) {
  try {
    const name = String(exec && exec.name ? exec.name : '')
    const args = exec && exec.arguments !== null && typeof exec.arguments === 'object' ? exec.arguments : {}
    const state = currentState()

    // Checked first and for every tool, so no tool can reach around it.
    const selfWrite = fenceSelfWrite(exec, args)
    if (selfWrite !== null) return selfWrite

    // READS only. A write is the harness sandbox's business and is not judged here.
    if (modes.PATH_READ_TOOLS.has(name)) {
      return decideRead(name, resolveCandidate(args.file_path, resolveWorkspace(exec)), state, exec)
    }
    if (modes.TREE_READ_TOOLS.has(name)) {
      const scopePath = typeof args.path === 'string' && args.path.trim() !== '' ? args.path : '.'
      return decideRead(name, resolveCandidate(scopePath, resolveWorkspace(exec)), state, exec)
    }
    if (modes.SHELL_TOOLS.has(name)) return fenceShell(exec, args, state)
    return null
  } catch (error) {
    console.error('[permission-guard] inspection failed, allowing call:', String(error))
    return null
  }
}

// ------------------------------------------------------------------- reporting

/** The workspace the requesting session is judged against, or null when it cannot be known. */
function sessionWorkspace(context) {
  const sources = [context && context.agent, context && context.scope]
  for (let i = 0; i < sources.length; i++) {
    const holder = sources[i]
    try {
      const cwd = holder && holder.session && holder.session.header ? holder.session.header.cwd : undefined
      if (typeof cwd === 'string' && cwd !== '') return normalizePath(cwd)
    } catch (error) { /* try the next source */ }
  }
  return null
}

/**
 * The per-turn boundary text.
 *
 * It states the ONE thing this plugin decides and says explicitly that writes are not its business, so
 * a model denied an outside read does not conclude that an outside write is permitted by the same rule.
 * An unresolvable workspace is STATED, never guessed: a confidently wrong path is worse than a stated
 * unknown, because the model acts on it.
 */
function boundaryText(state, context) {
  const workspace = sessionWorkspace(context)
  const workspaceText = workspace === null
    ? '(not resolvable this turn; the fence uses the session\'s own cwd)'
    : workspace
  const outside = state.outsideRead ? 'READABLE' : 'NOT readable'
  return '[permission-guard] Session workspace = ' + workspaceText + '.'
    + ' Reading outside the workspace is ' + outside + '.'
    + ' This plugin decides ONLY that; writes are confined by the harness sandbox, not by this plugin.'
    + ' The model cannot change the setting; ask the human to switch it.'
}

function statusReport(context) {
  const state = currentState()
  const workspace = sessionWorkspace(context)
  return {
    plugin: 'permission-guard',
    scope: 'outside-read policy only; writes are the harness sandbox\'s business',
    enforcement: 'tool layer (not a kernel boundary)',
    stateFile: STATE_FILE,
    state: { outsideRead: state.outsideRead, name: stateName(state) },
    availableStates: modes.STATES.map(function (s) {
      return { outsideRead: s.outsideRead, name: s.name, nameZh: s.nameZh, summary: s.summary }
    }),
    workspace: workspace,
    workspaceSource: workspace === null ? 'unresolved (no requesting agent in this call)' : 'requesting agent session header cwd',
    fallbackWorkspace: fallbackWorkspace(),
    fallbackWorkspaceSource: typeof process.env.DSH_PERMISSION_GUARD_WORKSPACE === 'string' && process.env.DSH_PERMISSION_GUARD_WORKSPACE !== ''
      ? 'DSH_PERMISSION_GUARD_WORKSPACE'
      : 'os.homedir()',
    capabilities: {
      toolsGuard: guardArmed,
      changeControl: guardArmed
        ? 'active (the model cannot enable outside reads through this tool)'
        : 'INACTIVE — this DSH build does not expose tools.guard, so changes are refused entirely',
    },
    counters: {
      denials: stats.denied,
      passes: stats.allows,
      shellPathsChecked: stats.shellPathsChecked,
      shellPathsAllowed: stats.shellPathsAllowed,
      selfFlipBlocks: stats.selfFlipBlocks,
    },
    narrowingsByTool: narrowingsByTool,
    limits: [
      'shell commands are judged by path heuristic only; deliberately obfuscated pwsh can evade the read restriction',
      'any shell command naming an outside path is refused while outside reads are off, including one that only writes there',
      'writes are NOT fenced by this plugin: the harness sandbox owns them, so a permissive built-in preset allows outside writes',
      'the setting is process-global, not per-session',
    ],
    recentDenials: audit.slice(-5),
  }
}

// --------------------------------------------------------------------- plugin

/** The state a request asks for, or undefined when the request does not name a known state. */
function requestedState(args) {
  if (args === undefined || args === null) return undefined
  if (typeof args.outsideRead === 'boolean') return modes.stateByValue(args.outsideRead)
  return undefined
}

const plugin = {
  name: 'permission-guard',
  apply(ctx) {
    // Seed the state file on first load so the current setting is visible on disk.
    try {
      if (!fs.existsSync(STATE_FILE)) persistState(currentState())
    } catch (error) {
      console.error('[permission-guard] could not seed the state file:', String(error))
    }

    ctx.on('tools/pre-execute', function (exec, next) {
      const decision = inspect(exec)
      if (decision !== null) return decision
      return next()
    })

    // Tell the model the boundary it is judged against, so it need not discover it by being denied. The
    // assembly context MUST be forwarded: it carries the requesting agent, which is the only way to know
    // WHICH workspace this turn is judged against.
    ctx.inject(['systemPrompt'], function (promptCtx) {
      promptCtx.systemPrompt.section({
        name: 'permission-guard:boundaries',
        order: 0,
        text: function (context) {
          return boundaryText(currentState(), context)
        },
      })
    })

    ctx.inject(['tools'], function (toolsCtx) {
      // The monotonic seam. Enabling outside reads is an escalation and is refused; disabling is
      // allowed, because giving up access is not one.
      if (typeof toolsCtx.tools.guard === 'function') {
        guardArmed = true
        toolsCtx.tools.guard(function (execution) {
          try {
            if (String(execution && execution.name) !== 'permission_mode') return undefined
            const next = requestedState(execution && execution.arguments)
            if (next === undefined) return undefined
            const current = currentState()
            if (next.outsideRead === current.outsideRead) return undefined
            if (!next.outsideRead) return undefined // narrowing: allowed
            stats.selfFlipBlocks += 1
            audit.push({
              at: new Date().toISOString(),
              tool: 'permission_mode',
              reason: 'self-escalation guard: the model attempted to enable outside reads',
              from: current.outsideRead,
              to: next.outsideRead,
            })
            if (audit.length > 200) audit.splice(0, audit.length - 200)
            console.log('[permission-guard] DENY self-flip via tool', current.outsideRead, '->', next.outsideRead)
            return 'The DSH permission guard refused this change: enabling outside reads extends the model\'s'
              + ' own file access, and the model cannot raise its own permissions — that is the'
              + ' CVE-2026-82533 shape. Ask the human to switch it, or to edit ' + STATE_FILE + '.'
          } catch (error) {
            // FAIL CLOSED, unlike the file fence: the recoverable outcome is a refused change.
            console.error('[permission-guard] state-switch guard failed, refusing the change:', String(error))
            return 'The DSH permission guard could not evaluate this change, so it refused it (fail-closed).'
          }
        })
      } else {
        console.error('[permission-guard] tools.guard is unavailable on this DSH build, so the'
          + ' permission_mode tool is REPORT-ONLY: changes are refused, because allowing them would let the'
          + ' model raise its own permissions. The read fence itself is unaffected.')
      }

      toolsCtx.tools.register({
        name: 'permission_mode',
        description: 'Report or change whether the model may READ outside the session workspace. Writes are'
          + ' not covered by this plugin; the harness sandbox confines them. Reports when called without'
          + ' arguments; enabling outside reads is refused',
        parameters: {
          type: 'object',
          properties: {
            outsideRead: {
              type: 'boolean',
              description: 'true enables reading outside the workspace, false disables it. Enabling is'
                + ' REFUSED by the self-escalation guard; disabling is allowed. Omit to report.',
            },
          },
          required: [],
        },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: function (args, value) {
            return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
          },
        },
        isConcurrencySafe: function () { return true },
        execute: function (args, exec) {
          const next = requestedState(args)
          if (next === undefined) return statusReport(exec)
          const current = currentState()
          if (next.outsideRead === current.outsideRead) {
            return {
              action: 'set', ok: true, changed: false,
              state: { outsideRead: current.outsideRead },
              boundary: boundaryText(current, exec),
            }
          }
          if (!guardArmed) {
            return {
              action: 'set',
              ok: false,
              refused: true,
              reason: 'Changing this setting through the tool is disabled because this DSH build does not'
                + ' expose tools.guard, the monotonic seam that prevents a tool call from widening the'
                + ' model\'s own access. Ask the human to change it.',
              stateFile: STATE_FILE,
            }
          }
          persistState(next)
          narrowingsByTool += 1
          return {
            action: 'set', ok: true, changed: true,
            state: { outsideRead: next.outsideRead, name: next.name },
            boundary: boundaryText(next, exec),
          }
        },
      })
    })

    // A READ-ONLY route for the client half.
    //
    // There is deliberately NO write route. HTTP never passes through `tools/pre-execute`, so a write
    // route would be reachable by the model's own shell and would hand it the very switch this plugin
    // refuses to let it flip — the fence above exists for that reason, and a write route would route
    // around it. How the UI switch writes is a separate, still-open question.
    //
    // The payload carries the state and NOTHING about where the process runs: a status surface must not
    // double as a filesystem probe.
    ctx.inject(['webServer'], function (webCtx) {
      webCtx.webServer.register({
        kind: 'exact',
        path: '/permission-guard/state',
        handler: function (req, res) {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.statusCode = 405
            res.setHeader('content-type', 'application/json; charset=utf-8')
            res.end('{"error":"method not allowed"}')
            return
          }
          const state = currentState()
          res.statusCode = 200
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.end(JSON.stringify({ outsideRead: state.outsideRead, name: stateName(state) }))
        },
      })
      console.log('[permission-guard] state route registered at /permission-guard/state')
    })

    console.log('[permission-guard] active; state file =', STATE_FILE, '; outsideRead =', currentState().outsideRead)
  },
}

module.exports = plugin
module.exports.default = plugin
module.exports.apply = plugin.apply
