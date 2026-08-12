# Hark for Codex

Public distribution of the Hark durable-await plugin for Codex.

Hark lets one Codex task stop inference while it waits for an authenticated external event, then resume the same originating tool call exactly once.

## Install v0.1.6

```sh
codex plugin marketplace add Dexter-DAO/hark-plugin --ref v0.1.6
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

- Hark release: `9c05a1276e96-acb61df15de9`
- Source commit: `9c05a1276e961c979ed0d1ade447a19695a0c894`
- Source tree: `5d374e676085a032bead774322750aaefd453fe0`
- Artifact digest: `acb61df15de97e88f34ac531512b898b665ddb7fef8b1891c08aab9c8fe8ff85`
- Plugin digest: `0445dc8bd14c8fe6c9837f6bc3446e3a861e1f2609f0b1a7819d659ed7dbed8a`
