# Dockerfile — wacz-validator の image (常駐の daemon と、1 回きりの検証 CLI)
#
# 段は 4 つ:
#   1. builder — 全部を install し、daemon と validate-cli (と、その依存の workspace package) を build する
#   2. deps    — prod の依存だけを、空の段に hoisted で入れる。manifest と lockfile だけを写す
#   3. daemon  — 常駐の検証 daemon。deps に builder の dist を重ねる
#   4. cli     — 1 回きりの検証 CLI。**最後の段** なので、target を書かない build はこれを建てる
#
# ## prod の依存を、なぜ別の段で入れるか
#
# - `pnpm deploy` は使えない。pnpm 11 は `inject-workspace-packages` の無い workspace からの
#   deploy を断り、`--legacy` で通すと、workspace の依存 (core・contract・protocol) が元の
#   repo への symlink のまま残る —— 別の段へ写すと切れる (2026-10-12 に実測)。
# - builder の中で `pnpm install --prod` に組み替えない。dev 依存ごと書き換える層の commit で、
#   Apple Container のビルダが無言で固まる (wacz-signer で実測)。
#
# ## Node と pnpm の版
#
# base は .nvmrc と同じ Node 24。pnpm は corepack が package.json の packageManager から
# 選ぶので、ここに版を書かない。Node 25 からは corepack が同梱されないので、base を上げる日は
# pnpm の入れ方も一緒に変えること。
#
# ## 版
#
# build context に .git を入れない (Dockerfile.dockerignore) ので、報告と /healthz の版は
# `unknown`、gitSha は `nogit` になる (scripts/build-version.mjs)。
#
# 開発用の別 image は無い。Apple Container のプラットフォーム DNS は
# `seaweedfs.crawler-storage` (crawler が共有する store) を *ホストからも* 解決させるので、
# 開発時は host の pnpm で普通に動かせばよい。
#
# Build / run (CLI):
#   container build -t wacz-validator:latest .
#   container run --rm \
#     -e AWS_ENDPOINT_URL_S3=http://seaweedfs.crawler-storage:8333 -e AWS_REGION=us-east-1 \
#     -e AWS_ACCESS_KEY_ID=wacz-validator -e AWS_SECRET_ACCESS_KEY=wacz-validator \
#     -e WACZ_VALIDATOR_S3_FORCE_PATH_STYLE=true \
#     -e NODE_OPTIONS=--dns-result-order=ipv4first \
#     wacz-validator:latest --profile browserhive s3://wacz-validator/foo.wacz
#
# Build / run (daemon):
#   container build --target daemon -t wacz-validator-daemon:latest .
#   container run --rm -p 127.0.0.1:7180:7180 wacz-validator-daemon:latest
#
# container-compose のサブコマンドは up / down / build / version の 4 つだけで
# `run` が無いため、1 回きりの CLI は compose service ではなく `container run` で叩く。
# 常駐の daemon を compose で起こすなら、image を `container build --target daemon` で先に建て、
# compose からは `image:` で指す。container-compose 1.2.0 は `build.target` を無視して最後の段
# (CLI) を建てる (2026-10-13 に dashboard のサンドボックスで実測)。
#
# TUI (`wacz-validator` bin) は、この image に入れない。

# ---------------------------------------------------------------------------
# Stage 1: builder
# ---------------------------------------------------------------------------
FROM node:26-bookworm-slim AS builder

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

WORKDIR /build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter "@wacz-validator/daemon..." --filter "@wacz-validator/validate-cli..." build

# ---------------------------------------------------------------------------
# Stage 2: deps — prod の依存だけ
# ---------------------------------------------------------------------------
FROM node:26-bookworm-slim AS deps

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

WORKDIR /app
# 全部の package の manifest を写す。入れない package (tui・devtools) も、lockfile と
# workspace の形を揃えておくために要る。
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/contract/package.json packages/contract/
COPY packages/core/package.json packages/core/
COPY packages/daemon/package.json packages/daemon/
COPY packages/devtools/package.json packages/devtools/
COPY packages/protocol/package.json packages/protocol/
COPY packages/tui/package.json packages/tui/
COPY packages/validate-cli/package.json packages/validate-cli/
# hoisted にするのは、既定の symlink の行き先 (pnpm のストア) が次の段に無いため。
RUN pnpm install --prod --frozen-lockfile --node-linker=hoisted \
      --filter "@wacz-validator/daemon..." --filter "@wacz-validator/validate-cli..."

# ---------------------------------------------------------------------------
# Stage 3: daemon — 常駐の検証 daemon
# ---------------------------------------------------------------------------
FROM node:26-bookworm-slim AS daemon

WORKDIR /app
COPY --from=deps /app ./
COPY --from=builder /build/packages/contract/dist packages/contract/dist
COPY --from=builder /build/packages/core/dist packages/core/dist
COPY --from=builder /build/packages/protocol/dist packages/protocol/dist
COPY --from=builder /build/packages/daemon/dist packages/daemon/dist

USER node
ENV NODE_ENV=production
# コンテナの中では外向きに待つ。host に出す口は、呼ぶ側が publish で決める
# (例: -p 127.0.0.1:7180:7180)。
ENV WACZ_VALIDATOR_DAEMON_HOST=0.0.0.0 WACZ_VALIDATOR_DAEMON_PORT=7180
EXPOSE 7180
ENTRYPOINT ["node", "packages/daemon/dist/cli.js"]

# ---------------------------------------------------------------------------
# Stage 4: cli — 1 回きりの検証 CLI (最後の段 = target を書かない build の既定)
# ---------------------------------------------------------------------------
FROM node:26-bookworm-slim AS cli

WORKDIR /app
COPY --from=deps /app ./
COPY --from=builder /build/packages/contract/dist packages/contract/dist
COPY --from=builder /build/packages/core/dist packages/core/dist
COPY --from=builder /build/packages/validate-cli/dist packages/validate-cli/dist

USER node
ENV NODE_ENV=production
# 引数 (`<source>` + `--profile` 等) は呼び出し側で渡す:
#   container run --rm wacz-validator:latest --profile browserhive s3://bucket/key.wacz
ENTRYPOINT ["node", "packages/validate-cli/dist/wacz-validator-validate.js"]
