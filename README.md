# Hark for Codex

Public distribution of the Hark durable-await plugin for Codex.

Hark lets one Codex task stop inference while it waits for an authenticated external event, then resume the same originating tool call exactly once.

## Install v0.1.3

```sh
codex plugin marketplace add Dexter-DAO/hark-plugin --ref v0.1.3
codex plugin add hark@hark
```

From the installed plugin root, run:

```sh
node ./hark/cli/hark-codex.mjs setup --no-open
node ./hark/cli/hark-codex.mjs doctor
```

Setup pins and verifies both Codex 0.147 and its required
`codex-code-mode-host` sibling. It also repairs an existing Hark installation
that has the correct Codex executable but is missing that host.

The plugin talks to the public Hark service through `https://api.dexter.cash` and `https://hark.sh`.

This repository is a release-only distribution mirror. Hark is proprietary software (`LicenseRef-Proprietary`); no open-source license is granted.

Release provenance:

- Hark release: `155340899135-c66a82380d09`
- Source commit: `1553408991359747810bf488114bbf869428070a`
- Source tree: `f28c29f221b4896495fcc96608135cb938aba8e3`
- Artifact digest: `c66a82380d0901298c60935771334467810e7888eef6b990017d69350492b8c5`
- Plugin digest: `1fca58c761b7515bba57acc24b347394992176cd24dd10e4fb297a4b7a5ca041`
