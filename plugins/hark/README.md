# Hark Agent Plugin

Hark gives an agent one durable operation for real external waits:
`hark_await`. The call stays open without model inference until the authenticated
event arrives, then returns that event to the same tool call in the same Codex
turn. The agent continues exactly where it stopped.

Use Hark when progress genuinely depends on a webhook, external job, scheduled
time, or another external signal. Do not use it for ordinary in-turn work.

This directory is Hark's portable core. Exact wake requires a host adapter that
privately binds the host conversation, generation, and tool call. Those values
are never model inputs. The parent package includes the Codex adapter.

## Install once

Add this repository as a Codex plugin marketplace and install **Hark**:

```bash
codex plugin marketplace add Dexter-DAO/hark-plugin --ref v0.1.6
codex plugin add hark@hark
```

Connect and install the pinned runtime before relying on any background hook.
Keep the bundled `hark-codex setup --no-open` command in the foreground from
the installed plugin root:

```bash
node ./hark/cli/hark-codex.mjs setup --no-open
```

Setup preserves existing `features.code_mode.direct_only_tool_namespaces`
entries and ensures `mcp__hark` is exposed directly. Doctor fails closed when
that direct exposure is absent.

Hark setup pins and verifies the Codex 0.147 executable, its required
`codex-code-mode-host` sibling, and the official bundled Bubblewrap helper used
by Codex's normal Linux sandbox profiles. Existing installations missing a
companion are repaired without replacing already-verified runtime files.

Setup and doctor also execute both Codex `:read-only` and `:workspace`
sandbox profiles with deprecated legacy Landlock explicitly disabled. On
Ubuntu 24.04, a host that restricts unprivileged user namespaces needs the
scoped system Bubblewrap AppArmor profile documented in the
[Codex sandbox prerequisites](https://learn.chatgpt.com/docs/sandboxing#prerequisites):

```bash
sudo apt-get update
sudo apt-get install -y bubblewrap apparmor-profiles apparmor-utils
sudo install -m 0644 \
  /usr/share/apparmor/extra-profiles/bwrap-userns-restrict \
  /etc/apparmor.d/bwrap-userns-restrict
sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict
```

Hark never disables the global AppArmor restriction, enables setuid Bubblewrap,
or silently switches Codex to deprecated legacy Landlock. Setup stops before
daemon mutation until both functional sandbox probes pass.

The command visibly prints both fields needed by a headless Linux install:

```text
verificationUriComplete: https://hark.sh/install?code=ABCD-EFGH
userCode: ABCD-EFGH
```

Open `verificationUriComplete` in any browser, verify `userCode`, approve the
named installation, and wait for the foreground command to report success. The
`--no-open` form never depends on `xdg-open`. `SessionStart` can repair and
ensure an already-connected runtime; it is not the approval ceremony.

In the first Codex session, review and trust Hark's four bundled hooks
(`SessionStart`, `PreToolUse`, `PostToolUse`, and `UserPromptSubmit`) once. Hark
then keeps its local supervisor running automatically; there is no wake command
or user recovery procedure.

To verify the complete installation from the installed plugin root:

```bash
node ./hark/cli/hark-codex.mjs doctor
```

## Use

The model calls `hark_await` once with four public fields: the work to continue,
a short name, the external source, and the exact wake condition. Runtime,
installation, conversation, task, turn, tool-call, lease, and receipt identities
are derived and fenced by Hark. They are never model inputs.

While the call is held:

- the Codex turn remains the same;
- no model inference is used to poll or wait;
- the external event is accepted once;
- a crash cannot cause the external work to execute twice.

On the normal path the tool returns `hark.await-satisfied.v1` and Codex continues
in that same turn. If the host crashes, Hark first determines whether the exact
tool result was already persisted. It adopts that result when present and opens
a recovery turn only when the original call is provably gone.

## One implementation, two package views

`plugin.json`, `mcp.json`, and `skills/` are the portable Agent Plugins 1.0.0
package used for discovery by compatible clients, including Cursor. The parent
`plugins/` directory is the Codex wrapper around that same implementation. It
adds the host lifecycle hooks and strict MCP settings needed to prove an exact
same-call wake on Codex 0.147.

The wrapper is intentional: Agent Plugins v1 provides a portable skill and MCP
server, but it does not define the host hooks needed to bind a long-running tool
call to Codex's private conversation and turn identity. There is no second Hark
runtime and no forked business logic.

Both package views launch the bundled `mcp/server.mjs`; neither manifest contains
credentials. Hark's private state lives under `~/.hark`, or an absolute
`HARK_DATA_DIR` override.

## Cursor

Cursor support is discovery-only in this release. Cursor can discover the
portable skill and launch the MCP server, but direct `hark_await` execution is
intentionally unavailable until the Cursor host adapter ships and passes its
own same-call and crash-recovery certification. Do not install this directory
as operational Cursor Hark yet. Codex certification does not imply Cursor
certification.

## Trust boundary

- The model describes the external condition and receives the authenticated
  result; it never controls host identity, leases, commits, or receipts.
- Hark binds the request to the host-supplied Codex tool boundary before the
  wait becomes durable.
- The API, local protocol, transcript proof, and runtime receipts must agree on
  the same await, wake, call, and result before certification succeeds.
- Waiting is the held tool call itself. Polling, sleep loops, repeated model
  turns, and synthetic wake prompts are not the normal product path.
