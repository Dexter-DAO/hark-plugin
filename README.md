# Hark for Codex

Public distribution of the Hark durable-await plugin for Codex.

Hark lets one Codex task stop inference while it waits for an authenticated external event, then resume the same originating tool call exactly once.

## Install v0.1.2

```sh
codex plugin marketplace add Dexter-DAO/hark-plugin --ref v0.1.2
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

- Hark release: `d35ba5a6b7f8-ac4c291fb246`
- Source commit: `d35ba5a6b7f85070e93deaf67c78d02c12ff1e34`
- Source tree: `2062498c4242ed3663ee5c394b10ea89d99765ad`
- Artifact digest: `ac4c291fb2460d18bbe00d6bf0cdf4ce9481add6a11dc4a2a1a6d92ee53a9f6b`
- Plugin digest: `cb2a61e920cf78f2487b4381a307f367b467a78929a2035a9f0c4f5601ae0d1f`
