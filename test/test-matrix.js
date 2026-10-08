'use strict'

/**
 * The policy matrix: what this plugin allows and refuses, at the tool layer.
 *
 * WHAT THIS SUITE IS FOR. The plugin decides exactly ONE thing — may the model read outside the session
 * workspace — and protects exactly one path, its own state file. Every assertion below is one of those
 * two claims, plus the ways the state itself can be misread (migration, a renamed file, a broken file).
 *
 * Run: node test/test-matrix.js
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const ROOT = path.join(__dirname, '..')

const WORKSPACE = 'D:/project'
const OUTSIDE = 'D:/elsewhere/secret.txt'

let failures = 0
function check(label, ok, detail) {
  if (!ok) failures += 1
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + (detail ? ' | ' + detail : ''))
}

// -------------------------------------------------------------- fake host

let listener = null
let registeredTool = null
let registeredGuard = null
let registeredRoute = null
let promptSection = null
let registeredCommand = null

function makeCtx(options) {
  const opts = options || {}
  const svc = {
    systemPrompt: { section: function (definition) { promptSection = definition } },
    tools: {
      register: function (tool) { registeredTool = tool },
      guard: opts.noGuard === true ? undefined : function (fn) { registeredGuard = fn; return function () {} },
    },
    webServer: { register: function (route) { registeredRoute = route; return function () {} } },
    commands: opts.noCommands === true
      ? undefined
      : { register: function (def) { registeredCommand = def; return function () {} } },
  }
  function get(name) { return svc[name] }
  const ctx = {
    on: function (name, fn) { if (name === 'tools/pre-execute') listener = fn; return function () {} },
    inject: function (deps, cb) {
      const scoped = Object.assign({}, svc)
      scoped.get = get
      scoped.on = ctx.on
      scoped.effect = function (fn) { return fn() }
      scoped.inject = function () { return function () {} }
      if (typeof cb === 'function') cb(scoped)
      return function () {}
    },
    effect: function (fn) { return fn() },
    get: get,
    provide: function () { return function () {} },
  }
  return ctx
}

/** Run one tool call through the registered listener. */
function run(name, args, cwd) {
  const exec = {
    name: name,
    arguments: args,
    agent: { session: { header: { cwd: cwd === undefined ? WORKSPACE : cwd } } },
  }
  const decision = listener(exec, function () { return null })
  return {
    denied: decision !== null && decision !== undefined && decision.kind === 'deny',
    allowed: decision === null || decision === undefined,
    reason: decision && decision.reason ? decision.reason : '',
  }
}

const AGENT = { agent: { session: { header: { cwd: WORKSPACE } } } }

/** Mount a fresh instance. Returns the module, with the globals above rebound. */
function mount(options) {
  listener = null
  registeredTool = null
  registeredGuard = null
  registeredRoute = null
  promptSection = null
  registeredCommand = null
  delete require.cache[require.resolve(path.join(ROOT, 'index.js'))]
  const fresh = require(path.join(ROOT, 'index.js'))
  fresh.apply(makeCtx(options))
  return fresh
}

// --------------------------------------------------------- state file helpers

/**
 * THE STATE FILE UNDER TEST MUST NOT BE THE LIVE ONE.
 *
 * This package directory IS the live install (the profile links to it), so the suite's writes used to
 * land on the operator's real setting — and this suite writes `false`, writes `true`, DELETES the file
 * to test the missing case, and renames it to test the handover. Restoring at exit covered the clean
 * path, but a Ctrl-C or a crash partway through would leave live permissions changed or the file gone,
 * which silently means "outside not readable". A test that rewrites the setting it tests has to run
 * against a throwaway copy.
 *
 * Set BEFORE requiring the plugin: the module resolves the path at load.
 */
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-matrix-'))
const STATE_FILE = path.join(TMP_DIR, 'permissions.json')
process.env.DSH_PERMISSION_GUARD_STATE_FILE = STATE_FILE

// Asserted, not merely intended: the whole point of the override is that this suite can never touch the
// live setting, and a future edit that drops the env var would silently take the operator's file back.
check('the suite runs against a THROWAWAY state file, not the live one',
  STATE_FILE !== path.join(ROOT, 'permissions.json') && STATE_FILE.indexOf(TMP_DIR) === 0, STATE_FILE)

