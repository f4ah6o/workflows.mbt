# Cloudflare feature coverage automation — upstream 由来の分母と evidence freshness

Status: open
Created: 2026-09-29
Baseline: main @ e8aa8fa85ffeb3f4b6d915d2343b454344f57a75

## 目的

既存の compatibility framework を拡張し、Cloudflare upstream に対する「機能
カバレッジ」を証跡ベースで自動測定できる状態にする。新しい別系統を作るのでは
なく、`compat/` 以下の既存資産 (capabilities / probe catalog / oracle /
differential / verdict / drift-record / docs-watch / report) を拡張対象とする。

この Issue は計画のみを扱う。実装は本 Issue を参照する後続 commit で行う。

## 背景 — 現状の compat framework と検証済みのギャップ

現状確認 (read-only) で確認した既存構成:

- `COMPATIBILITY.md` — 人間が保守する互換性説明 (checkbox 形式)
- `compat/capabilities.json` (formatVersion 1) — 32 capability 行、10 category
  (`lifecycle`, `binding`, `step`, `promise`, `subscription`, `schedule`,
  `serialization`, `worker`, `durability`, `rest`)。各行は
  `{id, category, title, probes[], skippedProbes[], evidence{...},
  knownDifference?}`。evidence flag は `implemented` / `repository_tested` /
  `pinned_differential` / `latest_differential` / `hosted_differential` /
  `intentionally_unsupported` の宣言値。
- `compat/probes/catalog.json` — 32 probe (`kind: workflow|orchestrated`、
  `capabilities[]` への逆参照、`differential:false` opt-out あり)
- `compat/check-capabilities.mjs` — catalog ↔ matrix 整合性、differential
  result の全 probe coverage、evidence flag と result file の整合性を検証し、
  `compat-results/capabilities.json` を解決済み matrix として出力する
- `compat/oracle/check.mjs` — `@cloudflare/workers-types` から正規化 hash /
  member set / literal union hash / event variant shape を抽出し、commit 済み
  snapshot (`api-surface.json`) と比較。Wrangler schema 側は workflow binding
  の `workflowBindingKeys` + `trackedKinds` のみ追跡
  (`oracle/wrangler-schema.json`)。`LOCAL_CLASS_SURFACES` で local 実装
  surface の欠落も検出する
- `compat/run-differential.mjs` / `compat/probe-client.mjs` /
  `compat/normalize.mjs` — probe trace を normalized (stable lifecycle subset,
  sortKeysDeep, errorShape, steps/rollback/wait/sleep) にして diff。
  `probeErrors` は per-probe で記録され、両側 error でも pass しない
- `compat/candidate.mjs` — `pinned` (lockfile) / `latest` (isolated install、
  `@latest` を run 冒頭で一度だけ解決) の shared candidate。versions /
  integrity / transitive runtime graph / compatibility_date / flags を記録
- `compat/verdict.mjs` — `compatible` / `contract-drift` / `semantic-drift` /
  `upstream-acquisition-failure` / `upstream-execution-failure` /
  `local-runtime-failure` / `incomplete-evidence` / `hosted-not-performed`
- `compat/run-latest.mjs` — candidate → typecheck → contract → differential →
  docs-watch → verdict → drift-record → update-candidate を単一
  `WORKFLOWS_MBT_RUN_ID` で orchestrate
- `compat/docs-watch.mjs` — `compat/cloudflare/VERSION.md` cited docs の hash
  watch → `investigationRequired`
- `compat/drift-record.mjs` — dedup drift packet → `issues/open/` packet +
  `drift-state.json`、GitHub issue publish path
- `compat/canary.mjs` — credential-gated hosted canary
  (`CF_API_TOKEN`/`CF_ACCOUNT_ID`、専用 worker `workflows-mbt-canary`)
