# Hark for Codex

Public distribution of the Hark durable-await plugin for Codex.

Hark lets one Codex task stop inference while it waits for an authenticated external event, then resume the same originating tool call exactly once.

## Install v0.1.1

```sh
codex plugin marketplace add Dexter-DAO/hark-plugin --ref v0.1.1
codex plugin add hark@hark
```

Then run:

```sh
hark-codex doctor
hark-codex connect
```

The plugin talks to the public Hark service through `https://api.dexter.cash` and `https://hark.sh`.

This repository is a release-only distribution mirror. Hark is proprietary software (`LicenseRef-Proprietary`); no open-source license is granted.

Release provenance:

- Hark release: `9202ecffb35d-29ea313bc7f7`
- Source commit: `9202ecffb35d017e2788982d9a2276062a9af4cd`
- Plugin digest: `c954c3525386c3b81d85cef2a5aefa9655a11289ae45f411ac4a0a320ddc8085`
