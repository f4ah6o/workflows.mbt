# Workflow binding の missing / duplicate エラー形式を Cloudflare local に合わせる

Status: closed
Model: gpt-6-luna max
Created: 2026-10-05
Updated: 2026-10-05
Branch: codex/20261005-workflow-binding-error-shapes
Observed baseline: `4d5224e0b4e43e5e7937539ff6bff34e171762ab`

## 概要

Workflow binding の missing / duplicate エラーメッセージが Cloudflare local と異なる。
公開用の合成 fixture と PBT で2件を再現し、最小の反例までシュリンクできている。
runtime のエラー形式を修正し、同じ PBT を GREEN にする。

## 背景

[再現テストのコミット](https://github.com/f4ah6o/workflows.mbt/commit/4d5224e0b4e43e5e7937539ff6bff34e171762ab)には、両 runtime で共用する [fixture](../../fixtures/binding-errors/observe.mjs) と [PBT](../../tests/binding-errors.pbt.test.mjs) がある。
テストは実際の binding と SQLite storage を通り、Cloudflare 側は credential-free の Wrangler local runtime を使用する。
エラー文字列の期待値は、この local runtime の観測に基づく。
hosted Cloudflare の全バージョンに対する文書化された保証としては扱わない。

## 問題

| 操作 | Cloudflare local の message | workflows.mbt の message | PBT 判定 |
| --- | --- | --- | --- |
| 存在しない ID の `get(id)` → `status()` | `instance.not_found` | `Workflow instance not found: a` | RED |
| 存在済み ID の `create({ id })` | `(instance.already_exists)` で始まる | `Workflow instance already exists: a` | RED |

現行の missing エラーは [host/engine.mjs](../../host/engine.mjs) の `requireInstance()`、duplicate エラーは [host/storage/sqlite.mjs](../../host/storage/sqlite.mjs) の `createInstance()` で生成される。
この違いにより、Cloudflare のエラーマーカーを使って分岐する一般的な呼び出しコードは、そのまま動作しない。
duplicate では `alreadyExists: true` が付くが、message の互換性は満たさない。

2026-10-05 の実行結果は、workflows.mbt が2件とも RED、Cloudflare local が各100ケース GREEN だった。
実行時のバージョンは fast-check 4.10.2、Wrangler 4.141.0、workerd 1.20260925.2。
missing の反例は `["a"]` まで2回、duplicate の反例は `["a", 2]` まで3回シュリンクした。
両方とも seed / path から再実行し、追加のシュリンクなしで最小反例を再現した。

## 目標

存在しない instance と存在済み ID の create に対する binding エラーで、検証済みの Cloudflare local message predicate を満たす。
成功する create と既存 instance の取得動作を維持する。

## 対象外

hosted differential、他の binding、Workflow 実行結果の parity、ID の全文字種、同時に初回 create した場合の原子性は対象外。
duplicate PBT は先に1件作成し、残りの create を並行実行して、存在済み ID のエラー形式を検証する。

## 提案する方針

binding 境界でのみ Cloudflare local のエラー形式へ変換する。

- missing instance は `get()` と handle 操作で `Error("instance.not_found")` として観測され、`code` と `alreadyExists` は付かない。
- duplicate `create()` は storage 内部の `alreadyExists` sentinel を検出し、`Error` message を `(instance.already_exists) Workflow instance with id "<id>" already exists` に変換する。binding caller には sentinel を公開しない。
- missing / duplicate ともに `name` は `Error`、`code` と `alreadyExists` は未設定にする。
- runtime / storage の内部エラーと REST の直接 create / missing response は維持する。REST が binding handle 経由で missing marker を受けた場合は既存の 404 message に戻す。
- PBT は pinned Cloudflare local の predicate と Error shape を維持し、期待値を緩めない。

## 受け入れ条件

- [x] missing PBT が GREEN となり、message に `instance.not_found` を含む。
- [x] duplicate PBT が GREEN となり、message が `(instance.already_exists)` で始まる。
- [x] duplicate ケースで成功数1、失敗数 `create 回数 - 1`、成功 handle の ID が維持される。
- [x] Cloudflare local の対照実行が各100ケース GREEN のまま維持される。
- [x] 関連する host / storage テストが通り、REST API の既存エラー message と削除競合時の404を確認する。
- [x] エラー形式変更の互換性と変更履歴を更新する。

## テスト計画

`npm ci` と `npm run build:core` 後、以下を実行する。

```sh
npm run test:binding-errors:pbt
WORKFLOWS_BINDING_BACKEND=cloudflare npm run test:binding-errors:pbt
npm run test:host
npm run test:storage
npm run test:e2e
```

PBT は小文字英数字の1〜100文字の ID と、2〜8回の create を生成する。
各 duplicate ケースは instance を削除し、生成時とシュリンク時の初期状態を揃える。
修正前は専用コマンドが exit 1 を返す。
default の `npm test` には追加しておらず、skip / todo / expected-failure で失敗を隠していない。

最小反例の再現コマンドは以下。

```sh
FC_SEED=20261005 FC_PATH=0:0:0 node --test --test-name-pattern='missing instance' tests/binding-errors.pbt.test.mjs
FC_SEED=20261005 FC_PATH=0:0:0:0 node --test --test-name-pattern='duplicate creates' tests/binding-errors.pbt.test.mjs
```

`FC_PATH` 指定時は該当する property のみを選択する。
generator や fast-check のバージョンを変えた場合は、実行時に出力された seed / path を使用する。
`FC_RUNS` でケース数を変更できる。
runner の詳細は [fast-check documentation](https://fast-check.dev/docs/core-blocks/runners/) を参照する。

2026-10-05 の実装検証:

- `npm ci` と `npm run build:core` が成功。
- `npm run test:binding-errors:pbt`: local backend の missing / duplicate 各100ケースが pass。
- `WORKFLOWS_BINDING_BACKEND=cloudflare npm run test:binding-errors:pbt`: pinned Cloudflare local の missing / duplicate 各100ケースが pass。
- `npm run test:host`: 24件 pass。
- `npm run test:storage`: SQLite / runtime 17件 pass。`WORKFLOWS_POSTGRES_URL` が未設定のため PostgreSQL 1件は skip。
- `npm run test:e2e`: 53件 pass。stale handle、非 missing TypeError、REST duplicate、REST 内部の削除競合を確認。

## リスク

既存のローカル利用者が現行のエラーメッセージに依存している場合、文字列変更で分岐が変わる。
内部 storage エラーを一律に変えると、Workflow binding 以外の入口にも影響し得る。
検証結果は pinned Cloudflare local の観測範囲に限定する。

## 変更履歴

`CHANGES.md` impact: yes。`CHANGES.md` の Unreleased / Fixed に変更を記録した。

## 注記

- Cloudflare local とのエラー形式比較は pinned Wrangler 4.141.0 / workerd 1.20260925.2 に限定し、hosted Cloudflare 全バージョンの保証とはしない。
- 2026-10-05: binding 境界で修正し、pinned Cloudflare local / host / storage / E2E 検証が完了したため。
- 2026-10-05: PR #21 の CI coverage gate で、PR #19 の一回限りの upstream-pin-update waiver が unused と判定された。base / branch / CI artifact の pinned candidate はすべて `pinned-68f8547cd414f5a7` で一致していたため、stale waiver のみ削除。CI artifact と base snapshot を使った gate は regressions 0、waivers matched 0 で pass し、`npm run test:coverage` も17件すべて pass。
