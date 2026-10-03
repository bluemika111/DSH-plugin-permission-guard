'use strict'

/**
 * The two states this plugin distinguishes, and the tool sets it fences.
 *
 * WHY THIS IS ONE BOOLEAN AND NOT TWO MODE NUMBERS
 *
 * The earlier design had four numbered modes covering two axes. It is now ONE axis — may the model
 * read outside the workspace — because WRITES ARE THE HARNESS'S OWN BUSINESS. The built-in sandbox
 * already confines them per session, so a second opinion about writes only produced a state that
 * could disagree with the kernel's. This plugin therefore adds exactly the dimension the kernel does
 * not have, and nothing else.
 *
 * The state is a NAMED BOOLEAN rather than `mode: 1|2` for a specific safety reason. The old ids
 * meant something different: old `2` was "Workspace write", i.e. outside NOT readable, while a new
 * `2` would mean "Outside readable". A state file surviving an upgrade would then have been read as
 * the OPPOSITE permission and would have silently granted outside reads. A field whose name states
 * its meaning cannot be misread that way, and its absence is unambiguous.
 *
 * WHY THE KERNEL CANNOT EXPRESS THIS. The harness's SandboxMode is a closed three-value set
 * (read-only / workspace-write / danger-full-access) and it fences WRITES ONLY — the bundled fs
 * sandbox documents that reads pass through untouched in every mode. "Outside readable" is therefore
 * not expressible upstream at all, which is the entire reason this plugin exists.
 */

/**
 * Both states grant the same thing inside the workspace; they differ only outside it.
 *
 * The field is named `outsideRead` — the SAME name the state file uses and the same name every
 * consumer reads. An earlier draft called it `value`, while the plugin read `.outsideRead`: the
 * mismatch made every comparison `undefined === true`, which silently disabled the widening guard and
 * wrote a state file with the field missing entirely. One concept, one name.
 */
const STATES = [
  {
    outsideRead: false,
    name: 'Workspace only',
    nameZh: '仅工作区',
    summary: 'workspace: readable; outside: not readable',
  },
  {
    outsideRead: true,
    name: 'Outside readable',
    nameZh: '外部可读',
    summary: 'workspace: readable; outside: readable',
  },
]

/**
 * Outside reads are DENIED until an operator allows them.
 *
 * The safe default: this plugin exists to ADD a restriction, so a fresh install must not hand out
 * access nobody asked for. It is also the answer when the state file is missing or unreadable —
 * the case that matters, because a fail-open default there would widen access exactly when the
 * configuration is broken.
 */
const DEFAULT_OUTSIDE_READ = false

/** Resolve a state from a stored value; undefined when the value is not a known state. */
function stateByValue(value) {
  for (let i = 0; i < STATES.length; i++) {
    if (STATES[i].outsideRead === Boolean(value)) return STATES[i]
  }
  return undefined
}

/** Tools that read a single path. */
const PATH_READ_TOOLS = new Set(['read', 'read_image'])

/**
 * Tools that write a single path.
 *
 * Still listed, but no longer fenced for their path policy: only the STATE FILE is protected (by the
 * self-escalation fence), and every other write is left to the harness sandbox. They are listed so
 * that fence can find their target argument.
 */
const PATH_WRITE_TOOLS = new Set(['write', 'edit'])

/** Tools that read a directory tree, optionally scoped by `path`. */
const TREE_READ_TOOLS = new Set(['glob', 'grep'])

/** Shell tools, fenced for READS by best-effort path extraction from the command text. */
const SHELL_TOOLS = new Set(['pwsh', 'bash'])

/** `str_replace_editor` carries its target in `path`. */
const STR_REPLACE_TOOL = 'str_replace_editor'

module.exports = {
  STATES,
  DEFAULT_OUTSIDE_READ,
  stateByValue,
  PATH_READ_TOOLS,
  PATH_WRITE_TOOLS,
  TREE_READ_TOOLS,
  SHELL_TOOLS,
  STR_REPLACE_TOOL,
}
