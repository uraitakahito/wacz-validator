---
title: Apple Container スタック
description: 共有の SeaweedFS を使って s3:// の WACZ を検証する。
---

この repo に stack file は無い。S3 API を話す [SeaweedFS](https://github.com/seaweedfs/seaweedfs)
は **crawler の repo が共有する 1 つの store**（submodule の
[seaweedfs](https://github.com/uraitakahito/seaweedfs)）で、[Apple Container](https://github.com/apple/container)
の上で [container-compose](https://github.com/Mcrich23/Container-Compose) が動かす。
archive を生成する側、つまり BrowserHive や browser は含まれない。
これが、wacz-validator が「誰が書いた WACZ か」に依存しないための土台になっている。

wacz-validator 自身も service ではない。Apple Container の compose は
subcommand が `up` / `down` / `build` / `version` の 4 つしかなく、one-shot の
service を駆動する手段が無いため。wacz-validator は host で動かすか、`container run`
で叩くかのどちらかで、両方とも以下に示す。

## 一度だけの準備

SeaweedFS の設定は submodule
([seaweedfs](https://github.com/uraitakahito/seaweedfs)) にある。browserhive と
capture-ledger と同じものを使う。clone のときに一緒に取るか、後から取る:

```sh
git clone --recurse-submodules https://github.com/uraitakahito/wacz-validator.git
# 既存の checkout なら:
git submodule update --init --recursive
```

```sh
brew install mcrich23/formulae/container-compose
sudo container system dns create crawler-storage
```

domain 名は共有 store の `docker-compose.yml` の `name:` と一致していなければならない。
これによって store が `seaweedfs.crawler-storage` として platform DNS に登録され、
**他の container からだけでなく host からも解決できる**ようになる。開発用の
container を用意していないのはこれが理由。

## store を起動する

**この repo に store は無い。** crawler の 3 つの repo が共有する 1 つの store を使う
（`wacz-validator` bucket はそこに在る）。submodule から起こす:

```sh
sh seaweedfs/scripts/stack.sh up
```

bucket は store の entrypoint 内の retry ループが作る。順序を待つ init container は無い。
bucket を使う前に master を待つ:

```sh
until curl -sf http://localhost:9333/cluster/status >/dev/null; do sleep 1; done
```

## archive を upload する

sidecar の AWS CLI container を使えば、host に何も入れずに済む:

```sh
container run --rm \
  -v "$(pwd)/samples:/samples" \
  -e AWS_ACCESS_KEY_ID=wacz-validator -e AWS_SECRET_ACCESS_KEY=wacz-validator \
  -e AWS_REGION=us-east-1 -e AWS_ENDPOINT_URL_S3=http://seaweedfs.crawler-storage:8333 \
  docker.io/amazon/aws-cli s3 cp /samples/wikipedia.wacz s3://wacz-validator/wikipedia.wacz
```

upload した archive は `http://localhost:8888/ui/index.html?bucket=wacz-validator` で
**新しい順に**並ぶ（[成果物を探す](https://uraitakahito.github.io/seaweedfs/ja/store-ui/)）。
`/buckets/wacz-validator/` の素の一覧は名前順にしか返らない。

## 検証する — host で

こちらが開発時の経路。AWS SDK の default chain を store に向けて、ビルド済みの
CLI をそのまま動かす:

```sh
unset AWS_PROFILE          # 下記参照 — profile が設定されていると負ける
export AWS_ENDPOINT_URL_S3=http://seaweedfs.crawler-storage:8333
export AWS_REGION=us-east-1
export AWS_ACCESS_KEY_ID=wacz-validator AWS_SECRET_ACCESS_KEY=wacz-validator
export WACZ_VALIDATOR_S3_FORCE_PATH_STYLE=true

./packages/validate-cli/dist/wacz-validator-validate.js s3://wacz-validator/wikipedia.wacz
```

port は loopback に publish してあるので、container 名の代わりに
`http://localhost:8333` を指しても同じように動く。

:::caution[`AWS_PROFILE` は上の変数より強い]
shell で既に `AWS_PROFILE` を export している場合 — 実際に AWS を使っている人は
そうなっている — SDK は**その profile を使い**、上の access key の組を無視する。
SSO profile だと、失敗の仕方が分かりにくい:

```
wacz-validator-validate: cannot open "s3://wacz-validator/wikipedia.wacz":
  Token is expired. To refresh this SSO session run 'aws sso login' ...
```

stack は壊れていない。request がそこまで届いていないだけ。shell で unset するか、
コマンドの前に `env -u AWS_PROFILE` を付ける。
:::

同梱の `samples/wikipedia.wacz` は既定の `spec` profile では pass する。
`--profile browserhive` では pass **しない** — webrecorder が生成した archive で
CDXJ index が gzip されており、この profile はそれを拒否するため。profile が仕事を
している状態で、詳細は[プロファイル](/wacz-validator/ja/profiles/)を参照。

## 検証する — image で

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

image の entrypoint が CLI なので、image 名より後ろはそのまま CLI に渡り、
終了コードも wacz-validator 自身のものになる。

`NODE_OPTIONS=--dns-result-order=ipv4first` が要るのは container 内で動かすとき
だけ。platform DNS は AAAA も返すが VM 間に v6 経路が無いので、Node が v6 を先に
解決すると到達できない。host 実行では不要。

## 片付ける

store は共有なので、立てたままにしておくのが普通（他の repo が使っているかもしれない）。

```sh
sh seaweedfs/scripts/stack.sh down     # 共有 store を全員のぶん止める
pnpm run store:wipe                    # あるいは、この repo の bucket だけ空にする
```

中身を消す・見る・store ごと作り直す手順は 1 か所にまとまっている:
[seaweedfs の operations](https://uraitakahito.github.io/seaweedfs/ja/operations/)。

## credential がどう wacz-validator に届くか

`AWS_ENDPOINT_URL_S3` は AWS SDK の default chain が読むので、bundled store に
向けるための専用の code path は要らない。`AWS_REGION` は SDK が要求するが
SeaweedFS 側は値を無視する。`WACZ_VALIDATOR_S3_FORCE_PATH_STYLE=true` を opt-in している
のは、virtual-hosted-style の addressing に必要な bucket subdomain の wildcard
DNS を SeaweedFS が持たないため。

この構成は bundled SeaweedFS 専用で、AWS / R2 / その他の S3 互換 service への
切り替えは現状想定していない。