- `compat/report.mjs` — `compat-results/report.md` 生成
- `compat/run-drill.mjs` + `scripts/consumer-scenario.mjs` /
  `examples/scenario/` — 実利用 scenario (外部副作用 + SIGKILL + restart)
- CI: `ci.yml` (PR: test suite + `compat:pinned` + `compat:report`)、
  `compat-latest.yml` (scheduled daily)、`compat-hosted.yml` (weekly、
  credential gate)

### 確認したギャップ

1. **分母が hand-maintained**。capability / probe は repository 内に登録された
   ものだけが対象で、upstream の機能集合に対する分母の網羅性を保証する仕組みが
   ない。`oracle/check.mjs` の `API_MARKERS` は 26 個の選定 declaration を追跡
   するだけで、tracking 対象外の新規 declaration は drift にすら現れない。
2. **evidence flag が宣言値**。`implemented: true` や `pinned_differential:
   true` は宣言であり、今回の run で実際に再検証された証跡と区別されない。
   `check-capabilities.mjs` は result file がない場合を "claimed but not
   re-verified" の note に留める。
3. **状態が曖昧**。UNTESTED / BLOCKED / STALE / UNSUPPORTED / DIVERGENT を
   区別する状態モデルがなく、coverage 計算そのものが存在しない
   (`compat:report` は flag の一覧を出すだけで numerator/denominator を
   出さない)。
4. **profile 分離がない**。`categories` は topic 分類であり、Workflows
   compatibility と Workers platform coverage を分ける指標になっていない。
5. **validator failure の伝播がない**。`report.mjs` は
   `check-capabilities.mjs` を `spawnSync` で実行するが **exit code を見ない**
   — validator が失敗しても正常な report.md が生成される。
6. **requirement 層がない**。capability → probes の直接対応のみで、
   「upstream feature → semantic requirement → required probe」の chain を
   machine-readable に検証できない。

## 解決したい問題

1. upstream の機能集合に対して分母が十分かを保証できない。
2. 自前で作成した probe だけを分母にすると、未登録機能を無視したまま高い
   対応率を出せてしまう。
3. `implemented: true` / 過去の evidence flag と、今回の run で実際に再検証
   された証跡を区別したい。
4. UNTESTED / BLOCKED / STALE / UNSUPPORTED / DIVERGENT を、成功や分母外と
   して曖昧に処理したくない。
5. upstream の API / Wrangler schema / docs が更新された際に、新規機能・
   契約変更・未分類項目・probe 不足・compatibility regression を自動検出
   したい。
6. Workflows compatibility と Workers platform 全体の coverage を混ぜず、
   profile ごとに測定したい。

## 設計

### 1. Profile 分離

capability / inventory item は必ず 1 つの profile を持つ。`categories` とは
別軸 (topic) で、coverage 集計は profile 単位で行う。

| profile | scope | 例 |
| --- | --- | --- |
| `workflows-core` | Workflow 実行 semantics 本体 | `WorkflowEntrypoint`, `WorkflowStep`, retry, timeout, `sleep`, `sleepUntil`, `waitForEvent`, lifecycle, replay, rollback, subscription, serialization, durable execution semantics |
| `workflow-host` | Workflow を動かす host/config 面 | Worker HTTP handler, `env`, `ctx` / `ExecutionContext`, source module loading, `compatibility_date` / flags, Wrangler Workflows configuration, `vars` / secrets, scheduling, Workflow binding / `WorkflowInstance` |
| `binding-adapters` | `workflows.mbt.json` adapters が対象とする binding | KV, D1, R2, Queues, Service Bindings |
| `workers-platform` | Workers プラットフォーム全体との互換度を測る将来 profile。Workers AI, Durable Objects, その他 runtime APIs / bindings / deployment management 機能を含む | (将来) |

分母ルール: **workflows.mbt が compatibility target として明示的に対象にする
ものだけが分母に入る**。`workers-platform` は `workflows-core` と別の指標で
あり、Workers AI や Durable Objects を 1 つの Workflow compatibility
percentage に混ぜない。対象外とする item には machine-readable な
`exclusionReason` を必須とする (後述)。

