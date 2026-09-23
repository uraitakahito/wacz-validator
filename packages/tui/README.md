# @wacz-validator/tui

WACZ validation 用の interactive な terminal UI。

## CLI: `wacz-validator`

```sh
wacz-validator --help
# spec (default) | browserhive | lenient
wacz-validator FILE --profile PROFILE
# version + 短い git SHA(古いプロセスの取り違え防止)
wacz-validator --version   # 例: 0.0.0 (9f3c2a1)
```

## ヘッダのバージョン表示と SHA 不一致の警告

ヘッダ行には TUI 自身のビルドの短い git SHA を出す(未コミット変更があれば
`-dirty`)。起動時に `wacz-validator/ping` で daemon の SHA も取得し、両者が食い違う —
つまり**描画(TUI)か検証(daemon)のどちらかが古いプロセス**のときは
`⚠ daemon ·<sha>` を警告色で添える。

```
wacz-validator 0.0.0 ·9f3c2a1                       … 一致(正常)
wacz-validator 0.0.0 ·9f3c2a1 ⚠ daemon ·1b8e4d0     … 不一致(どちらか古い → 再起動)
```

ビルドしてもプロセスを起動し直すまで古いコードがメモリに残る件は
[`build → quit → relaunch`](https://github.com/uraitakahito/wacz-validator) の運用で回避する。

## 画面の歩き方

`tab` で Issues と Layout を行き来する。Layout は WACZ の §5.1 風の木で、ファイルを選んで
`enter` を押すと、その中身を daemon の窓の口で取って全幅に開く:

- 行の窓 (`readLines`) —— 500 行ずつ。末尾に着くと続きを頼む。長い行は端末幅で切れる
- `enter` で 1 行を丸ごと (`readLine`) —— CDXJ / JSONL は daemon が field に割って返す
  (tui は割り方を持たない)。`↑↓` でそのまま前後の行へ
- `.warc.gz` は `enter` でレコードの一覧 (`readRecords`) —— ▪ は索引 (CDXJ) が指すレコード、
  ▫ は索引に無いもの (撮らなかった・撮れなかった記録はこちら)。`enter` で 1 レコード
  (`readRecord`)。画像は大きさだけ (端末では出せない)
- `esc` で 1 つ戻る、`q` で終わる

かつての `readEntry` (丸ごと読んで 64 KiB で切る) は無い —— 大きい WACZ では索引の 2 割
しか見えず、切れた行は割れなかった。

## 実際の WACZ で試す

Webrecorder が
[`webrecorder/example-webarchive`](https://github.com/webrecorder/example-webarchive)
に小さい example archive を公開していて、これを直接検証できる:

```sh
mkdir -p /tmp/wacz-validator-demo
curl -sL \
  https://raw.githubusercontent.com/webrecorder/example-webarchive/main/items/wikipedia/archive.wacz \
  -o /tmp/wacz-validator-demo/wikipedia.wacz

wacz-validator /tmp/wacz-validator-demo/wikipedia.wacz
```

rule ごとの失敗例や profile 差を試せる WACZ 標本(20 本)は
[wacz-validator-corpus](https://github.com/uraitakahito/wacz-validator-corpus) にある。入手方法と
全標本のカタログは
[事例カタログ](https://uraitakahito.github.io/wacz-validator/ja/corpus/)
を参照。

## License

[Unlicense](https://github.com/uraitakahito/wacz-validator/blob/main/LICENSE).
