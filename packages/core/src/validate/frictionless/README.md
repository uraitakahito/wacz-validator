# Vendored Frictionless schema

`data-package.schema.json` は **Frictionless Data Package v1** の公式 JSON Schema
(JSON Schema **draft-04**)をそのまま取り込んだもの。

- 出所: <https://specs.frictionlessdata.io/schemas/data-package.json>
- 用途: `validate/rules/datapackage-frictionless-schema.ts`(補助ルール `datapackage/frictionless-schema`)
  が ajv で `datapackage.json` を汎用 descriptor として検証するために使う。
- 更新: `scripts/update-frictionless-schema.sh` を実行し、`git diff` を確認して commit。
  改ざん/取り込みミスは `test/frictionless-schema.test.ts` の pin テスト
  (`$schema` が draft-04 / `required` に `resources`)で検知する。

## なぜ v1 か

WACZ 1.1.1 は `datapackage.json` に `profile: "data-package"` を要求する。これは
Frictionless **v1** のプロファイル識別子。v2(datapackage.org)は `$schema` を使う
別系統なので、WACZ には v1 スキーマを当てる。

## 注意

- このスキーマは `additionalProperties: false` を持たないため、`wacz_version` /
  `mainPageURL` などの **WACZ 拡張プロパティは弾かれない**(意図どおり)。
- 一方、リソース `name` は `^([-a-z0-9._/])+$`(小文字限定)など **WACZ 1.1.1 より厳しい**
  箇所がある。そのため補助ルールは `error` ではなく **`warning`**、`lenient` profile
  では除外している。