### 2. Upstream inventory — 分母を upstream から生成する

probe catalog ではなく Cloudflare upstream から分母を生成・更新する。抽出
source ごとに性質が違うため、source を item に記録して区別する。

| source | 性質 | 抽出方法 |
| --- | --- | --- |
| `@cloudflare/workers-types` (candidate が pin した exact version の `index.d.ts`) | 公開 API contract の主 source | TypeScript AST (compiler API — `typescript` は既に devDependency) で declaration を機械抽出 |
| Wrangler `config-schema.json` (candidate 同梱) | configuration contract | JSON schema walk (既存 `extractSchemaSurface` の一般化) |
| Cloudflare Workflows docs (`compat/cloudflare/VERSION.md` cited) | 仕様・制約の記述。文章差分から capability を自動追加・削除しない | 既存 `docs-watch.mjs` を拡張。change は常に `investigation_required` として出し、semantic requirement / probe 追加は人間または coding agent がレビューする |
| workerd / Wrangler の公開契約 (CLI surface 等) | 補助 source | 段階導入。初期は workers-types + wrangler schema を主にする |

#### Stable ID

inventory item は source と構造位置から stable ID を持つ。例:

```text
cloudflare:workers.WorkflowStep.do
cloudflare:workers.WorkflowStep.sleep
cloudflare:workers.WorkflowStep.waitForEvent
cloudflare:workers.WorkflowInstance.status
cloudflare:workers.WorkflowInstance.restart
wrangler.workflows.name
wrangler.workflows.binding
wrangler.workflows.class_name
wrangler.workflows.schedules
wrangler.workflows.default_retention
wrangler.compatibility_date
wrangler.compatibility_flags
wrangler.vars
```

#### Contract fingerprint

単純な symbol existence ではなく、declaration ごとに以下を含む fingerprint
を保存し、contract drift の検出対象にする:

- overload リスト
- required / optional 引数
- return type
- nested option shape
- literal union / discriminated union の member と variant shape
- referenced public type (遷移的に追跡する宣言の hash)

現行の `fnv1a(normalizeDeclaration(block))` 全体 hash + member set 抽出
(`oracle/check.mjs`) はこの fingerprint の前身として再利用し、declaration
単位の差分を item granularity に分解する。

#### Semantic inventory

API shape だけでは捕捉できない項目は別 inventory (`semantic` source) として
人手で登録する。例: replay semantics, retry semantics, timeout semantics,
durable sleep, event buffering, pause boundary, restart behavior,
external side effects are at-least-once, Promise race replay limitation,
retention defaults, subscription semantics, hosted-only constraints。
docs change はこの inventory の項目追加・削除・変更を自動では行わず、
`investigation_required` を emit する。

#### Inventory item schema (案)

```yaml
id: cloudflare:workers.WorkflowStep.do
source: workers-types          # workers-types | wrangler-schema | docs | semantic
kind: api-method               # api-class | api-method | api-field | api-type | config-key | semantic-item
profile: workflows-core        # 未分類は null → classification coverage を落とす
target: in-scope               # in-scope | excluded
exclusionReason: null          # excluded のとき必須 (machine-readable な文字列コード)
contract:                      # source が型/設定のとき
  fingerprint: "fnv1a:..."
  membersHash: "..."
firstSeen: { wrangler: "4.141.0", workersTypes: "5.20260925.2" }
lastSeen:  { ... }             # discovery run が観測した最新 candidate
```

### 3. Capability chain — feature → requirement → probe → evidence

以下の chain を machine-readable に表現する。

```text
upstream feature (inventory item)
  ↓
profile / scope classification
  ↓
semantic requirement(s)
  ↓
required probe(s)
  ↓
evidence
  ↓
current run status
```

