# Roadmap: MoonBit互換ランタイム → MoonBitで書けるIR → JS ↔ MoonBit

Status: open
Model: gpt-6
Created: 2026-10-10
Updated: 2026-10-10
Branch: docs/runtime-ir-js-mbt-roadmap
Kind: design roadmap / phased implementation
Baseline: `main` @ `49c71e02b0d2343d252a115dbc7820fbf4a1ae53`
Scope: 設計・実装順序・受入条件。今回のPRは文書のみで、新しいランタイム機能・SDK・IR・変換器は未実装。

## 概要

Cloudflare Workflows用の既存TS/JSを無改変で実行するフォールバックを維持しながら、(1) MoonBit-first互換ランタイムの責務を固定し、(2) MoonBitの型付きbuilderからcanonical Flow IRを生成・ローカル実行し、(3) JSとMoonBitの相互呼び出し・双方向の対応subset変換へ進むロードマップ。

これは**横断的な親issue**であり、P0〜P5をこのPRで一括実装する指示ではない。最初に実装へ着手できる単位はP0の互換性baseline/profileの確定と、P1のkernel/host責務・Command/Event契約の整理。各Phaseは専用PRで、その受入証拠を揃えてから完了とする。

## 背景

### 現在地と既存課題

1. [現行README](../../README.md)には、無改変TS/JSを受けるcompatibility host、MoonBit durable kernel、SQLite/PostgreSQL storage bridge、replay、retry、timer、event、crash/restartテスト、pinned/latest oracleが記載されている。①はゼロから作り直す段階ではない。一方、storage/scheduler側にも状態遷移の実装があるため、すべてのdurable処理が既にMoonBitだけで完結すると表現しない。
2. 2026-10-10に確認した[PR #20](https://github.com/f4ah6o/workflows.mbt/pull/20)はopen・未マージ。PR本文はoracle起動修正後にも`createBatch`契約とentrypoint contextの差分が残ると報告している。これはPR側の報告であり、本ロードマップ作成時にテストを再実行した結果ではない。
3. latestの復旧・差分分類は[既存の追跡課題](20261002-cf-latest-oracle-esm-and-workflow-contract-drift.md)、hosted canary等の運用条件は[upstream tracking課題](20260928-upstream-tracking-pipeline.md)を参照する。重複した修正issueは作らない。
4. 内部のMoonBit JS出力とhostの接続は既存構成に含まれる。以下の公開SDK、Flow IR、変換器は新しい計画として扱い、既存の内部FFIと混同しない。
5. PostgreSQLについては[README](../../README.md#configuration)が利用方法を記載する一方、[COMPATIBILITY.md](../../COMPATIBILITY.md#known-differences)には「SQLiteのみ実装・検証済み」と残る。両文書の主張は一致していない。実装・テスト・CI evidenceを確認するまでは、PostgreSQLの互換性を確定事実にしない。

## 問題

1. 無改変JS/TSの互換実行はすでに存在するが、pinned/latest/hostedの検証レベルは異なり、「ソースが動く」「upstreamと意味が一致する」「運用中instanceを移せる」を同じ互換性保証として扱えない。
2. MoonBitでworkflowを定義して同じdurable kernelを使う公開builder/IR経路がなく、Flow IRを導入するとretry・永続化・replayの第二実装が生まれる危険がある。
3. JS↔MoonBitの内部FFIは、型付きの公開action契約、artifact固定、error分類、再起動後のActionRef解決を保証しない。双方向変換についても任意のJS callbackをMoonBitへ安全に置換できる前提は成り立たない。
4. 既存instanceのidentity・履歴・commit原子性が新しいIRやcodecによって暗黙に変化すると、クラッシュ後の再実行や副作用が増える恐れがある。

## 目標

| 軸 | 到達点 | 完成の意味 |
| --- | --- | --- |
| 1. mbtによる互換ランタイム | 既存のCloudflare Workflows向けTS/JSを無改変で独立実行する | 対象profileのAPI・durable semanticsを継続的な差分検証で保証する |
| 2. mbtで書けるIR | MoonBitの型付きbuilderでワークフローを記述し、共通Flow IRを生成・検証・実行する | JSON手書きや専用文字列DSLを必須にせず、MoonBitからローカル実行まで到達する |
| 3. js ↔ mbt | 相互呼び出しと、IRを介したワークフローの双方向変換を提供する | MoonBit記述をJS/Cloudflareへ出力し、対応するJS/TS記述をMoonBitへ取り込める |

最終形は「実行場所と言語を独立に選べる」こと。ただし、ソースの移植性と、実行途中のCloudflare instanceの状態移行は別問題とする。Cloudflareへの依存を安心して継続するためのfallbackという位置付けを維持し、Workersプラットフォーム全体の再実装には広げない。

## 対象外

- Workersプラットフォーム全体の再実装、Cloudflare固有の地理配置・アカウント制限の完全再現。
- Cloudflare上で実行中のinstanceをローカルへ透過的に移すこと、JS VM stack・Promise・closureをそのまま永続化すること。
- 任意のJavaScript/TypeScriptコードを完全自動で純MoonBitへ変換すること。対応subset外は診断し、無改変JS実行経路を残す。
- このロードマップPRでのランタイムコード変更、PR #20のapprove/merge、oracle pinの更新、既存DB schemaの無審査変更。
- GUI編集、類似workflow抽出、native/Wasm host、別プロセスRPC、multi-host scheduler（個別提案があるまで後続候補に留める）。

## 提案する方針

既存のCloudflareソース互換性を最上位制約とする。Phaseごとに契約、example fixture、positive/negative case、クラッシュ再開、oracle差分を揃える。Flow IRは**定義**、Command/Eventは**実行要求**、履歴は**実行済みの事実**として区別する。

### 目標アーキテクチャ

```text
既存のCloudflare向けTS/JS（無改変）
  -> JS compatibility host --------------------+
                                               |
MoonBitの型付きworkflow builder                |
  -> canonical Flow IR                         |
     -> MoonBit IR evaluator ------------------+
                                               v
                                  Command / Event契約
                                               |
                                               v
                                  MoonBit durable kernel
                                               |
                                               v
                                  storage / clock / I/O bridge

同じFlow IR
  -> Cloudflare向けJS/TS emitter
     + MoonBit actionの公式JSコンパイル出力
     -> 薄いWorkflowEntrypoint adapter
     -> Cloudflare Workflows

対応範囲のJS/TS -> importer -> Flow IR <-> MoonBit builder source
JS action      <---- typed interop ----> MoonBit action
```

1. 無改変JS実行に静的なJS→IR変換を必須にしない。変換器が未対応のワークフローも、従来のcompatibility host経路を利用できる。
2. Flow IRはプログラム定義、Command/Event契約は実行要求・結果、永続履歴は実行済みの事実。それぞれ別の型・schema・versionとして管理する。実行traceを全分岐を含むプログラムIRと見なさない。
3. ローカルのdurableな判断はMoonBit kernelに集約する。IR evaluatorやJS SDKに第二のretry/scheduler/persistence engineを作らない。Cloudflare向け出力では実際のCloudflare `step` APIにdurabilityを委譲し、自前kernelやローカルDBを持ち込まない。
4. IR型、検証、意味解析・lowering、emitterをMoonBit中心で実装する。JS/TSの構文解析に外部parserを使う場合はbuild-time adapterに限定し、そのJSON ASTを内部契約として固定する。JS側にdurable semanticsを移さない。

### 実装順序と完了ゲート

日程ではなく受入条件で進める。P0/P1の互換性保守は以後も継続する。P2の型・schema設計は並行可能だが、公開実行機能は基盤の受入後に出す。

| Phase | 対応する軸 | 成果物 | 次へ進む条件 |
| --- | --- | --- | --- |
| P0 | 1 | 現行互換性の基準・latest差分の分類 | 対象profileのpinned検証成立。latestの成功・差分・証拠不足を区別できる |
| P1 | 1 | MoonBit kernelとhostの契約の安定化 | 既存source・永続状態・crash/restartの回帰なし |
| P2 | 2 | Flow IR v1、型付きbuilder、ローカルevaluator | MoonBit記述の最小workflowが永続実行・再開できる |
| P3 | 3a | JS ↔ MoonBitの公開action bridge | 両方向の呼び出し、値、例外、再起動時の解決が一致する |
| P4 | 3b | MoonBit/IR → Cloudflare向けJS/TS | 同じMoonBit定義をローカルとCloudflare oracleで差分検証できる |
| P5 | 3c | JS/TS → IR → MoonBit、round-trip | 対応subsetで意味保存が成立し、未対応箇所を診断できる |

#### P0. 現行互換性を基準化する

1. PR #20の変更と残存課題をレビュー・受入の対象にする。ロードマップ作成だけでapprove/mergeやpin更新を行わない。
2. API/type drift、実際のsemantic drift、upstreamの取得・起動失敗を分離する。起動失敗や欠測を互換性PASSにしない。
3. `compat/capabilities.json`と`COMPATIBILITY.md`を根拠として、対象API、oracle revision、compatibility date/flags、実測した範囲を固定する。Cloudflare最新全体の一致をP2設計の無期限の前提にせず、未解消差分を明示した検証済みprofileから進める。

受入: `compat:pinned`と対象回帰テストがPASS。`compat:latest`は完全なcandidate-bound evidenceで判定され、差分があればopenのまま残す。Cloudflare本番の検証はhosted canaryを実行した範囲だけ認定する。

#### P1. MoonBit互換ランタイムの責務を安定化する

1. step identity、replay、retry/backoff、deadline、event選択、pause/terminate/restart、並列・compensationの規則と、その現在の実装場所を棚卸しする。規則の重複をMoonBitへ段階的に寄せ、JSにはcallback実行とOS/DBアクセスのmechanismを残す。
2. version付きCommand/Event契約を定義し、既存の単純なkernel呼出しから小さく移行する。SQL transaction、lease、fencing、atomic commitはstorage contractとして維持し、MoonBit化だけを理由に非atomicな分割をしない。
3. replay-firstを維持する。JS VM stackやPromiseを保存しない。既存DBを黙って新しいidentity/schemaで解釈し直さず、必要なmigrationは別の検証付き変更とする。

比較するobservable traceは、少なくともstepの`(type,name,count)`、順序・完了結果、retry attempt、timer/eventの消費、終端状態・error分類を含む。壁時計時刻、PID、内部UUIDなどの非決定的な値だけを明示的に正規化する。正規化ルールは対応する実装PRのfixtureで固定する。

受入: 同じ無改変TS/JS fixtureで変更前後のobservable traceが一致する。SQLiteとPostgreSQLの契約、並列branch、event待ち、retry中、commit境界のprocess crashで回帰がない。MoonBit-onlyの規則テストとhost境界テストを分けて実行する。

#### P2. MoonBitで書けるFlow IRを作る

1. `Flow`、`Node`、`Expr`、`ActionRef`、`ValueSchema`をMoonBitの型で定義する。builderは型付きの入力・step出力参照からIRを構築し、永続化前に型を消した表現を検証する。任意のMoonBit関数・closureを丸ごとIRに保存する方式にはしない。
2. 最初のvertical sliceは`Sequence`、`Do`、`Sleep`、`SleepUntil`、`WaitForEvent`、`Return`、`Fail`。stepのretry/timeout/non-retryable errorは既存kernelの契約を使う。次に`If`、決定的な`ForEach`、`ParallelAll`、`Try/Catch/Finally`を、個別のsemantic testとともに追加する。race/anyやcompensationは表現と再実行規則の検証後に対応する。
3. JSONを交換形式にしたversion付きcanonical IRとvalidatorを作る。初期のportable value profileはJSON互換値から始め、非対応値を黙って文字列化・切捨てしない。既存JS互換経路のstructured value対応は縮小しない。
4. 最小action registryとevaluatorを同梱してローカル実行まで通す。再開時は同じ固定版のIRを先頭から評価し、完了stepの結果を再利用する。IR専用の別checkpoint engineは作らない。

設計fixture例（新SDKの確定APIではない）: 入力 `{"orderId":"order-1"}` を受け、`Do(reserve)` → `Sleep` → `WaitForEvent(approved)` → `Do(finalize)` → `Return({"orderId":"order-1","approved":true})` と進む。各Doはversion付き`ActionRef`を持ち、sleep/eventの途中で再起動してもコミット済みstepのcallbackは再呼出ししない。外部effect完了後・commit前のクラッシュはat-least-onceとして別の冪等性テストにする。

受入: `.mbt`で定義した`do -> sleep -> waitForEvent -> do -> return`がCLIから実行でき、sleep中・event待ち中にSIGKILLしても同じDBから再開する。IRのencode/decode、未知version、不正参照、型不一致、非対応operationにpositive/negative testがある。

#### P3. JS ↔ MoonBitの相互呼び出しを公開する

1. JS workflowからMoonBit actionを、MoonBit/IR workflowからJS actionを呼べるtyped bridgeを作る。まず同一JS host内のFFIを使い、remote RPCやnative ABIは必須にしない。
2. 入出力schema、非同期完了、例外、NonRetryableError、timeout、取消要求と実際の取消可否を契約化する。通常のPromise待機をdurableなsleep/event待ちの代用にしない。JS `number`とMoonBit整数の範囲差を含め、暗黙の精度損失を拒否する。
3. `ActionRef`をmodule/export、artifact digest、codec versionで解決する。永続化するのは参照とserializableな引数・結果であり、関数pointerやprocess内のcallback IDではない。プロセス再起動時にregistryを再構築できるようにする。

受入: 両方向に同じ値・error分類が渡る。MoonBit actionとJS actionを混在させたworkflowがreplayできる。missing action、artifact不一致、codec不一致はside effect実行前に明示的に失敗する。bytes/Int64/Date等の拡張は個別codecと対応profileを追加してから認定する。

[MoonBitの公式FFI](https://docs.moonbitlang.com/en/stable/language/ffi.html)にはJS target、関数のimport/export、ABIの境界が記載されている。[公式asyncドキュメント](https://docs.moonbitlang.com/en/stable/language/async-experimental.html)にはJS Promiseとの接続がある。ただし、その機能がリポジトリの固定toolchainで利用できるかを実装時に検証し、必要な更新は別途扱う。通常のFFI/asyncの成立だけではdurabilityを保証しない。

#### P4. MoonBit → JS/Cloudflareを成立させる

1. Flow IRから`WorkflowEntrypoint.run(event, step)`と実際の`step`呼出しを生成する。action本体がMoonBitなら公式compilerのJS targetでコンパイルしてbundleへ含める。IRからのworkflowコード生成と、汎用MoonBitコードのJSコンパイルを区別する。
2. ローカルとCloudflareのbackend adapterを分ける。同じ定義から両方へbuildし、Cloudflare用bundleへNode、SQLite、ローカルscheduler等が混入しないことを検査する。env/bindingsはruntimeで注入し、secretをIRやartifactに埋め込まない。
3. source mapとnode/source位置の対応を出力する。生成JSを手修正する運用にせず、MoonBit/IRを正本にする。profileで対応していないoperation・bindingをbuild時に拒否する。

受入: 同じMoonBit定義のIRをローカルで実行した結果と、生成JSをCloudflare `cf dev` oracleで実行した結果が一致する。outputだけでなく、step identity、retry、event、error分類、再開後のcallback非再実行も比較する。hosted未実行なら本番互換性は未検証と明記する。

#### P5. JS/TS → IR → MoonBitと双方向変換を成立させる

1. まず静的に解析できる`WorkflowEntrypoint.run`、await付きstep呼出し、入力・前step出力参照、決定的な条件分岐・有限反復を対応subsetにする。対応grammarとeffect制約を文書化してからimporterを実装する。TSの型が不足する箇所はschema指定を要求し、推測だけで型安全を宣言しない。
2. orchestrationとaction本体を別に扱う。変換できる制御構造はFlow IRへloweringし、任意のJS callbackをそのまま純MoonBitへ変換したと扱わない。callbackをJSとして保持する場合は、解決可能なActionRefと明示的なcapture schemaを生成し、再起動後に再構築できることを必須にする。
3. canonical IRから読み書きできるMoonBit builder sourceを生成する。安全なpure expression/actionの変換subsetを拡張し、JSを残すhybrid出力と、JS actionを残さない`mbt-only-source`出力を区別する。後者は残存JS actionがあれば失敗する。`mbt-only-source`はソース言語の保証であり、JS host不要という保証ではない。
4. `eval`、動的import、未知の高階制御、可変closure capture、非決定的なstep名・制御等は、変換対応がない限り位置・理由・対処を診断する。無改変JS実行経路は引き続き残す。AST変換や1回の実行traceだけで全分岐の変換成功と判定しない。

受入: 対応subsetで`JS -> IR -> MoonBit -> IR -> JS`の正規化IRとobservable behaviorが一致する。コメント・空白・元の構文の完全復元は保証対象にしない。未対応入力で無言の意味変更がなく、診断テストがFAILを正しく確認する。通常実行だけでなく異なる分岐、error、event、crash/replayを含めて比較する。

### IR・再開互換性の固定条件

| 項目 | 設計条件 |
| --- | --- |
| 定義と履歴 | Flow IRに実行履歴を混在させない。履歴だけから未通過分岐を復元しない |
| identity | `node_id`は明示的かつ安定。既存の`(instance_id, step_type, step_name, step_count)`へのmappingを固定し、行番号や配列位置だけに依存しない |
| loop / parallel | 反復・branchで同名stepのcountと結果参照がreplay時にも安定する。正規化で観測可能な順序を消さない |
| program version | IR schema、workflow定義digest、action artifact、codecをinstanceへ紐付ける。稼働中instanceは固定artifactで再開し、不一致時はfail-closed。自動で最新版へ付替えない |
| 値とeffects | 純粋な式は再評価可能とし、非決定的処理・外部副作用はstep境界内へ置く。persistent valueと一時的なhost handleを区別する |
| 配送保証 | callbackはat-least-once。外部API成功後・result commit前のcrashでは再実行し得る。冪等キーを業務側で扱い、exactly-onceの外部副作用を約束しない |
| 検証と安全性 | 未知opcode/version、schema不整合、過大なIRを実行前に拒否。graph/反復の予算を定義する。任意コードを安全に実行するsandboxの提供とは別問題とする |

これらは[現行durable model](../../README.md#current-durable-model)と、Cloudflareの[Rules of Workflows](https://developers.cloudflare.com/workflows/build/rules-of-workflows/)にある再実行・副作用・決定性の制約を維持するための条件である。Cloudflareから実行途中の状態を透過的に移す機能は含めない。

### パッケージとPRの分割案

同一リポジトリ内で開始する。以下の新規pathは配置案であり、この文書変更では作成しない。

| 領域 | 既存／提案path | 責務 |
| --- | --- | --- |
| Kernel | 既存`src/core/` | durableな判断とCommand/Event契約 |
| IR | 提案`src/ir/` | 型、codec、validator、evaluator |
| SDK | 提案`src/sdk/` | MoonBitの型付きworkflow builder |
| Interop | 提案`src/interop/` | action ABI、schema、error変換 |
| Translation | 提案`src/importer/`、`src/codegen/` | JS/TS取込、IR lowering、JS/MoonBit出力 |
| Host | 既存`host/`、`compat/` | callback/I/O、Cloudflare adapter、差分検証 |

最初の実装は次の単位に分ける。

1. 既存PR #20とlatest差分の追跡を進め、受入可能なbaseline/profileを確定する。
2. kernel/hostの責務表とCommand/Event契約を追加し、1種類のstepから既存テスト付きで移行する。
3. Flow IR v1の型・codec・validatorとnegative testを追加する。SDK案はコンパイル可能なfixtureで確認する。
4. 最小builder・action registry・evaluatorを追加し、`do -> sleep -> waitForEvent -> do`をSIGKILL/restartまで通す。
5. 公開interopを追加してJS/MoonBit混在actionを検証する。その後にCloudflare emitter、JS importerの順で進める。

UI編集、類似workflow抽出、別プロセスRPC、native/Wasm host、multi-host schedulerはこの順序の前提にしない。IR確立後の別ロードマップとして扱う。

## 受け入れ条件

以下は各実装PRの完了ゲートであり、ロードマップの記載だけでチェック済みにしない。詳細なAPI/profile/エラーの許容範囲は上記P0〜P5の受入段落に従う。

- [ ] **P0 / 互換性の根拠** — Given pinned profileとlatest candidateが明示されている、when `npm run compat:pinned`と`npm run compat:latest`を実行する、then pinnedの合否とlatestの`compatible`・drift・取得/起動失敗・証拠不足を別々に判定できる。latest失敗をPASSへ置き換えず、hosted未実行は未検証と記録する。
- [ ] **P1 / kernel境界** — Given既存の無改変TS/JS fixturesと固定DB、when新Command/Event契約へ1種類のstepを移行して通常実行・commit境界のSIGKILL/restartを行う、then比較対象のobservable traceと保存済みstep結果が従来と一致し、lease/fencing/atomic commitを壊さない。
- [ ] **P2 / MoonBit builder→IR→実行** — Given型付き`.mbt`定義、固定IR/action artifactおよび有効なevent、when`do → sleep → waitForEvent → do → return`をCLI経由で実行・途中SIGKILL・同じDBから再開する、then完了値が一致し、コミット済みcallbackは再実行されない。未知schema、破損参照、型不一致は実行前に拒否される。
- [ ] **P3 / JS↔MoonBit bridge** — GivenJS/MoonBitの混在actionと版付き`ActionRef`、when両方向を呼び出して再起動する、then値・非再試行error・timeoutの分類が契約どおりで、missing action、digest/codec不一致、整数の精度損失は副作用前に診断される。
- [ ] **P4 / Cloudflare emitter** — Given同一MoonBit/IR定義と検証済みCloudflare profile、whenローカル実行と生成JSの`cf dev`実行を比較する、then出力、step identity、retry、event、error、replayの差が説明可能な検証記録として残り、対応外operation・ローカル依存の混入はbuild時に拒否される。
- [ ] **P5 / subset importerとround-trip** — Given宣言済みのJS/TS grammar・effect subset、when`JS → IR → MoonBit → IR → JS`を実施する、then正規化IRと複数分岐・error・crash/replayのobservable behaviorが一致する。対象外の動的構文やJS action残存時の`mbt-only-source`指定は位置付きの理由で失敗する。

**着手順序:** P0の分類結果を固定してからP1の最小stepを実装する。P2の型設計は並行検討してよいが、P1の永続化契約を破る公開APIの先行公開はしない。P3〜P5は前Phaseの検証証拠を依存条件とする。

## テスト計画

本PRはMarkdownのみ。CLI・kernel・compiler・oracleの実装テストはこの文書変更のPASSとはしない。下表のコマンドは実装PRで使う予定の検証であり、実行したものと予定のものを区別して記録する。

### 検証マトリクスと完了の記録

| 対象 | 既存コマンドまたは追加するテスト | 必須の証拠 |
| --- | --- | --- |
| Kernel / host | `npm run check:moon`、`build:core`、`test:moon`、`test:host` | 規則・境界の回帰なし |
| 永続化 | `npm run test:storage`、`npm run test:e2e`、`npm run test:scenario` | SQLiteの実測とcommit境界のSIGKILL/restart。PostgreSQLは`WORKFLOWS_POSTGRES_URL`を与えた場合だけ検証し、未設定時のskipをPASSと数えない |
| 配布 | `npm run test:consumer` | compilerを持たないconsumerが固定artifactを実行・再開できる |
| 無改変JS互換性 | `npm run compat:typecheck`、`test:compat`、`compat:pinned`、`compat:latest`、`compat:drill` | candidateとprofileに紐付くoracle比較。欠測をPASSにしない |
| IR / interop | P2/P3で新設するunit・property・negative・crash tests | codec往復、参照整合性、両方向呼出し、version不一致拒否 |
| Code generation / import | P4/P5で新設するcompiler・round-trip・differential tests | 生成物の実コンパイル、対応subsetの意味保存、未対応入力の診断 |
| Cloudflare本番 | 既存hosted canaryに新しいfixtureを追加 | 実際に実行したrevision/profileと結果。未実行は未検証 |

表中の省略されたnpm script名には、それぞれ`npm run`を付けて実行する。新設テストのコマンド名は実装PRで確定し、現時点で実在するコマンドとして案内しない。

ロードマップ作成時点ではruntime・compiler・oracleテストは未実行。既存文書やPRのPASS/FAIL報告を今回の実行結果に転記しない。各実装PRでは実行コマンド、対象SHA、PASS / FAIL / 未実行、artifact、未解消差分を記録する。Phaseの完了はコードの存在ではなく、対応する受入証拠が揃った時点で更新する。

### 文書変更時の確認

1. `issues/open/20261010-runtime-ir-js-mbt-roadmap.md` の`Status`、`Model`、`Created`、`Updated`、`Branch`、必須11見出しが一度ずつ存在し、`Status: open`と`issues/open`が一致することを確認する。
2. `polish-issue`の`local_issues.py`が手元にある場合は`python /path/to/skills/issues/scripts/local_issues.py --repository-root . validate --issue-root issues --path issues/open/20261010-runtime-ir-js-mbt-roadmap.md`を実行する。利用できなければ同じ項目を手動検証し、CLI未実行を明示する。
3. `git diff --check`、変更ファイルの一覧、相対リンク、PR本文の差分説明を確認する。実装PRでは実測したコマンド・対象SHA・PASS/FAIL/未実行を添える。

## リスク

| リスク | 緩和策 / 完了判断 |
| --- | --- |
| JS hostとIR evaluatorにdurable規則が二重化する | Command/Eventの責務表と同一fixtureの前後trace比較をP1の必須条件とする |
| step名・count・並列順序の変化で別stepとして再実行する | 明示`node_id`と既存identityのmappingを固定し、loop/parallelとreplayのgolden testを追加する |
| artifact更新により途中instanceが異なるコードで再開する | IR、workflow digest、action、codecをinstanceごとに固定し、不一致はfail-closed。移行は別PRで扱う |
| 外部副作用の重複と原子性の破壊 | at-least-onceを明記し、冪等キー・commit境界SIGKILL・storage lease/fencingを検証する |
| JS/TS importerが未対応構文を誤変換する | 静的subsetを公開し、非対応入力は位置付き診断にする。無改変JS実行を必ず残す |
| upstream更新・Cloudflare hosted差異で根拠のない互換性主張が生じる | pinned/latest/hostedの実測profileを分け、候補失敗・欠測をverifiedに含めない |
| PostgreSQLの実装状況が文書間で不一致 | `README.md`と`COMPATIBILITY.md`の差分を未確定事項として記録。storageコード・条件付きPG CIを確認するまで対応済みと断定しない |
| MoonBit toolchain/JS FFI/APIの版差、`number`の精度 | 固定toolchainでコンパイル・相互呼び出しを検証し、非可逆なcodecを拒否する |

## 変更履歴

- 2026-10-10: 初稿。互換ランタイム、MoonBit Flow IR、JS↔MoonBitをP0〜P5へ分割し、クラッシュ再開・差分検証を要件化。
- 2026-10-10: `polish-issue`基準で背景/問題/対象外、検証可能な受入チェックリスト、fixture例、テスト計画、リスク、担当モジュール、文書間不整合を明確化。コード・oracle・依存pinは変更しない。

## 注記

- `issues/`配下は既存の`open/`と`closed/`の状態ディレクトリで管理されているため、実装未完了のロードマップは`Status: open`と`issues/open/`を維持する。新しい`polished/`ディレクトリはこのPRで作らない。**P0の着手条件は定義済み**であり、全Phaseの実装完了を意味しない。
- P2の公開builder API構文、IR opcodeの最終schema、JS/TS parser、MoonBit emitterの正確な外部APIは各Phaseの実装PRでfixture・negative testを伴って確定する。検証前に安定版として公開しない。
- PR #20および既存追跡issueの状態を本PRは変更しない。Cloudflareのlatest/hosted、PostgreSQLについて未実行のテストをPASSにしない。
- 互換対象は`compat/capabilities.json`と`COMPATIBILITY.md`に記録されたprofileに限る。文書の改善自体は新しいruntime互換性の証拠ではない。
