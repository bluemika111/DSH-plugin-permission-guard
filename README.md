# dsh-outsideread-switch

A [DeepSeek Harness](https://www.npmjs.com/package/dsh-outsideread-switch) plugin that decides **one** thing:

> **May the model read outside the session workspace?**

That is the single dimension the harness sandbox does not have. The sandbox fences **writes** per session and
documents that reads pass through untouched in every mode — so "outside readable" has no upstream equivalent, and
this plugin exists to supply it.

```json
// permissions.json, beside the installed plugin
{
  "outsideRead": false,
  "note": "Read and written by the outsideread-switch plugin. ..."
}
```

| `outsideRead` | Inside the workspace | Outside the workspace |
|---|---|---|
| `false` *(default)* | readable | **not readable** |
| `true` | readable | readable |

## What it does not do

**It does not fence writes, and it never speaks to the kernel sandbox.**

An earlier version did both: four numbered modes over two axes, kept in step with the harness sandbox in both
directions. That sync layer produced nearly every bug this plugin has had — a mode mapped to the wrong kernel
value, a session-creation pin silently overwriting an operator's choice, a reverse direction that fired from only
one of its three possible triggers. All of it existed to answer a question the kernel already answers.

**The cost, stated plainly:** because it no longer sets kernel state, it cannot guarantee the kernel is no stricter
than it is. If you select a permissive built-in preset, outside **writes** are allowed and this plugin will not stop
them. Writes are yours, through the harness's own control.

## Changing the setting

Two ways, both immediate — the state file is re-read on every check, so there is nothing to restart.

- **The switch in the composer.** Click it to toggle. It shows the current setting, and this is the intended way.
- **Edit `outsideRead` in `permissions.json`**, beside the installed plugin. Kept as the fallback for when the UI
  cannot help — a broken page, or a build where the client half did not load.

### How the switch writes

It runs a host command, `/outside-read on|off`, issued from the client through the session's own
`command(line)`. That choice is the security design, not an implementation detail:

- **An HTTP write route is the one thing that must not exist.** HTTP never passes through `tools/pre-execute`, so
  the model's own shell could POST to it and route around the fence that protects the state file. The switch would
  have handed over exactly the capability it exists to withhold.
- **A command is the harness's human-command registry.** The model cannot type a slash command, and this plugin
  invents no route of its own.
- You can also run `/outside-read on|off|status` yourself.

**The residual assumption, stated rather than buried:** the connection RPC that carries the command is the same
channel the harness's own permission selector uses, so anything able to drive it could already change the built-in
sandbox preset. The switch therefore adds no new class of exposure — but it is not a stronger barrier either. The
only way to make the barrier strictly stronger is to have no switch.

## Requirements

- DeepSeek Harness with the `tools` service (the tool layer this fences).
- **`tools.guard` is required for the switch to be safe.** `guard()` is the monotonic seam that makes a tool call
  unable to widen the model's own access. When it is absent, the `outside_read` tool becomes **report-only**:
  changes are refused outright, because allowing them would let the model enable its own outside reads. The read
  fence itself is unaffected — it does not depend on the guard.

## Install

```sh
npx --yes dsh-outsideread-switch@latest install
```

Then **restart DSH**: the composition is evaluated only at startup. `--dry-run` prints the plan; `--profile <name>`
targets another profile; `uninstall` reverses it.

## What the model can and cannot do

- **It cannot enable outside reads.** Enabling is refused by a `tools.guard` check, and every write to the state file
  is refused by a self-escalation fence — including through `node -e`, shell scripts, and a hard-link alias under
  another name.
- **It CAN reach the `outside_read` tool**, and this is stated as a measured fact rather than hedged. An earlier
  version of this file claimed the tool never reached the model's tool list; that was true of the build it was
  measured on and false on the current one, where the tool is callable. It matters because the guard is what stands
  between the model and its own permission: with the tool reachable, `tools.guard` is load-bearing rather than
  defending a path nobody can walk. Measured with the tool itself: a call with no arguments returns the report and
  changes nothing.
- **It can disable outside reads.** Giving up access is not an escalation, so narrowing is allowed.
- **It can always read the setting.** Knowing it is not a capability.
- **It can always write files**, subject to the harness sandbox.

## Limits

Stated plainly, because over-trusting a tool-layer fence is its own risk:

- **This is a tool-layer fence, not a kernel boundary.** It sees tool calls, not syscalls. Code the model runs that
  opens a file without naming it in a tool argument is outside its view.
- **Shell path extraction is a heuristic.** `pwsh`/`bash` commands are judged by the paths their text names. Plain
  forms are caught; deliberate obfuscation is not.
- **Shell commands over-block on purpose.** Any shell command naming a path outside the workspace is refused while
  outside reads are off — *including one that only writes there*. Distinguishing read positions from write positions
  in arbitrary shell text is not reliable, and a rule that skipped commands containing a write verb would leave a
  trivial bypass: `Get-Content C:\secret > out.txt` writes **inside** the workspace, which the sandbox permits,
  while reading outside it. The cost is that an outside write through the shell is refused earlier than the sandbox
  would refuse it. File-tool writes are not affected.
- **The setting is process-global**, not per session.
- **A file named `permissions.json` anywhere is treated as the state file when written through a tool.** The fence
  matches the basename so that a rename cannot open the hole it exists to close. Reads are unaffected.

## Upgrading from 1.x

1.x stored `mode: 1..4` over two axes. The old outside-read dimension is `mode >= 3`, and that is how a legacy file
is read:

| old mode | meaning | becomes |
|---|---|---|
| 1 `Workspace read` | outside not readable | `outsideRead: false` |
| 2 `Workspace write` | outside not readable | `outsideRead: false` |
| 3 `Outside readable` | outside readable | `outsideRead: true` |
| 4 `Full access` | outside readable | `outsideRead: true` |

The mapping is written out because getting it backwards would **grant** outside reads on upgrade. A migrated file is
rewritten in the new format on first read.

The state is a named boolean rather than `mode: 1|2` for the same reason: old `2` meant "outside NOT readable" and a
new `2` would mean the opposite, so a surviving file would have been read as the opposite permission.

**Note what 1.x users lose.** Modes 1 and 4 also expressed workspace-write and outside-write policy. Those are now
entirely the harness sandbox's, so a 1.x install that relied on this plugin to restrict writes must set the
corresponding built-in preset instead.

## Configuration

| Setting | Default | Purpose |
|---|---|---|
| `DSH_PERMISSION_GUARD_WORKSPACE` | the user's home directory | The workspace used **only** when a tool call carries no session working directory. A real session cwd always wins. The default is deliberately a location that cannot be a workspace, so a fallback misclassification **denies** rather than permits. |

## Uninstall

```sh
npx --yes dsh-outsideread-switch uninstall
```

Removing the plugin directory removes the setting with it. To keep it, copy `permissions.json` out first and put it
back beside the reinstalled plugin.

Note that the state file **cannot** be removed through the tool layer: a direct write, or `fs.unlinkSync` and
friends, is refused by the self-escalation fence. That is by design — use an editor.

## Development

`Development process.md` records why this plugin is shaped the way it is, including every bug found after a release
and where each one came from. `npm test` runs the policy matrix, boot safety, the client contract, module
resolution, and the route-disclosure probe.

## License

MIT