既存 `compat/capabilities.json` を `formatVersion: 2` に拡張してこの chain を
保持する (新フォーマットを別立てしない)。行の拡張例:

```yaml
id: workflows.step.do.replay
profile: workflows-core
upstream:
  symbols: ["cloudflare:workers.WorkflowStep.do"]
  semantic: ["replay-semantics"]
requirements:
  - id: returns-committed-result
    requiredProbes: ["replay-returns-committed-result"]
  - id: no-callback-reexecution
    requiredProbes: ["replay-callback-count"]
probes: [...]          # 既存の capability→probe 集約は requiredProbes から導出
```

既存 32 capability / 32 probe は backfill 対象 (後述)。`category` は topic
label として残し、`profile` を新規必須フィールドにする。

### 4. Coverage state model

各 requirement / capability の状態を以下で区別する。

| state | 定義 |
| --- | --- |
| `VERIFIED` | 今回の測定対象条件に対して、必要な probe がすべて有効な evidence を持ち、期待条件 (contract) と upstream differential の両方を満たした |
| `DIVERGENT` | probe は実行できたが、upstream と意味的に異なる |
| `UNSUPPORTED` | compatibility target の分母に入るが、意図的または現時点で未実装 |
| `UNTESTED` | feature / requirement は存在するが probe がない、または今回未実行 |
| `BLOCKED` | credentials、Cloudflare hosted environment、upstream crash、tooling issue などにより判定不能 |
| `STALE` | 以前の evidence は存在するが、現在の implementation commit / inventory revision / probe revision / upstream version / compatibility_date / relevant configuration に対して再検証されていない |

#### 2 軸 verdict — `crash == crash` を MATCH にしない

各 probe の判定を `contract` と `differential` の別軸にする。

```text
contract:     PASS | FAIL   # probe が定義する期待契約を満たしたか
differential: PASS | FAIL   # upstream との normalized trace が一致したか
```

`contract: PASS` かつ `differential: PASS` で初めて VERIFIED に寄与する。
「Cloudflare: crash / local: crash」だけでは VERIFIED にしない。Cloudflare
自体が undocumented crash / failure を起こすケースは
`upstream-observed-limitation` として別扱いし、該当 requirement の状態を
BLOCKED (upstream-side) または UNSUPPORTED + `knownDifference` として記録する。

### 5. Evidence freshness — declared vs verified vs current run

現在の declarative evidence (`implemented` / `repository_tested` /
`pinned_differential` / `latest_differential` / `hosted_differential` /
`intentionally_unsupported`) と、current run で実際に確認できた evidence を
分離する。概念的には:

```text
declaredSupport        # 人間/agent が宣言したサポート状況 (旧 evidence flag)
lastVerifiedEvidence   # 直近の有効な run 証跡 (run id + fingerprint)
currentRunStatus       # 今回の run が実際に観測した結果
```

最終 coverage の分子は `implemented: true` / `latest_differential: true` の
ような手書き flag を直接使わず、current run / valid evidence から導出する。

#### Run result fingerprint

各 oracle run result に最低限以下を保存する (既存の `runId` / `checkedAt` /
`commit` / `candidateId` / `versions` / `runtime` / `probeSourceHash` /
`catalogHash` を拡張):

```text
implementation git commit
inventory revision/hash            # compat/inventory/* の hash
capability matrix revision/hash    # capabilities.json の hash
probe catalog revision/hash        # catalog.json の hash (既存 catalogHash)
probe implementation revision/hash # probes/src の hash (既存 probeSourceHash)
comparison / normalization revision/hash  # normalize.mjs 等の hash
upstream candidate id              # candidate-*.json の id
wrangler exact version
workerd exact version
workers-types exact version
compatibility_date
compatibility_flags
binding/config fingerprint         # probes/wrangler.jsonc + adapters 設定の hash
oracle type                        # pinned | latest | hosted
run id                             # WORKFLOWS_MBT_RUN_ID
run timestamp
```

