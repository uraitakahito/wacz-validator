---
title: Quickstart
description: Install wacz-validator and validate your first WACZ.
---

## Install

wacz-validator is a pnpm workspace of seven packages. Build them, then register the
binaries globally:

```sh
pnpm install --frozen-lockfile
pnpm build

pnpm --dir packages/validate-cli add -g .   # wacz-validator-validate
pnpm --dir packages/tui          add -g .   # wacz-validator
pnpm --dir packages/daemon       add -g .   # wacz-validator-daemon (only for a long-running daemon)
```

After that the names work from anywhere, inside the repository or out.

The third line is optional. `wacz-validator` starts a daemon by itself, so you only
need `wacz-validator-daemon` on `PATH` to run one that outlives a single session — a
dependency's binary is not linked globally, so installing the TUI alone does not
give you that name.

## Validate one archive

```sh
wacz-validator-validate samples/wikipedia.wacz
```

That is the non-interactive path: it prints a report and exits with a code you
can branch on in CI.

The same command validates an archive on an S3-compatible store, not just a
local file. For a WACZ in the bundled SeaweedFS, point the AWS SDK's default
chain at it:

```sh
export AWS_ENDPOINT_URL_S3=http://seaweedfs.crawler-storage:8333
export AWS_REGION=us-east-1
export AWS_ACCESS_KEY_ID=wacz-validator AWS_SECRET_ACCESS_KEY=wacz-validator

wacz-validator-validate --s3-force-path-style s3://wacz-validator/wikipedia.wacz
```

`--s3-force-path-style` is needed for stores that only answer path-style
addressing, such as SeaweedFS and MinIO (`WACZ_VALIDATOR_S3_FORCE_PATH_STYLE=true`
does the same). Apart from `source` becoming
`{ "kind": "s3", "uri": "s3://…" }`, the report is the same as for a local
file.

:::caution[`AWS_PROFILE` beats the variables above]
If your shell exports `AWS_PROFILE`, the SDK uses **that profile** and ignores
the access key above. Either `unset AWS_PROFILE` or prefix the command with
`env -u AWS_PROFILE`.
:::

Starting the store and uploading an archive to it is covered in
[Container](/wacz-validator/container/).

## Pass a URL

**To validate without holding any keys**, pass the URL itself. A signed URL (an
S3 presigned URL, say) is fine too — its query never reaches the report.

```sh
wacz-validator-validate "https://example.com/archives/wikipedia.wacz"
```

It reads by **range GET**: only the ZIP central directory and the entries the
rules need, so nothing downloads the whole file. **It does not use `HEAD`** — a
presigned URL's signature is made for GET, and HEAD comes back 403. The total
size is read from the `Content-Range` of the first range GET.

:::caution[A server that ignores Range cannot be opened]
When a server ignores `Range` and answers `200` with the whole body, validation
**stops before it starts**. Treating that body as the requested range would mean
reading the ZIP central directory from the start of the file, and reporting a
perfectly good WACZ as broken. What is broken there is the server's range
support, not the archive.
:::

The report's `source` becomes `{ "kind": "http", "url": "https://…" }` — **with
the query stripped**.

For an interactive read of the same report, use the TUI:

```sh
wacz-validator samples/wikipedia.wacz
```

`wacz-validator` starts `wacz-validator-daemon` as a child process and talks to it over
WebSocket, so nothing above involves a port.

To attach to a daemon that outlives the session instead, start one on a port you
choose:

```sh
wacz-validator-daemon --port 7333 &
```

It prints the URL it is listening on:

```
wacz-validator-daemon ws://127.0.0.1:7333
```

Pass that URL through:

```sh
wacz-validator --server ws://127.0.0.1:7333 samples/wikipedia.wacz
```

:::note[Where the port comes from]
Without `--port` the daemon uses `0`, meaning **the OS picks a free port** and
the number differs on every start. Fix it with `--port` or
`WACZ_VALIDATOR_DAEMON_PORT`, or copy the URL the daemon prints. There is no default
port to guess.
:::

## Choose how strict to be

The default profile is `spec`. An archive that exits 0 under it is expected to
replay correctly in [ReplayWeb.page](https://replayweb.page/).

```sh
wacz-validator-validate --profile browserhive        samples/wikipedia.wacz   # stricter
wacz-validator-validate --profile browserhive@2.1.0  samples/wikipedia.wacz   # pin the producer version
wacz-validator-validate --profile lenient     samples/wikipedia.wacz   # triage mode
```

Profiles only re-grade producer-specific and stylistic rules; they never
suppress a check the spec requires. See [Profiles](/wacz-validator/profiles/).

## Machine-readable output

`wacz-validator-validate` always writes JSON to stdout; there is no flag to switch.

```sh
wacz-validator-validate samples/wikipedia.wacz | jq '.summary'
```

The shape is stable and documented in [JSON report](/wacz-validator/json-report/).

## Next

- What every rule checks → [Rules](/wacz-validator/rules/)
- Archives that deliberately fail → [Corpus](https://uraitakahito.github.io/wacz-validator-corpus/)
