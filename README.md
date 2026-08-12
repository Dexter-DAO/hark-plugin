# Hark for Codex

Public distribution of the Hark durable-await plugin for Codex.

Hark lets one Codex task stop inference while it waits for an authenticated external event, then resume the same originating tool call exactly once.

## Install v0.1.8

```sh
codex plugin marketplace add Dexter-DAO/hark-plugin --ref v0.1.8
codex plugin add hark@hark
```

From the installed plugin root, run:

```sh
node ./hark/cli/hark-codex.mjs setup --no-open
node ./hark/cli/hark-codex.mjs doctor
```

Setup pins and verifies Codex 0.147, its required `codex-code-mode-host`
sibling, and the official bundled Bubblewrap helper used by Codex's normal
Linux sandbox profiles. It repairs missing companions without replacing
already-verified runtime files.

Setup preserves existing `features.code_mode.direct_only_tool_namespaces`
entries and ensures `mcp__hark` is exposed directly. Doctor fails closed when
that direct exposure is absent.

Setup and doctor also execute Codex's read-only and workspace Bubblewrap
profiles. Ubuntu 24.04 hosts that restrict unprivileged user namespaces must
load the scoped system profile described in the
[Codex sandbox prerequisites](https://learn.chatgpt.com/docs/sandboxing#prerequisites).
Hark does not disable the global restriction or silently switch to deprecated
legacy Landlock.

The plugin talks to the public Hark service through `https://api.dexter.cash` and `https://hark.sh`.

This repository is a release-only distribution mirror. Hark is proprietary software (`LicenseRef-Proprietary`); no open-source license is granted.

Release provenance:

- Hark release: `de81cecb3d6e-137c661067ec`
- Source commit: `de81cecb3d6ec4c55669cde2aa6c1046c938964a`
- Source tree: `6fb58d784c1db3c71f0a6a4ce3049b580b9e7075`
- Artifact digest: `137c661067ecc00b836a2352810678c421f05ff134516259bdaedf0a5824ea7a`
- Plugin digest: `e9ec4ac4bdb7a6e6d576ce9f65847854cf775a81a90a01d8c03e2459796dca04`
