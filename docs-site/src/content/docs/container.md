---
title: Apple Container stack
description: Validate s3:// sources against the shared SeaweedFS store.
---

This repository ships no stack file. The [SeaweedFS](https://github.com/seaweedfs/seaweedfs)
that speaks the S3 API is **one store shared by the crawler repos**
([seaweedfs](https://github.com/uraitakahito/seaweedfs), a submodule here), driven by
[container-compose](https://github.com/Mcrich23/Container-Compose) on
[Apple Container](https://github.com/apple/container). Nothing in it produces archives — no
BrowserHive, no browser — which is what keeps wacz-validator loosely coupled to whatever wrote
the WACZ.

wacz-validator itself is not a service either. Apple Container's compose has
exactly four subcommands (`up`, `down`, `build`, `version`), so a one-shot
service could not be driven from it. wacz-validator runs either on your host or as a
`container run` invocation; both are below.

## One-time setup

The SeaweedFS configuration lives in a submodule
([seaweedfs](https://github.com/uraitakahito/seaweedfs)), shared with
browserhive and capture-ledger. Clone with it, or fetch it afterwards:

```sh
git clone --recurse-submodules https://github.com/uraitakahito/wacz-validator.git
# or, in an existing checkout:
git submodule update --init --recursive
```

```sh
brew install mcrich23/formulae/container-compose
sudo container system dns create crawler-storage
```

The domain name must match the `name:` in the shared store's `docker-compose.yml`. That is what
registers the store as `seaweedfs.crawler-storage` with the platform DNS and makes
it resolvable **from the host as well as from other containers** — the reason
there is no development container here.

## Start the store

**There is no store in this repo.** The three crawler repos share one, and the `wacz-validator`
bucket lives in it. Start it from the submodule:

```sh
sh seaweedfs/scripts/stack.sh up
```

The bucket is created by a retry loop inside the store's own entrypoint. There is no init
container to sequence. Wait for the master before using the bucket:

```sh
until curl -sf http://localhost:9333/cluster/status >/dev/null; do sleep 1; done
```

## Upload an archive

A sidecar AWS CLI container keeps this working without installing anything on
the host:

```sh
container run --rm \
  -v "$(pwd)/samples:/samples" \
  -e AWS_ACCESS_KEY_ID=wacz-validator -e AWS_SECRET_ACCESS_KEY=wacz-validator \
  -e AWS_REGION=us-east-1 -e AWS_ENDPOINT_URL_S3=http://seaweedfs.crawler-storage:8333 \
  docker.io/amazon/aws-cli s3 cp /samples/wikipedia.wacz s3://wacz-validator/wikipedia.wacz
```

Uploaded archives are browsable at `http://localhost:8888/buckets/wacz-validator/`.

## Validate — on the host

This is the development path. Point the AWS SDK's default chain at the store
and run the CLI you already built:

```sh
unset AWS_PROFILE          # see below — a set profile wins over these
export AWS_ENDPOINT_URL_S3=http://seaweedfs.crawler-storage:8333
export AWS_REGION=us-east-1
export AWS_ACCESS_KEY_ID=wacz-validator AWS_SECRET_ACCESS_KEY=wacz-validator
export WACZ_VALIDATOR_S3_FORCE_PATH_STYLE=true

./packages/validate-cli/dist/wacz-validator-validate.js s3://wacz-validator/wikipedia.wacz
```

`http://localhost:8333` works just as well as the container name, since the
ports are published on the loopback address.

:::caution[`AWS_PROFILE` outranks these variables]
If your shell already exports `AWS_PROFILE` — anyone with a real AWS setup
does — the SDK uses **that profile** and ignores the access key pair above.
With an SSO profile the failure is confusing rather than obvious:

```
wacz-validator-validate: cannot open "s3://wacz-validator/wikipedia.wacz":
  Token is expired. To refresh this SSO session run 'aws sso login' ...
```

Nothing is wrong with the stack; the request never went to it. Unset the
variable for the shell, or prefix the command with `env -u AWS_PROFILE`.
:::

The bundled `samples/wikipedia.wacz` passes under the default `spec` profile.
It does **not** pass `--profile browserhive`: it was produced by webrecorder
and has a gzipped CDXJ index, which that profile rejects. That is the profile
doing its job — see [Profiles](/wacz-validator/profiles/).

## Validate — in the image

```sh
container build -t wacz-validator:latest .

container run --rm \
  -e AWS_ENDPOINT_URL_S3=http://seaweedfs.crawler-storage:8333 \
  -e AWS_REGION=us-east-1 \
  -e AWS_ACCESS_KEY_ID=wacz-validator -e AWS_SECRET_ACCESS_KEY=wacz-validator \
  -e WACZ_VALIDATOR_S3_FORCE_PATH_STYLE=true \
  -e NODE_OPTIONS=--dns-result-order=ipv4first \
  wacz-validator:latest s3://wacz-validator/wikipedia.wacz
```

The image's entrypoint is the CLI, so everything after the image name is passed
straight to it, and the exit code is wacz-validator' own.

`NODE_OPTIONS=--dns-result-order=ipv4first` is needed only inside a container:
the platform DNS publishes AAAA records but there is no v6 route between the
VMs, so Node resolving v6 first would reach nothing. On the host it is
unnecessary.

## Tear down

The store is shared, so leaving it up is usually what you want — other repos may be using it.

```sh
sh seaweedfs/scripts/stack.sh down     # stops the shared store for everyone
pnpm run store:wipe                    # or: empty this repo's bucket and leave it up
```

Emptying it, looking inside, and recreating it from scratch are documented in one place:
[seaweedfs's operations page](https://uraitakahito.github.io/seaweedfs/operations/).

## How the credentials reach wacz-validator

`AWS_ENDPOINT_URL_S3` is read by the AWS SDK's default chain, so pointing
wacz-validator at the bundled store needs no code path of its own. `AWS_REGION` is
required by the SDK and ignored by SeaweedFS. `WACZ_VALIDATOR_S3_FORCE_PATH_STYLE=true`
is opt-in because SeaweedFS has no wildcard DNS for bucket subdomains, which is
what virtual-hosted-style addressing needs.

The configuration is written for the bundled SeaweedFS. Pointing it at AWS, R2
or another S3-compatible service is not currently a supported setup.