STALE 判定: `lastVerifiedEvidence` の fingerprint tuple が現在の対応値と一致
しない場合、その evidence は STALE であり VERIFIED として集計されない。

#### Hosted evidence

hosted Cloudflare は完全な binary pin を想定しない。hosted evidence は
「Cloudflare production environment + compatibility_date + configuration +
observed timestamp」に対する observation として扱い、pinned / latest の
binary-pin evidence と別系統で記録する。既存の `pinned` / `latest` /
`hosted` oracle 系統は維持・拡張する。

### 6. 比較・normalization 規則

各 probe は単純な output comparison だけでなく、必要に応じて以下を比較可能
にする (現行 normalize は status / output / error shape / stable lifecycle /
steps / rollback order・outcome / wait / sleep を抽出済み):

- return value
- error class / code / shape
- lifecycle state sequence
- callback invocation count
- retry count
- durable records
- emitted subscription events / event consumption
- external side-effect count
- HTTP status / headers / body

timestamp、generated ID 等の volatile values は normalization 可能。ただし
normalization で duplicate execution / missing events / ordering errors /
wrong retry count / wrong durable commit count を隠してはいけない。

### 7. Coverage 指標

最低限以下を定義する。すべて percentage ではなく numerator / denominator を
保持・表示する。

| metric | 定義 |
| --- | --- |
| inventory classification coverage | `classified upstream features / discovered upstream features`。未分類 feature を検出する指標 |
| compatibility coverage (主指標) | `VERIFIED target requirements / all target requirements` (profile 別) |
| functional coverage | `passed executed requirements / executed requirements`。compatibility coverage とは別物 — 実行できた範囲の成績 |
| practical scenario coverage | `supported practical scenarios / target scenarios` (consumer scenario / drill 系) |

表示例:

```text
workflows-core      92 / 100
workflow-host       31 / 38
binding-adapters    12 / 25
workers-platform    40 / 310
```

### 8. Validation chain の拡張

現状の `check-capabilities.mjs` が検証しているのは
「catalog → capability の整合性」「differential result の全 probe
coverage」「evidence flag と differential result の整合性」。これを
以下の chain 全体に拡張する:

```text
upstream inventory
→ scope classification
→ capability
→ semantic requirements
→ probes
→ evidence
```

最低限検出するもの:

- discovered upstream feature に classification がない
- target feature に capability がない
- capability に requirement がない
- requirement に probe がない
- required probe が catalog にない
- probe result が stale (fingerprint 不一致)
- claimed VERIFIED に evidence が不足
- result file が部分実行
- evidence fingerprint が current revision と一致しない

### 9. Report

`compat/report.mjs` が validator を実行した場合、validator failure を無視し
て正常 report を生成しない (現状: `spawnSync` の exit status を見ていない)。
validator が失敗したら `coverage status = INVALID` とするか、report command
自体を non-zero にする。

差分だけでなく `probeErrors` / `execution error` / `blocked` / `stale` /
`not run` を明示する。Markdown / JSON で最低限以下を出す:

```text
| Profile | Verified | Divergent | Unsupported | Untested | Blocked | Stale | Total | Coverage |
| workflows-core | 87 | 3 | 2 | 5 | 1 | 2 | 100 | 87.0% |
```

### 10. Change classification と response chain

upstream 差分を以下に分類する:

```text
API_ADDED
API_REMOVED
API_CHANGED
CONFIG_ADDED
CONFIG_REMOVED
CONFIG_CHANGED
DOCS_CHANGED
SEMANTIC_DIFFERENCE
PROBE_REQUIRED
IMPLEMENTATION_REQUIRED
```

例えば API 追加時は

```text
detect upstream symbol
→ inventory に unclassified item
→ CI report
→ Issue / investigation candidate
→ capability mapping
→ semantic requirements
→ probe
→ implementation
→ evidence
```

