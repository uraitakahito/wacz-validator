# wacz-validator

A producer-independent validator for [WACZ](https://specs.webrecorder.net/wacz/1.1.1/)
web archives — the format that packages WARC data and its metadata into a ZIP
file. Point it at an archive and it reports, rule by rule, what conforms and
what does not. A stateless daemon does the validating; the terminal UI is a thin
client of it, so a browser frontend can later speak the same protocol.

## Documentation

Everything — quickstart, reference (rules, profiles, JSON report), and guides
(architecture, Apple Container stack, corpus, terminology) — lives on the docs
site:

- **English** — <https://uraitakahito.github.io/wacz-validator/>
- **日本語** — <https://uraitakahito.github.io/wacz-validator/ja/>

## Related Projects

- [BrowserHive](https://github.com/uraitakahito/browserhive) — a web-capture server whose BrowserHive WACZ files wacz-validator checks.
- [WACZ 1.1.1](https://specs.webrecorder.net/wacz/1.1.1/) — the specification ([日本語訳](https://uraitakahito.github.io/specs/wacz/1.1.1/)).

## License

[Unlicense](./LICENSE).
