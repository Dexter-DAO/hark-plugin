# Hark for Codex

Public distribution of the Hark durable-await plugin for Codex.

Hark lets one Codex task stop inference while it waits for an authenticated external event, then resume the same originating tool call exactly once.

## Install v0.1.5

```sh
codex plugin marketplace add Dexter-DAO/hark-plugin --ref v0.1.5
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

Setup and doctor also execute Codex's read-only and workspace Bubblewrap
profiles. Ubuntu 24.04 hosts that restrict unprivileged user namespaces must
load the scoped system profile described in the
[Codex sandbox prerequisites](https://learn.chatgpt.com/docs/sandboxing#prerequisites).
Hark does not disable the global restriction or silently switch to deprecated
legacy Landlock.

The plugin talks to the public Hark service through `https://api.dexter.cash` and `https://hark.sh`.

This repository is a release-only distribution mirror. Hark is proprietary software (`LicenseRef-Proprietary`); no open-source license is granted.

Release provenance:

- Hark release: `02cd06aa450c-ac53280e79a2`
- Source commit: `02cd06aa450c054c3a32559bc65edcaa278696e8`
- Source tree: `236b48c5525234ae16eb0537999c915e40fab566`
- Artifact digest: `ac53280e79a232603b134186936f1b88a102455d0ea2c01d5bea4c64dad2aa15`
- Plugin digest: `f1da44a6ec186f5d03e93a16a560e1ec120c5c2509cfefb3576f14f9d0d07d98`
