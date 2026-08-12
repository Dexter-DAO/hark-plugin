# Hark for Codex

Public distribution of the Hark durable-await plugin for Codex.

Hark lets one Codex task stop inference while it waits for an authenticated external event, then resume the same originating tool call exactly once.

## Install v0.1.11

```sh
codex plugin marketplace add Dexter-DAO/hark-plugin --ref v0.1.11
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

- Hark release: `e372ead2170e-2656f6a93e5d`
- Source commit: `e372ead2170e7ec8ba2249bf82e6392d5a46b93d`
- Source tree: `2535420d1c55f6f2f05ea26907e82e52bf795d37`
- Artifact digest: `2656f6a93e5dd69c14a4210d4588aae6b28efa9cd1f30b7b6a2a1ebd7508fc5b`
- Plugin digest: `f078155bcbd7ac7c5e7afc3990b587bb68cfb38a4aecee22af39db9f09f796f3`