まで追跡できること。既存 `drift-record.mjs` の dedup packet 機構をこの
分類に接続する。

### 11. 二本立て coverage

単純 API coverage だけでなく、現在ある consumer scenario / drill 系
(`compat/run-drill.mjs`、`scripts/consumer-scenario.mjs` +
`examples/scenario/`) を残す。理由: 100% API shape compatible でも
restart / SIGKILL / external side effects / retry / pause / event wait /
queue / binding / HTTP を組み合わせると実用上壊れる可能性がある。従って
`atomic feature coverage` + `practical scenario coverage` の二本立てとする。

## CI phases

最低限 3 段階に分ける。

### PR (credential-free、hosted 必須なし)

```text
inventory/schema validation
capability validation          # chain validator (check-capabilities 拡張)
pinned oracle                  # 既存 compat:pinned (typecheck + contract + differential)
repository tests               # 既存 npm test 系
coverage calculation           # compat/coverage.mjs → compat-results/coverage.json
regression gate                # coverage が baseline を下回る / INVALID で fail
```

### Daily latest (既存 compat-latest.yml を拡張)

```text
resolve latest upstream versions   # @latest を run 冒頭で一度だけ解決
freeze candidate                   # exact version / identity で固定、run 内で使い回す (既存 candidate.mjs)
extract contract                   # inventory extraction (workers-types AST + wrangler schema)
compare inventory                  # 新規/変更/削除 item → change 分類
run latest differential            # 既存
detect docs changes                # 既存 docs-watch → investigation_required
generate investigation packet      # drift-record packet に分類を付与
```

upstream の latest を job 中に無固定で複数回解決しない (現行の shared
candidate 方式を維持)。

### Hosted canary / release (credential-gated、既存 compat-hosted.yml を拡張)

```text
deploy dedicated canary
run hosted differential probes
collect evidence
cleanup resources
generate final coverage report
```

hosted test は専用 namespace / resource prefix を使い、production user data
に触れない設計にする (現行 `workflows-mbt-canary` を prefix 規約として明文化)。
PR の coverage gate に hosted credentials を必須にしない。

## Acceptance criteria

以下はすべて machine-verifiable にする:

1. UNTESTED を分母から消さない。
2. BLOCKED を分母から消さない。
3. STALE を VERIFIED として数えない。
4. UNSUPPORTED は target scope なら分母に残す。
5. intentionally unsupported も strict compatibility coverage では
   VERIFIED にしない。
6. product scope 外として除外する場合は、machine-readable な理由
   (`exclusionReason`) を必須にする。
7. 新しい upstream feature が発見されたら、分類されるまで inventory
   classification coverage を落とす。
8. probe が追加されていない upstream feature を「対応済み」と推定しない。

加えて:

- upstream inventory に存在する target item が未分類なら CI が検出する
- target feature が probe 不足なら VERIFIED にならない
- stale evidence が VERIFIED として集計されない
- partial differential result が coverage evidence として採用されない
- validator failure 後に正常 coverage report を出さない
- profile ごとの numerator / denominator が machine-readable JSON に出る
- Markdown report に VERIFIED / DIVERGENT / UNSUPPORTED / UNTESTED /
  BLOCKED / STALE が出る
- pinned / latest / hosted evidence を別々に追跡できる
- upstream API/schema addition が自動検出される
- docs change が investigation trigger になる
- existing capabilities / probes が初期 backfill される
- existing compatibility tests を壊さない
- target 外 item の exclusion reason が machine-readable
- generated result から repository commit / upstream candidate / config
  identity を追跡できる
- percentage だけでなく numerator / denominator を保持する

## Non-goals

今回この Issue が直接目標としないもの:

- Cloudflare Workers の全機能を即時実装する
- full Wrangler clone
- hosted Cloudflare をローカルで完全再現する
- undocumented internals の完全互換
- compatibility percentage を一つの marketing number に潰す
- docs diff から semantic support を完全自動判定する
- coding agent の自己申告だけで VERIFIED にする

