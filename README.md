# Hark for Codex

Public distribution of the Hark durable-await plugin for Codex.

Hark lets one Codex task stop inference while it waits for an authenticated external event, then resume the same originating tool call exactly once.

## Install v0.1.7

```sh
codex plugin marketplace add Dexter-DAO/hark-plugin --ref v0.1.7
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

- Hark release: `06ee0c540159-dff47eb2e241`
- Source commit: `06ee0c540159530c3cb225681667adc94d491e7f`
- Source tree: `68e1e0ba2bebda0e9ffd979156dfaca7cd3ce262`
- Artifact digest: `dff47eb2e2415ea53b06014ca0625f999ea563603be6026074a5673dad573712`
- Plugin digest: `ffcf64731876a057f3a40de5e17bc17ec37b8625727e0011e4bd55f089a93129`
