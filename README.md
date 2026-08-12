# Hark for Codex

Public distribution of the Hark durable-await plugin for Codex.

Hark lets one Codex task stop inference while it waits for an authenticated external event, then resume the same originating tool call exactly once.

## Install v0.1.9

```sh
codex plugin marketplace add Dexter-DAO/hark-plugin --ref v0.1.9
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

- Hark release: `e30ddf35fea8-4d7261a1cd58`
- Source commit: `e30ddf35fea8e2cb78602553d0bf0dc4a7b6eb8b`
- Source tree: `96d76bbcea9c5f998d9cf7bd26213f24b9df58cc`
- Artifact digest: `4d7261a1cd58e41e62924e06994ea4b00272a9de1c3b7cfc89804fee1c2e8eb5`
- Plugin digest: `f045c2e669621d5df902d94a862e85a7cce5d25cb9554eaf7f5e90f2271efda2`