## 実装計画 — candidate file layout

既存構造に合わせ、不要なファイル分割を避ける:

```text
compat/inventory/upstream-api.json      # 抽出済み upstream API inventory (commit 済み baseline)
compat/inventory/upstream-config.json   # Wrangler config inventory baseline
compat/inventory/semantic.json          # docs/semantics 由来の人手 inventory
compat/inventory/extract.mjs            # workers-types AST + wrangler schema の抽出器
compat/check-inventory.mjs              # inventory → classification validator
compat/capabilities.json                # formatVersion 2: profile / upstream / requirements
compat/probes/catalog.json              # 既存維持 (probe id ↔ capability)
compat/check-capabilities.mjs           # chain 全体 validator に拡張
compat/coverage.mjs                     # state 集計 → compat-results/coverage.json
compat/report.mjs                       # validator failure 伝播 + per-profile 表
compat/oracle/check.mjs                 # api-surface snapshot → inventory 差分へ接続
compat-results/coverage.json            # per-profile numerator/denominator + item state
compat-results/report.md                # 既存 (coverage 表を追加)
.github/workflows/ci.yml                # PR: inventory validation + coverage gate
.github/workflows/compat-latest.yml     # daily: extract/compare inventory
.github/workflows/compat-hosted.yml     # hosted: final coverage report
```

`compat/inventory/` 配下は baseline JSON + 抽出器のみ。run 時の生成物は
`compat-results/` に集約し、commit 済みファイルと generated を混ぜない。

## 実装 phase (依存関係順)

- **Phase 1 — foundation**: profile taxonomy, state model 定義,
  denominator rule, extended result schema (fingerprint fields),
  evidence freshness model (`declaredSupport` / `lastVerifiedEvidence` /
  `currentRunStatus`)
- **Phase 2 — inventory extraction**: `inventory/extract.mjs` (TypeScript AST
  over candidate workers-types + wrangler `config-schema.json` walk)、
  stable ID 採番、contract fingerprint、committed baseline JSON、
  `check-inventory.mjs` (unclassified / undetected chain の検出)
- **Phase 3 — classification + chain mapping**: inventory item → profile /
  target|excluded(+exclusionReason)、capabilities.json formatVersion 2
  (profile + upstream refs + requirements/requiredProbes)、既存 32
  capability / 32 probe の backfill
- **Phase 4 — current-run evidence**: run result fingerprint 記録の拡張、
  stale detection、coverage state の導出器
- **Phase 5 — coverage + report**: `coverage.mjs` → `coverage.json`、
  report.mjs per-profile table + probeErrors/blocked/stale/not run 明示 +
  validator failure → INVALID / non-zero 伝播
- **Phase 6 — CI wiring**: PR (inventory validation + capability validation +
  coverage + regression gate)、daily latest (extract → compare inventory →
  investigation packet)、hosted canary (dedicated prefix + final coverage
  report)
- **Phase 7 — docs**: COMPATIBILITY.md に coverage 数値の出典
  (coverage.json) を明記、`docs/upstream-tracking.md` を新 phase 構成に
  更新

## Backfill 方針

既存 COMPATIBILITY.md / capabilities / probes を新しい inventory に
backfill する。新方式導入だけで既存 coverage をゼロから書き直さない。

- 既存 capability 行 → `profile` 付与 + upstream symbol mapping
  (例: `step.do` → `cloudflare:workers.WorkflowStep.do`)
- upstream symbol を持たない行 → `semantic` inventory item として登録
- 既存 differential result → 初期 `lastVerifiedEvidence` (fingerprint は
  現行 run の値で記録)
- `intentionally_unsupported` 行 → `UNSUPPORTED` + `knownDifference` /
  `exclusionReason` へ移行
- COMPATIBILITY.md の checkbox は人間向け説明として維持し、coverage 数値の
  source of truth は coverage.json に移す