function writeState(value) {
  if (typeof value === 'string') fs.writeFileSync(STATE_FILE, value, 'utf8')
  else fs.writeFileSync(STATE_FILE, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

function outsideReadNow() {
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).outsideRead
}

/** Read the state the way an outside observer would: through the tool's own report. */
function reported() {
  return registeredTool.execute({}, AGENT).state.outsideRead
}

// Clean up the throwaway directory and the env override. There is deliberately NO restore step: the
// live file was never opened, so there is nothing to restore.
process.on('exit', function () {
  try {
    delete process.env.DSH_PERMISSION_GUARD_STATE_FILE
    fs.rmSync(TMP_DIR, { recursive: true, force: true })
  } catch (error) { /* best effort */ }
})

// ---------------------------------------------------------------- the suite

console.log('=== mount ===')

writeState({ outsideRead: false })
mount()

check('a tools/pre-execute listener is registered', listener !== null)
check('the outside_read tool is registered', registeredTool !== null && registeredTool.name === 'outside_read')
check('the monotonic guard is registered', registeredGuard !== null)
check('a state route is registered at the new path', registeredRoute !== null
  && registeredRoute.path === '/outsideread-switch/state', registeredRoute ? registeredRoute.path : '(none)')
check('a system-prompt boundary section is registered', promptSection !== null)
if (listener === null) { console.log('FATAL: nothing further can be checked'); process.exit(1) }

console.log('')
console.log('=== reads: outsideRead = false (the restrictive state) ===')

let r = run('read', { file_path: WORKSPACE + '/src/a.js' })
check('a read INSIDE the workspace is allowed', r.allowed)

r = run('read', { file_path: OUTSIDE })
check('a read OUTSIDE the workspace is DENIED', r.denied)
check('the denial names the path and the setting',
  r.reason.indexOf(OUTSIDE) !== -1 && r.reason.indexOf('outsideRead') !== -1, r.reason.slice(0, 80))
check('the denial says the model cannot change the setting', /cannot change/i.test(r.reason))

r = run('read', { file_path: 'D:\\elsewhere\\secret.txt' })
check('a backslash path outside is DENIED too', r.denied)

r = run('read', { file_path: 'a/relative.js' })
check('a relative read resolves INSIDE the workspace and is allowed', r.allowed)

r = run('read', { file_path: '../../escape.txt' })
check('a traversal read that lands outside is DENIED', r.denied)

r = run('read_image', { file_path: OUTSIDE })
check('read_image outside is DENIED (the read set is not just "read")', r.denied)

r = run('glob', { pattern: '**/*.js', path: WORKSPACE })
check('glob scoped inside is allowed', r.allowed)

r = run('glob', { pattern: '**/*.js', path: 'D:/elsewhere' })
check('glob scoped outside is DENIED', r.denied)

r = run('glob', { pattern: '**/*.js' })
check('glob with NO path resolves to the workspace and is allowed', r.allowed)

r = run('grep', { pattern: 'secret', path: 'C:/Windows' })
check('grep scoped outside is DENIED', r.denied)

r = run('pwsh', { command: 'Get-Content "' + WORKSPACE + '/src/a.js"' })
check('a shell read inside the workspace is allowed', r.allowed)

r = run('pwsh', { command: 'Get-Content "' + OUTSIDE + '"' })
check('a shell read outside is DENIED', r.denied)
check('the shell denial names the matched path', /matched path/i.test(r.reason))

r = run('pwsh', { command: 'Get-Content "D:\\elsewhere\\with space\\a.txt"' })
check('a QUOTED outside path containing spaces is denied as ONE path', r.denied, r.reason.slice(0, 70))

r = run('pwsh', { command: 'Get-ChildItem -Force | Select-Object Name' })
check('a shell command with no paths is allowed', r.allowed)

r = run('pwsh', { command: 'echo hello' })
check('a trivial shell command is allowed', r.allowed)

console.log('')
console.log('=== writes: NOT fenced by this plugin (the sandbox owns them) ===')

r = run('write', { file_path: 'D:/elsewhere/new.txt', content: 'x' })
check('a file-tool WRITE outside is allowed by this plugin (the sandbox decides)', r.allowed)

r = run('edit', { file_path: OUTSIDE, old_string: 'a', new_string: 'b' })
check('a file-tool EDIT outside is allowed by this plugin', r.allowed)

r = run('str_replace_editor', { path: OUTSIDE, command: 'str_replace' })
check('str_replace_editor outside is allowed by this plugin', r.allowed)

r = run('write', { file_path: WORKSPACE + '/new.txt', content: 'x' })
check('a write inside the workspace is allowed', r.allowed)

// The shell asymmetry is DELIBERATE and asserted here so it cannot drift silently.
r = run('pwsh', { command: 'Set-Content -Path "' + OUTSIDE + '" -Value x' })
check('a SHELL command naming an outside path is refused even though it writes (deliberate over-block)', r.denied)

console.log('')
console.log('=== the state file is protected from the model ===')

r = run('write', { file_path: STATE_FILE, content: '{"outsideRead":true}' })
check('a file-tool write to the state file is DENIED', r.denied)
check('the refusal cites the self-escalation shape', /self-escalation/i.test(r.reason))

r = run('edit', { file_path: STATE_FILE, old_string: 'false', new_string: 'true' })
check('a file-tool edit of the state file is DENIED', r.denied)

const STATE_POSIX = STATE_FILE.replace(/\\/g, '/')

r = run('pwsh', { command: 'Set-Content -Path "' + STATE_FILE + '" -Value x' })
check('a mutating shell command naming the state file is DENIED', r.denied)

r = run('pwsh', { command: 'node -e "require(\'fs\').writeFileSync(\'' + STATE_POSIX + '\', \'x\')"' })
check('a script API (writeFileSync) naming the state file is DENIED', r.denied, r.reason.slice(0, 60))

r = run('pwsh', { command: 'node -e "require(\'fs\').renameSync(\'a\', \'' + STATE_POSIX + '\')"' })
check('a script API (renameSync) naming the state file is DENIED', r.denied, r.reason.slice(0, 60))

// These two run with the session cwd set to the STATE FILE'S OWN DIRECTORY, so the file is INSIDE the
// workspace being judged. Without that, the read policy refuses them for being outside — which is
// correct behaviour, and is exactly what happened when the state file moved to a temp directory and
// these two still used the plugin directory. Their purpose is to prove the SELF-WRITE fence does not
// over-block READS, so the read policy has to be out of the way for the assertion to mean anything.
r = run('read', { file_path: STATE_POSIX }, TMP_DIR)
check('READING the state file is allowed (knowing the setting is not a capability)', r.allowed, r.reason.slice(0, 60))

r = run('pwsh', { command: 'Get-Content "' + STATE_FILE + '"' }, TMP_DIR)
check('a READ-ONLY shell command naming the state file is allowed', r.allowed, r.reason.slice(0, 60))

r = run('write', { file_path: WORKSPACE + '/permissions.json', content: 'x' })
check('a WRITE to a same-named file elsewhere is fenced too (basename match, over-blocks on purpose)', r.denied)

r = run('read', { file_path: WORKSPACE + '/permissions.json' })
check('READING a same-named file elsewhere is allowed (only writes are fenced by name)', r.allowed)

r = run('read', { file_path: WORKSPACE + '/unrelated.json' })
check('an unrelated file is not treated as the state file', r.allowed)

console.log('')
console.log('=== reads: outsideRead = true ===')

writeState({ outsideRead: true })

r = run('read', { file_path: OUTSIDE })
check('with outsideRead on, an outside read is ALLOWED', r.allowed)

r = run('pwsh', { command: 'Get-Content "' + OUTSIDE + '"' })
check('with outsideRead on, an outside shell read is ALLOWED', r.allowed)

r = run('read', { file_path: WORKSPACE + '/src/a.js' })
check('with outsideRead on, an inside read is still allowed', r.allowed)

console.log('')
console.log('=== state file formats and failures ===')

writeState({ mode: 4 })
check('a legacy mode 4 file reads as outsideRead TRUE', reported() === true)

writeState({ mode: 2 })
check('a legacy mode 2 file reads as outsideRead FALSE (old 2 meant outside NOT readable)', reported() === false)

writeState({ mode: 3 })
check('a legacy mode 3 file reads as outsideRead TRUE', reported() === true)

writeState({ mode: 1 })
check('a legacy mode 1 file reads as outsideRead FALSE', reported() === false)

writeState({ mode: 4 })
reported()
const migrated = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
check('a legacy file is REWRITTEN in the new format (not re-interpreted on every call)',
  typeof migrated.outsideRead === 'boolean' && migrated.mode === undefined,
  JSON.stringify(migrated).slice(0, 70))

writeState('{ this is not json')
check('a malformed state file fails SAFE to outsideRead FALSE', reported() === false)

// A state file that states NOTHING must never be written, and the writer must refuse rather than
// produce one. `JSON.stringify` DROPS an undefined value, so passing a state object without the field
// yielded a file containing only the note: intact-looking, and controlling nothing. Behaviour stayed
// safe because an unrecognised file falls back to the restrictive default — which is exactly why it
// went unnoticed. This asserts the guard exists so it cannot be removed quietly.
const persistSource = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8')
check('persistState REFUSES to write a state object without a boolean outsideRead',
  /function persistState\(state\)\s*\{[\s\S]{0,400}?typeof state\.outsideRead !== 'boolean'/.test(persistSource))

// Reading an uninterpretable file must NOT silently rewrite it: a broken state file has to stay
// visible, or the defect is hidden by the very code that should surface it.
writeState('{ "note": "no setting here" }')
const beforeBroken = fs.readFileSync(STATE_FILE, 'utf8')
check('reading such a file reports the restrictive default', reported() === false)
check('reading it does NOT silently normalise the file', fs.readFileSync(STATE_FILE, 'utf8') === beforeBroken)

fs.unlinkSync(STATE_FILE)
check('a MISSING state file fails SAFE to outsideRead FALSE', reported() === false)

console.log('')
console.log('=== adoption of a renamed state file ===')

// A SIBLING of the state file: the handover only ever looks in the state file's own directory.
const LEGACY_NAME = path.join(TMP_DIR, '权限设置.json')
writeState({ outsideRead: true })
fs.renameSync(STATE_FILE, LEGACY_NAME)
const adoptedValue = reported()
check('a renamed state file is adopted, PRESERVING the operator setting',
  adoptedValue === true, 'outsideRead=' + adoptedValue)
check('the adopted legacy file is REMOVED so it cannot fire twice', !fs.existsSync(LEGACY_NAME))
check('the setting now lives under the current name', fs.existsSync(STATE_FILE))

console.log('')
console.log('=== the tool: reporting, refusing to widen, allowing to narrow ===')

writeState({ outsideRead: true })
let out = registeredTool.execute({}, AGENT)
check('with no arguments the tool REPORTS', out.state !== undefined && out.state.outsideRead === true)
check('the report states the scope is outside-read only', /outside-read/i.test(out.scope))
check('the report lists both available states', Array.isArray(out.availableStates) && out.availableStates.length === 2)
check('the report declares the enforcement is NOT a kernel boundary', /tool layer/i.test(out.enforcement))
check('the report names its limits (shell heuristic and writes not fenced)',
  Array.isArray(out.limits) && out.limits.join(' ').indexOf('shell') !== -1 && out.limits.join(' ').indexOf('writes') !== -1)

const same = registeredTool.execute({ outsideRead: true }, AGENT)
check('setting the SAME value is a no-op reported as changed:false', same.ok === true && same.changed === false)
check('the no-op does not claim to have narrowed anything', same.changed === false)

// Narrowing through the tool is legitimate: giving up access is not an escalation.
writeState({ outsideRead: true })
const narrowed = registeredTool.execute({ outsideRead: false }, AGENT)
check('NARROWING through the tool is allowed', narrowed.ok === true && narrowed.changed === true)
check('the narrowing is actually persisted', outsideReadNow() === false)

console.log('')
console.log('=== the guard refuses WIDENING ===')

writeState({ outsideRead: false })
const guardVerdict = registeredGuard({ name: 'outside_read', arguments: { outsideRead: true } })
check('the guard refuses enabling outside reads', typeof guardVerdict === 'string' && guardVerdict.length > 0)
check('the refusal explains the self-escalation shape', /self-escalation|raise its own|CVE/i.test(String(guardVerdict)))

const guardNarrow = registeredGuard({ name: 'outside_read', arguments: { outsideRead: false } })
check('the guard ALLOWS narrowing (returns undefined)', guardNarrow === undefined)

const guardOther = registeredGuard({ name: 'read', arguments: { file_path: OUTSIDE } })
check('the guard ignores tools other than outside_read', guardOther === undefined)

const guardNoop = registeredGuard({ name: 'outside_read', arguments: {} })
check('the guard ignores an argument-less report call', guardNoop === undefined)

console.log('')
console.log('=== with NO tools.guard: the tool refuses to change anything ===')

writeState({ outsideRead: false })
mount({ noGuard: true })

check('the tool still registers without tools.guard', registeredTool !== null)
check('the guard is NOT registered', registeredGuard === null)

const refusedWiden = registeredTool.execute({ outsideRead: true }, AGENT)
check('a change request is REFUSED when the guard is unavailable (fail closed)',
  refusedWiden.ok === false && refusedWiden.refused === true, JSON.stringify(refusedWiden).slice(0, 90))
check('the refusal explains why it cannot be allowed', /tools\.guard/.test(String(refusedWiden.reason)))
check('the state on disk is unchanged by the refused request', outsideReadNow() === false)

const reportWithoutGuard = registeredTool.execute({}, AGENT)
check('REPORTING still works without the guard',
  reportWithoutGuard.state !== undefined && reportWithoutGuard.state.outsideRead === false)
check('the report says change control is INACTIVE', /INACTIVE/i.test(reportWithoutGuard.capabilities.changeControl))

console.log('')
console.log('=== the boundary text ===')

writeState({ outsideRead: false })
mount()
const text = promptSection.text(AGENT)
check('the boundary text names the session workspace', text.indexOf(WORKSPACE) !== -1, text.slice(0, 80))
check('the boundary text states outside reads are NOT readable', /outside the workspace is NOT readable/.test(text))
check('the boundary text says writes are the sandbox\'s business, not this plugin\'s',
  /writes are confined by the harness sandbox/i.test(text))
check('the boundary text says the model cannot change the setting', /cannot change the setting/i.test(text))

writeState({ outsideRead: true })
const textOn = promptSection.text(AGENT)
check('with outsideRead on the boundary text says READABLE', /outside the workspace is READABLE/.test(textOn))

const textUnknown = promptSection.text({})
check('an unresolvable workspace is STATED, not guessed', /not resolvable/.test(textUnknown), textUnknown.slice(0, 90))
check('the unresolved text does not invent a path', textUnknown.indexOf('homedir') === -1)

console.log('')
console.log('=== the read-only route ===')

function callRoute(method) {
  const headers = {}
  let status = null
  let body = ''
  const res = {
    setHeader: function (k, v) { headers[k.toLowerCase()] = v },
    end: function (chunk) { body = chunk === undefined ? '' : String(chunk) },
  }
  Object.defineProperty(res, 'statusCode', { set: function (v) { status = v }, get: function () { return status } })
  registeredRoute.handler({ method: method }, res)
  return { status: status, headers: headers, body: body }
}

writeState({ outsideRead: true })
const got = callRoute('GET')
check('GET returns 200', got.status === 200, 'status=' + got.status)
const payload = JSON.parse(got.body)
check('the payload carries the boolean', payload.outsideRead === true)
check('the payload carries the state name', typeof payload.name === 'string' && payload.name.length > 0)
check('the payload has EXACTLY two fields (no path disclosure)',
  Object.keys(payload).sort().join(',') === 'name,outsideRead', Object.keys(payload).join(','))
check('the payload mentions no filesystem location',
  got.body.indexOf('/') === -1 && got.body.indexOf('\\') === -1, got.body)
check('the response is marked no-store', got.headers['cache-control'] === 'no-store')

const posted = callRoute('POST')
check('POST is refused with 405 (there is deliberately NO write route)', posted.status === 405, 'status=' + posted.status)
check('the 405 body is JSON, not a stack trace', posted.body.indexOf('{') === 0)

console.log('')
console.log('=== the fallback workspace ===')

const source = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8')
// `[^}]*` stops at the first closing brace: this function has no nested braces, while a lazy
// `[\s\S]*?` bounded by `\n}` ran past the function and swept in the REST of the file, whose
// `process.cwd()` mention then failed a correct implementation.
const fbBody = (/function fallbackWorkspace\(\)\s*\{([^}]*)\}/.exec(source) || ['', ''])[1]
check('the fallback workspace uses os.homedir(), not process.cwd() (the app install dir on Desktop)',
  /os\.homedir\(\)/.test(fbBody) && !/process\.cwd\(\)/.test(fbBody), fbBody.replace(/\s+/g, ' ').slice(0, 70))

process.env.DSH_PERMISSION_GUARD_WORKSPACE = 'D:/forced'
mount()
const forced = registeredTool.execute({}, AGENT).fallbackWorkspace
check('the env override wins over the home directory', forced === 'D:/forced', forced)
delete process.env.DSH_PERMISSION_GUARD_WORKSPACE

console.log('')
console.log('=== the switch command: the only write path the model cannot take ===')

writeState({ outsideRead: false })
mount()

check('the switch command is registered', registeredCommand !== null
  && registeredCommand.name === 'outside-read', registeredCommand ? registeredCommand.name : '(none)')
check('the command declares its input hint so the composer can prompt', registeredCommand !== null
  && registeredCommand.input !== undefined && typeof registeredCommand.input.hint === 'string')

function runCommand(raw) {
  return registeredCommand.handler({ commandId: 'c1', agent: { id: 's1' }, rawInput: raw, attachments: [], signal: undefined })
}

let cmd = runCommand('on')
check('the command can ENABLE outside reads (the human path, unlike the tool)',
  cmd.kind === 'success' && outsideReadNow() === true, JSON.stringify(cmd))
check('the success text states the new value', /true/.test(String(cmd.text)))

cmd = runCommand('off')
check('the command can DISABLE outside reads', cmd.kind === 'success' && outsideReadNow() === false, JSON.stringify(cmd))

cmd = runCommand('')
check('an empty argument REPORTS and changes nothing', cmd.kind === 'success'
  && /false/.test(String(cmd.text)) && outsideReadNow() === false, JSON.stringify(cmd))

cmd = runCommand('status')
check('"status" reports without changing', cmd.kind === 'success' && outsideReadNow() === false)

cmd = runCommand('sideways')
check('an unknown argument is an ERROR with usage, not a silent success',
  cmd.kind === 'error' && /on \| off/.test(String(cmd.text)), JSON.stringify(cmd))
check('an unknown argument changes nothing', outsideReadNow() === false)

writeState({ outsideRead: true })
cmd = runCommand('on')
check('setting the value it already has reports success without a needless write',
  cmd.kind === 'success' && /already/.test(String(cmd.text)), JSON.stringify(cmd))

// A missing registry must NOT take down the fence. The switch is a convenience; the read policy is the
// product, and they must fail independently.
writeState({ outsideRead: true })
mount({ noCommands: true })
check('with NO commands service the plugin still mounts', listener !== null && registeredTool !== null)
check('the command is not registered when the service is absent', registeredCommand === null)
r = run('read', { file_path: OUTSIDE })
check('with no commands service the read fence still works', r.allowed)
writeState({ outsideRead: false })
r = run('read', { file_path: OUTSIDE })
check('and it still denies when outside reads are off', r.denied)

console.log('')
console.log('=== no stale four-mode vocabulary reaches a user ===')

// THIS CHECK EXISTS BECAUSE THE SAME DEFECT SHIPPED TWICE. A user-facing string kept describing the
// design that had been replaced: first a composer note naming a tool the model cannot reach, then the
// installer's closing message still promising "the initial mode is 2 (workspace write)" and telling the
// reader to change it with an indicator that was never able to change anything. Both were found by a
// person reading the screen, not by this suite, so the suite now reads the shipped strings too.
//
// Comments are STRIPPED first: the migration table in index.js and the rationale in modes.js name the old
// modes on purpose, and documentation of history is not a stale instruction.
const STALE = ['Workspace write', 'Workspace read', 'Full access', 'initial mode', 'mode 1-4', 'mode number']
const SHIPPED = ['index.js', 'modes.js', 'client.js', 'bin/install.js']
for (let i = 0; i < SHIPPED.length; i++) {
  const rel = SHIPPED[i]
  const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8')
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(function (line) { return line.trim().indexOf('//') !== 0 })
    .join('\n')
  const found = STALE.filter(function (phrase) { return code.indexOf(phrase) !== -1 })
  check('no stale four-mode wording is reachable in ' + rel, found.length === 0, found.join(', '))
}

console.log('')
console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES')
process.exitCode = failures === 0 ? 0 : 1
