# Workflow binding の missing / duplicate エラー形式を Cloudflare local に合わせる

Status: open
Model: unknown
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

binding から観測されるエラーを Cloudflare local に合わせる。
内部エラーの変更か binding 境界での変換かは、REST API や storage 呼び出しへの影響を確認して決める。
message に加え、name、code、alreadyExists の扱いを確認する。
PBT の期待値を現行 runtime のエラーに合わせて緩めることはしない。

## 受け入れ条件

- [ ] missing PBT が GREEN となり、message に `instance.not_found` を含む。
- [ ] duplicate PBT が GREEN となり、message が `(instance.already_exists)` で始まる。
- [ ] duplicate ケースで成功数1、失敗数 `create 回数 - 1`、成功 handle の ID が維持される。
- [ ] Cloudflare local の対照実行が各100ケース GREEN のまま維持される。
- [ ] 関連する host / storage テストが通り、REST API のエラーへの影響を確認する。
- [ ] エラー形式変更の互換性と変更履歴を更新する。

## テスト計画

`npm ci` と `npm run build:core` 後、以下を実行する。

```sh
npm run test:binding-errors:pbt
WORKFLOWS_BINDING_BACKEND=cloudflare npm run test:binding-errors:pbt
npm run test:host
npm run test:storage
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

## リスク

既存のローカル利用者が現行のエラーメッセージに依存している場合、文字列変更で分岐が変わる。
内部 storage エラーを一律に変えると、Workflow binding 以外の入口にも影響し得る。
検証結果は pinned Cloudflare local の観測範囲に限定する。

## 変更履歴

`CHANGES.md` impact: yes

項目案：

- Workflow binding の missing / duplicate エラーメッセージを Cloudflare local と互換にし、エラーマーカーによる判定を可能にする。

## 注記

- 2026-10-05: 再現 PBT は実装済み。runtime の修正は未着手のため open とする。
- Model は正確な実行モデル識別名を確認できないため unknown とする。
