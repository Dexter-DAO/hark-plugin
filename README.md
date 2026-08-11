# Hark for Codex

Public distribution of the Hark durable-await plugin for Codex.

Hark lets one Codex task stop inference while it waits for an authenticated external event, then resume the same originating tool call exactly once.

## Install v0.1.4

```sh
codex plugin marketplace add Dexter-DAO/hark-plugin --ref v0.1.4
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

The plugin talks to the public Hark service through `https://api.dexter.cash` and `https://hark.sh`.

This repository is a release-only distribution mirror. Hark is proprietary software (`LicenseRef-Proprietary`); no open-source license is granted.

Release provenance:

- Hark release: `afa285ccdcce-0cfd564cd779`
- Source commit: `afa285ccdcce7075db9652ed82b7ba64ee2227d7`
- Source tree: `ab6ecdc5259c67e923bfb337b2b1432b63cdcb8a`
- Artifact digest: `0cfd564cd779c6e23bd06711cc244169b789b971ece1f418cf7238156dd32268`
- Plugin digest: `3e38cca6c4e5f36a7ea51d03ea13527c66270529342bd7ef86178cd4e4482477`
