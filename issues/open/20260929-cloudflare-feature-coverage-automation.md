# Cloudflare feature coverage automation — upstream 由来の分母と evidence freshness

Status: open
Created: 2026-09-29
Revised: 2026-09-29 (PR #11 review B1–B12 反映)
Baseline: main @ e8aa8fa85ffeb3f4b6d915d2343b454344f57a75

## 目的

既存の compatibility framework を拡張し、Cloudflare upstream に対する「機能
カバレッジ」を証跡ベースで自動測定できる状態にする。新しい別系統を作るのでは
なく、`compat/` 以下の既存資産 (capabilities / probe catalog / oracle /
differential / verdict / drift-record / docs-watch / report) を拡張対象とする。

この Issue は計画のみを扱う。実装は本 Issue を参照する後続 commit で行う。

## 背景 — 現状の compat framework と検証済みのギャップ

現状確認 (read-only、PR HEAD bb82aeb 時点) で確認した既存構成:

- `COMPATIBILITY.md` — 人間が保守する互換性説明 (checkbox 形式)
- `compat/capabilities.json` (formatVersion 1) — **38 capability 行**、10
  category (`lifecycle`, `binding`, `step`, `promise`, `subscription`,
  `schedule`, `serialization`, `worker`, `durability`, `rest`)。各行は
  `{id, category, title, probes[], skippedProbes[], evidence{...},
  knownDifference?}`。evidence flag は `implemented` / `repository_tested` /
  `pinned_differential` / `latest_differential` / `hosted_differential` /
  `intentionally_unsupported` の宣言値。
- `compat/probes/catalog.json` — **34 probe** (`kind: workflow|orchestrated`、
  `capabilities[]` への逆参照)。うち **differential eligible は 32**、
  `differential:false` は 2 (`ser-bigint`, `ser-unsupported`)。
  以降「32 probes」と書くときは常に differential eligible を指す。
- `compat/check-capabilities.mjs` — catalog ↔ matrix 整合性、differential
  result の全 eligible probe coverage、evidence flag と result file の
  整合性を検証し、`compat-results/capabilities.json` を解決済み matrix と
  して出力する
- `compat/oracle/check.mjs` — `@cloudflare/workers-types` から正規化 hash /
  member set / literal union hash / event variant shape を抽出し、commit 済み
  snapshot (`api-surface.json`) と比較。**`API_MARKERS` は 25 個の選定
  declaration** を追跡するだけで、tracking 対象外の新規 declaration は
  drift にすら現れない。Wrangler schema 側は workflow binding の
  `workflowBindingKeys` + `trackedKinds` のみ追跡
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
   ない。`oracle/check.mjs` の `API_MARKERS` は 25 個の選定 declaration を追跡
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
   `check-capabilities.mjs` を `spawnSync` で実行するが **exit status を見ない**
   — validator が失敗しても正常な report.md が生成される。
6. **requirement 層がない**。capability → probes の直接対応のみで、
   「upstream feature → semantic requirement → required probe」の chain を
   machine-readable に検証できない。

## 用語

以降で使う用語を固定する (generated と committed source-of-truth の混同を避ける)。

| 用語 | 意味 | generated / committed |
| --- | --- | --- |
| discovery boundary | profile ごとに upstream から何を拾うかの機械検証可能な規則 (§設計2) | committed 仕様 |
| candidate inventory | resolved upstream candidate に discovery boundary を適用して **生成した** inventory 一式 | generated (`compat-results/`) |
| committed baseline inventory | repository に commit された inventory baseline (`compat/inventory/upstream-*.json`)。machine field の source of truth | committed |
| classification | stable ID を key にした human-authored 分類 (`profile` / `target` / `exclusionReason` 等)。`compat/inventory/classification.json` に保持 | committed (human-owned) |
| resolved inventory | committed baseline + classification を stable ID join した最終ビュー。coverage / validator が見る実体 | derived |
| discovered upstream feature | 現在の candidate inventory に存在する item の総称 (denominator の原料) | derived |
| surface contract | `oracle/check.mjs` が扱う API/config surface の drift 契約 | — |
| behavioral contract | probe ごとの期待挙動 assertion (§設計6)。surface contract とは別概念 | — |
| differential result | 両 runtime の normalized trace の一致/不一致 | — |
| coverage state | requirement に付く `VERIFIED` 等の状態。**常に oracle-specific** | derived |
| lastVerifiedEvidence | ある oracle が最後に有効 evidence を残した run + fingerprint。**oracle-specific** | derived |

「discovered upstream features」の厳密な定義: **resolved upstream candidate に
discovery boundary を適用して生成された candidate inventory item の集合**。
それ以外の surface を coverage denominator とみなさない。

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

### 1. Profile 分離と profile lifecycle

```text
workflows-core      # Workflow 実行 semantics 本体
workflow-host       # Workflow を動かす host/config 面
binding-adapters    # workflows.mbt.json adapters が対象とする binding
workers-platform    # Workers プラットフォーム全体 (deferred)
```

各 profile の例:

- `workflows-core`: `WorkflowEntrypoint`, `WorkflowStep`, retry, timeout,
  `sleep`, `sleepUntil`, `waitForEvent`, lifecycle, replay, rollback,
  subscription, serialization, durable execution semantics
- `workflow-host`: Worker HTTP handler, `env`, `ctx` / `ExecutionContext`,
  source module loading, `compatibility_date` / flags, Wrangler Workflows
  configuration, `vars` / secrets, scheduling, Workflow binding /
  `WorkflowInstance`
- `binding-adapters`: KV, D1, R2, Queues, Service Bindings
- `workers-platform`: Workers AI, Durable Objects, その他 runtime APIs /
  bindings / deployment management

#### Profile lifecycle

```text
active    # coverage 計算の対象。現時点: workflows-core / workflow-host / binding-adapters
deferred  # 将来 profile。discover は可能だが active denominator に含めない
```

`workers-platform` は `deferred` とし、現時点で active denominator に含めない。
active profile が変わるのは reviewed PR での明示的変更のみ。

分母ルール: **workflows.mbt が compatibility target として明示的に対象にする
ものだけが分母に入る**。`workers-platform` は `workflows-core` と別の指標で
あり、Workers AI や Durable Objects を 1 つの Workflow compatibility
percentage に混ぜない。対象外とする item には machine-readable な
`exclusionReason` を必須とする (§設計4)。

### 2. Discovery boundary — upstream から何を拾うか

`@cloudflare/workers-types/index.d.ts` 全体を inventory 化すると Workers
全体の巨大な surface になる一方、既知 `Workflow*` declaration の allowlist
では新しい relevant declaration を取り逃がし、現在問題視している
hand-maintained denominator と同じになる。そこで profile ごとに **discovery
boundary** を定義する。

#### Boundary の構成要素

1. **root spec** — profile ごとの探索起点 declaration / schema subtree。
   `compat/inventory/discovery-roots.json` (committed) に name pattern で
   記述し、機械検証可能にする。
2. **member closure** — root declaration の全 member (method / property /
   overload / union variant) は自動的に inventory item になる。既知 root の
   新 member は自動検出される。
3. **reference closure** — root/member が参照する public type は遷移的に
   inventory item (`kind: referenced-type`) になる。`via` に参照元を記録。
   lib.dom / built-in / non-Cloudflare global type は除外。
4. **top-level candidacy** — boundary 対象 module 内で新規に出現した
   top-level declaration は、(a) いずれかの profile の root spec に match
   するか、(b) 既存 boundary item から直接参照される場合、自動的に
   `unclassified` candidate item になる。それ以外の新規 declaration は
   `workers-platform` deferred scope に落ち、active denominator を汚さない。

#### Per-profile boundary

| profile | discovery roots (例) |
| --- | --- |
| `workflows-core` | `cloudflare:workers` / `cloudflare:workflows` module 内の `WorkflowStep*`, `WorkflowEntrypoint*`, `WorkflowEvent`, `WorkflowInstanceEvent*`, `WorkflowStepConfig/Context`, `WorkflowStepRollback*`, `WorkflowRollback*`, `WorkflowDelay*`, `WorkflowDynamicDelay*`, `WorkflowBackoff`, `WorkflowSleepDuration`, `WorkflowTimeoutDuration`, `WorkflowRetentionDuration`, `WorkflowDurationLabel`, `WorkflowCronSchedule`, `WorkflowError`, `InstanceStatus`, `NonRetryableError` + その reference closure |
| `workflow-host` | `Workflow` (binding class), `WorkflowInstance*`, `ExecutionContext`, `ExportedHandler` / `WorkerEntrypoint` 系 entry surface + wrangler schema subtree: `workflows[]`, `compatibility_date`, `compatibility_flags`, `vars`, `secrets`, `env.<name>` の継承対象キー |
| `binding-adapters` | wrangler schema binding family `kv_namespaces` / `d1_databases` / `r2_buckets` / `queues` / `services` + 対応する workers-types binding interface (`KVNamespace`, `D1Database`, `R2Bucket`, `Queue`, `Fetcher` 等) — `workflows.mbt.json` adapters が実際に対象とするものに限定 |
| `workers-platform` (deferred) | 上記以外の module surface 全体。発見は記録するが active denominator に入れない |

Extraction source と性質:

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
を保存し、surface contract drift の検出対象にする:

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

### 3. Field ownership — generated と human classification の分離

machine-generated field と human-authored classification を同じ場所で競合さ
せない。**分類情報の source of truth は `compat/inventory/classification.json`
1 箇所だけ**にする。

#### Field ownership

| field | owner |
| --- | --- |
| `id` (stable ID), `source`, `kind`, `contract.fingerprint`, `contract.membersHash`, `firstSeen`, `lastSeen` | upstream extractor (`compat/inventory/extract.mjs`) |
| `profile`, `target` (`in-scope`/`excluded`), `exclusionReason`, `unsupportedReason`, `classifiedAt`, `classifiedBy` | human classification (`compat/inventory/classification.json`、stable ID keyed) |

#### Merge rule (deterministic、stable ID base)

1. extractor は **machine field だけ**を含む candidate inventory を
   `compat-results/` に生成する。human field は一切書かない。
2. resolved inventory = candidate inventory ⋈ classification (stable ID join)。
3. baseline commit 時の merge は stable ID の deterministic merge:
   - 既存 stable ID → machine field は新規生成値で更新、classification は
     既存値をそのまま維持 (再生成で human classification を失わない)
   - 新規 stable ID → `unclassified` として追加 (classification 行なし)
   - 消えた stable ID → `removed` として diff に記録 (classification 行は
     残り、stale classification として validator が報告)
4. extractor の再実行だけでは committed baseline も classification も
   更新されない (§12 promotion lifecycle)。

#### `profile` の source of truth と null lifecycle

- canonical な `profile` / `target` は **classification にのみ存在**。
  generated inventory item 自身に profile/target は持たせない。
- `capabilities.json` の各行も `profile` を持つが、これは capability 自身の
  人間定義であって inventory item の分類の複製ではない。capability が参照
  する upstream item の classified profile と capability 自身の profile が
  不一致なら **validator が fail** する (二つの独立 source of truth を
  許容しない)。
- `profile: null` を許容するのは **candidate inventory の unclassified
  item** に限る (discovery 直後・分類前の状態)。committed baseline の
  resolved view で `profile: null` の item は未分類として classification
  coverage を下げ、validator が検出する (allow するのではなく「未分類が
  ある」こと自体を報告する)。

### 4. Capability chain と requirement model

以下の chain を machine-readable に表現する。

```text
upstream feature (resolved inventory item)
  ↓
profile / scope classification   (classification.json)
  ↓
semantic requirement(s)          (capabilities.json、global requirement ID)
  ↓
required probe(s)                (probes/catalog.json)
  ↓
evidence                         (oracle run results)
  ↓
current run status               (coverage state、oracle-specific)
```

既存 `compat/capabilities.json` を `formatVersion: 2` に拡張してこの chain
を保持する (新フォーマットを別立てしない)。行の拡張例:

```yaml
id: workflows.step.do.replay
profile: workflows-core
upstream:
  symbols: ["cloudflare:workers.WorkflowStep.do"]
  semantic: ["replay-semantics"]
requirements:
  - id: req.workflows.step.do.returns-committed-result
    requiredProbes: ["replay-returns-committed-result"]
  - id: req.workflows.step.do.no-callback-reexecution
    requiredProbes: ["replay-callback-count"]
```

既存 38 capability / 34 probe は backfill 対象 (§Backfill)。`category` は
topic label として残し、`profile` を新規必須フィールドにする。

#### Requirement identity / dedup / counting

- requirement は **globally stable ID** (`req.<profile>.<area>.<name>` 形式)
  を持ち、`capabilities.json` 内の requirement registry に 1 回だけ定義
  される。
- requirement は必ず 1 つの **owning profile** を持つ (capability の
  profile と同一になるよう validator が強制)。
- **denominator の canonical counting unit は requirement**。1 つの
  requirement は所属 profile の denominator に **1 回だけ** 数える。
  複数 inventory item / capability から参照されても denominator は
  増えない (ID で dedup)。
- requirement が複数 upstream item を参照してもよい (many-to-many 許容)。

#### Requirement scope derivation

`target: in-scope|excluded` は resolved inventory item (upstream feature)
の属性であり、requirement は複数 upstream item を参照できるため、
requirement の scope は以下で deterministic に導出する:

```text
1. upstreamRefs を持たない requirement (pure semantic requirement)
   → requirement registry で `target` を明示宣言する (validator が必須化)
2. upstreamRefs を持つ requirement
   → 参照先の resolved inventory item がすべて `target: excluded` かつ
     各 item が `exclusionReason` を持つ場合に限り `excluded`
   → それ以外 (in-scope ref が 1 件でもあれば) は `in-scope`
   → derived scope と矛盾する `target` を requirement が宣言するのは禁止
     (validator failure)
```

つまり in-scope item と excluded item の両方を参照する requirement は
`in-scope` で denominator に 1 回入る。excluded 側の item は upstream
item 単位で引き続き追跡され、requirement counting を減らさない。
excluded requirement は `exclusionReason` を持たない excluded ref や
in-scope ref の存在では成立しないため、「requirement 経由の denominator
縮小」も gated になる。

#### Probe verdict → requirement state への deterministic reduce

各 requirement の state は、その `requiredProbes` の今回 run での
probe verdict を deterministic に reduce して決める。

probe verdict (oracle ごと、per-probe):

```text
VERIFIED    # behavioral contract PASS + differential PASS、fresh evidence
DIVERGENT   # behavioral contract FAIL or differential FAIL (local 側に問題)
BLOCKED     # 実行不能 (credentials / upstream crash / tooling)。blockedReason 付き
UNTESTED    # catalog にあるが今回未実行
STALE       # fingerprint 不一致で過去 evidence が再検証されていない
```

reduction rule (上から順に最初に合致したものが requirement の primary
state になる):

```text
1. requirement が local decision で unsupported 宣言されている → UNSUPPORTED
2. いずれかの required probe が DIVERGENT            → DIVERGENT
3. いずれかの required probe が BLOCKED              → BLOCKED
4. いずれかの required probe が STALE                → STALE
5. いずれかの required probe が UNTESTED / 未実行     → UNTESTED
6. すべての required probe が VERIFIED               → VERIFIED
```

例: `PASS + STALE` → STALE、`PASS + BLOCKED` → BLOCKED、
`DIVERGENT + BLOCKED` → DIVERGENT。
requiredProbe が catalog に存在しないのは state ではなく validator
failure (config error) として扱う。

#### Capability state の導出

capability state はその capability が持つ requirement 群に同じ reduction
rule を適用して導出する (capability 自体が unsupported 宣言されていれば
UNSUPPORTED が優先)。

### 5. Coverage state model (oracle-specific)

各 state は **常に oracle-specific** に計算する
(`VERIFIED@pinned` / `VERIFIED@latest` / `VERIFIED@hosted` は別の値)。
単一の top-level compatibility percentage に合成しない。

| state | 定義 |
| --- | --- |
| `VERIFIED` | 今回の測定対象条件に対して、必要な probe がすべて有効な evidence を持ち、期待条件 (behavioral contract) と upstream differential の両方を満たした |
| `DIVERGENT` | probe は実行できたが、upstream と意味的に異なる |
| `UNSUPPORTED` | **local implementation が in-scope target を実装していない**ことを宣言した状態。`unsupportedReason` 必須。denominator に残す |
| `UNTESTED` | feature / requirement は存在するが probe がない、または今回未実行 |
| `BLOCKED` | credentials、Cloudflare hosted environment、upstream crash、tooling issue などにより判定不能。`blockedReason` 必須 |
| `STALE` | 以前の evidence は存在するが、現在の relevant-input hash / inventory revision / probe revision / upstream candidate / compatibility_date / config fingerprint に対して再検証されていない |

#### Upstream-side failure の扱い (UNSUPPORTED にしない)

Cloudflare 自身が behavioral contract を満たせず crash / failure した
ケース (undocumented crash 含む) は local 実装の問題ではない。これは

```text
state: BLOCKED
blockedReason: upstream-observed-limitation
```

とする。`knownDifference` 記録の併用は可。upstream-side failure を local
`UNSUPPORTED` に読み替えない — `UNSUPPORTED` は **local implementation が
in-scope target を未実装**の場合に限定する。

#### `UNSUPPORTED` と `excluded` の区別

- target scope 内だが未対応・意図的非対応:
  `target: in-scope` + `state: UNSUPPORTED` + `unsupportedReason`。
  **denominator に残る**。
- product scope 外: `target: excluded` + `exclusionReason` (machine-readable
  必須)。denominator に入らない。
- validator / gate は `target: in-scope (UNSUPPORTED)` → `target: excluded`
  への変換を検出し、coverage を人為的に上げる変更を防ぐ。

### 6. Behavioral contract evaluator — `crash == crash` を MATCH にしない

現行 `oracle/check.mjs` の "contract" は **API surface drift** であり、各
behavioral probe の期待値を評価するものではない。用語を分離し、新しい
evaluator を追加する。

#### 3 概念の分離

- `surface contract`: 型・schema・surface の宣言契約 (`oracle/check.mjs`)
- `behavioral contract`: probe ごとの期待挙動 assertion
- `differential result`: cloudflare trace vs local trace の normalized 一致

#### 設計

1. 各 probe は catalog で `contract` block を宣言する (または probe source
   が assertion を emit する)。最低限の例: `expectedStatus`,
   `expectedStepEvents`, `expectError {name, messagePattern}`,
   `expectedOutput`, `expectedSideEffectCount`, `expectedRetryCount`,
   `expectedCallbackCount`, `expectedDurableRecords`,
   `expectedSubscriptionEvents`, `expectedHttp`。
2. **誰が評価するか**: `probe-client.mjs` / `diffRun` を拡張した evaluator
   が、normalized trace を behavioral contract に照合して
   `contract: PASS | FAIL` を **side ごとに** (cloudflare trace と
   local trace のそれぞれに) 計算する。probe 自身が emit した
   `assertions` (callback invocation count、side-effect count 等の
   self-reported fact) も trace に含め、evaluator は emit 値の存在だけで
   なく declared expectation との一致を判定する。
3. **VERIFIED の条件**: `local contract PASS` かつ `differential PASS`。
   どちらか一方だけでは VERIFIED にしない。
4. **crash == crash**: upstream 側が behavioral contract FAIL (crash 等)
   の場合、trace equality があっても VERIFIED にしない。
   `upstream-observed-limitation` として requirement を
   `BLOCKED` に振る (§5)。
5. **contract 未宣言の probe**: `contract: NONE`。behavioral contract
   assertion を持たない probe は VERIFIED の根拠にできない
   (differential の情報量としては使えるが、その probe に依存する
   requirement は VERIFIED に達しない)。

### 7. Evidence freshness — declared vs verified vs current run

現在の declarative evidence (`implemented` / `repository_tested` /
`pinned_differential` / `latest_differential` / `hosted_differential` /
`intentionally_unsupported`) と、current run で実際に確認できた evidence を
分離する。概念的には:

```text
declaredSupport        # 人間/agent が宣言したサポート状況 (旧 evidence flag)
lastVerifiedEvidence   # ある oracle が最後に有効 evidence を残した run + fingerprint (oracle-specific)
currentRunStatus       # 今回の run が実際に観測した結果 (oracle-specific)
```

最終 coverage の分子は `implemented: true` / `latest_differential: true` の
ような手書き flag を直接使わず、current run / valid evidence から導出する。

#### Run result fingerprint

各 oracle run result に最低限以下を保存する (既存の `runId` / `checkedAt` /
`commit` / `candidateId` / `versions` / `runtime` / `probeSourceHash` /
`catalogHash` を拡張):

```text
implementation git commit          # provenance として記録 (STALE 判定 key ではない)
inventory revision/hash            # compat/inventory/* committed baseline の hash
capability matrix revision/hash    # capabilities.json の hash
probe catalog revision/hash        # catalog.json の hash (既存 catalogHash)
probe implementation revision/hash # probes/src の hash (既存 probeSourceHash)
comparison / normalization revision/hash  # normalize.mjs / probe-client.mjs 等の hash
relevant implementation source hash       # runtime/host/kernel 等、coverage に影響する source tree の hash
relevant config/binding hash              # probes/wrangler.jsonc + adapters 設定の hash
upstream candidate identity        # candidate-*.json の id + exact versions
upstream resolved dependencyGraph hash   # 下記参照。candidate.id に現状含まれないため別途保持
wrangler exact version
workerd exact version
workers-types exact version
compatibility_date
compatibility_flags
oracle type                        # pinned | latest | hosted
run id                             # WORKFLOWS_MBT_RUN_ID
run timestamp
```

#### Freshness key — git commit SHA は invalidation key にしない

`implementation git commit` は evidence provenance として記録するが、
README や Issue 文書、無関係な test の commit で全 evidence が STALE になる
のを防ぐため、**freshness invalidation key から分離**する。STALE 判定の
equality key は以下の relevant-input hash のみ:

```text
relevant implementation source hash   # 初期は coarse-grained source tree hash でよい
probe implementation hash
probe catalog hash
normalization/comparison hash
inventory revision/hash
capability/requirement matrix hash
relevant config/binding hash
upstream candidate identity
upstream resolved dependencyGraph hash
compatibility_date / flags
```

これらのいずれかが lastVerifiedEvidence と現在値で一致しない場合にのみ
STALE。必要なら requirement / probe ごとの dependency hash に精細化して
構わないが、repository commit SHA が違うだけでは STALE にしない。

**upstream candidate identity に dependencyGraph hash を含める**。
現行 `compat/candidate.mjs` の `candidate.id` は tracked package の
`{ versions, integrity }` の sha256 で、`dependencyGraph` / `runtime`
(miniflare / workerd / esbuild / unenv 等の transitive runtime graph)
は candidate file に記録されるが identity に入っていない。このため
top-level tuple が同じまま transitive dependency だけが変わると、実際に
起動する Wrangler runtime が変化していても過去 evidence を fresh と
判定し得る。coverage 用の candidate identity は canonical な resolved
dependencyGraph hash (pinned: repo lockfile 由来の install graph、latest:
candidate dir に生成された lockfile 由来の graph、少なくとも Wrangler が
起動する runtime graph) を含めなければならない。graph hash が変われば
identity が変わり、旧 evidence は STALE になる。

#### Hosted evidence

hosted Cloudflare は完全な binary pin を想定しない。hosted evidence は
「Cloudflare production environment + compatibility_date + configuration +
observed timestamp」に対する observation として扱い、pinned / latest の
binary-pin evidence と別系統で記録する。既存の `pinned` / `latest` /
`hosted` oracle 系統は維持・拡張する。

### 8. 比較・normalization 規則

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

### 9. Coverage 指標 (oracle-specific)

すべて percentage ではなく **numerator / denominator** を保持・表示する。
canonical counting unit は requirement。

| metric | 定義 |
| --- | --- |
| inventory classification coverage | `classified discovered upstream features / discovered upstream features`。classified = resolved inventory で `profile` が割り当て済みの item。denominator は discovery boundary が生成した candidate inventory item 全体 (active boundary 内) |
| compatibility coverage (主指標) | `VERIFIED target requirements / all target requirements` (profile × oracle 別)。target requirement = owning profile が active かつ `target: in-scope` の requirement |
| functional coverage | `passed executed requirements / executed requirements`。executed = 今回 run で required probe が実際に実行された requirement (UNTESTED 以外)。compatibility coverage とは別物 |
| practical scenario coverage | `supported practical scenarios / target scenarios`。target scenario は `examples/scenario/` + `compat/run-drill.mjs` 系の committed scenario registry から取る |

表示例 (oracle ごと):

```text
oracle: pinned
workflows-core      92 / 100
workflow-host       31 / 38
binding-adapters    12 / 25
workers-platform    (deferred — not in denominator)
```

### 10. Validation chain の拡張

現状の `check-capabilities.mjs` が検証しているのは
「catalog → capability の整合性」「differential result の全 eligible probe
coverage」「evidence flag と differential result の整合性」。これを
以下の chain 全体に拡張する:

```text
upstream inventory (resolved)
→ scope classification
→ capability
→ semantic requirements
→ probes
→ evidence
```

最低限検出するもの:

- discovered upstream feature に classification がない (unclassified)
- target feature に capability がない
- capability に requirement がない
- requirement に probe がない
- required probe が catalog にない
- probe result が stale (relevant-input hash 不一致)
- claimed VERIFIED に evidence が不足
- result file が部分実行
- evidence fingerprint が current revision と一致しない
- inventory item の classified profile と capability profile の不一致
- `in-scope (UNSUPPORTED)` → `excluded` への再分類 (coverage 水増し防止)
- generated inventory 再生成で human classification が失われた場合
- upstreamRefs を持たない requirement で `target` 未宣言
- requirement の宣言 `target` と derived scope の矛盾 (in-scope ref を持つ
  excluded requirement 等)
- excluded requirement が `exclusionReason` を欠く upstream ref を参照

### 11. Report

`compat/report.mjs` が validator を実行した場合、validator failure を無視し
て正常 report を生成しない (現状: `spawnSync` の exit status を見ていない)。
validator が失敗したら `coverage status = INVALID` とするか、report command
自体を non-zero にする。

差分だけでなく `probeErrors` / `execution error` / `blocked` / `stale` /
`not run` を明示する。Markdown / JSON で最低限以下を出す (oracle ごと):

```text
| Profile | Verified | Divergent | Unsupported | Untested | Blocked | Stale | Total | Coverage |
| workflows-core | 87 | 3 | 2 | 5 | 1 | 2 | 100 | 87.0% |
```

### 12. Change classification と promotion lifecycle

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

#### Daily candidate inventory の promotion lifecycle

daily latest run は committed baseline を直接変更しない。

1. extractor が candidate inventory を `compat-results/` に生成
2. committed baseline と stable ID 単位で `added` / `changed` / `removed`
   を diff → drift packet 化 (既存 `drift-record.mjs` の dedup 機構)
3. classification / capability / requirement / probe の必要変更を
   human または coding agent がレビュー
4. reviewed PR で committed baseline (`compat/inventory/upstream-*.json` +
   `classification.json` + 必要なら `coverage-baseline.json`) を更新。
   baseline 更新 PR も同じ regression gate (§13) を通り、比較対象は
   merge-base 時点の前 baseline。意図的な denominator 縮小は waiver
   metadata を要求する
5. promotion 後は stable ID + drift kind identity で dedup し、同じ drift
   が再通知されない
6. `firstSeen` は baseline に一度記録したら extractor が上書きしない。
   `lastSeen` は extractor の run が観測した最新 candidate で更新する。

例えば API 追加時は

```text
detect upstream symbol
→ candidate inventory に unclassified item
→ CI report
→ Issue / investigation candidate
→ capability mapping
→ semantic requirements
→ probe
→ implementation
→ evidence
```

まで追跡できること。

### 13. Regression gate の baseline

`compat-results/coverage.json` は generated output で fresh checkout で過去
baseline として使えないため、baseline source を明示する。

- **committed baseline manifest**: `compat/coverage-baseline.json`
  (committed)。per-profile × per-oracle の numerator/denominator と
  その算出時の matrixHash / inventoryHash / upstream candidate id を保持。
- **baseline update rule**: `node compat/coverage.mjs --update-baseline`
  で再生成し、reviewed PR でのみ更新 (api-surface.json `--write` と同じ
  運用)。upstream pin tuple 変更 (`update-candidate` 適用) 時は同じ PR で
  baseline も refresh する。
- **比較規則** (PR gate): gate が比較するのは HEAD の current coverage
  と **merge-base / base branch 上の `compat/coverage-baseline.json`**
  であり、HEAD 側の baseline manifest ではない。これにより同じ PR で
  baseline を下げて regression を自己承認することを防ぐ。
  - VERIFIED numerator が base baseline を下回る → fail
  - denominator が base baseline から縮小 → fail (「percentage が
    上がったが denominator が減った」ケースを見逃さない)
- **proposed baseline**: HEAD で `coverage-baseline.json` が変更されて
  いる場合、それは「proposed baseline」として別途検証する:
  - proposed baseline は同じ PR の current coverage と整合すること
    (numerator / denominator が一致)
  - base baseline 対比で non-regressive でない変更 (numerator 減少、
    denominator 縮小) は baseline manifest 内の `waivers[]` エントリを
    必須とする: `{ kind: "denominator-shrink" | "metric-drop" |
    "upstream-pin-update", reason, issue }`。waiver なし → fail
  - upstream pin tuple 変更 (`update-candidate` 適用) による baseline
    refresh は waiver kind `upstream-pin-update` で明示し、per-profile
    差分を drift packet として report する
- `in-scope → excluded` 変更は exclusionReason 付きで明示、
  unsupported→excluded の coverage 水増しを gate が検出 (§10
  validator と同じ規則を baseline diff にも適用)

### 14. 二本立て coverage

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
inventory/schema validation          # resolved inventory + classification + schema
capability validation                # chain validator (check-capabilities 拡張)
pinned oracle                        # 既存 compat:pinned (typecheck + surface contract + differential)
repository tests                     # 既存 npm test 系
coverage calculation                 # compat/coverage.mjs → compat-results/coverage.json (oracle=pinned)
regression gate                      # coverage-baseline.json との比較、INVALID / numerator・denominator 悪化で fail
```

### Daily latest (既存 compat-latest.yml を拡張)

```text
resolve latest upstream versions   # @latest を run 冒頭で一度だけ解決
freeze candidate                   # exact version / identity で固定、run 内で使い回す (既存 candidate.mjs)
extract contract                   # candidate inventory 抽出 (workers-types AST + wrangler schema)
compare inventory                  # committed baseline との stable ID diff → 分類
run latest differential            # 既存
detect docs changes                # 既存 docs-watch → investigation_required
generate investigation packet      # drift-record packet に分類を付与
```

upstream の latest を job 中に無固定で複数回解決しない (現行の shared
candidate 方式を維持)。daily run は committed baseline を変更しない
(§12)。

### Hosted canary / release (credential-gated、既存 compat-hosted.yml を拡張)

```text
deploy dedicated canary
run hosted differential probes
collect evidence
cleanup resources
generate final coverage report     # oracle=hosted の coverage
```

hosted test は専用 namespace / resource prefix を使い、production user data
に触れない設計にする (現行 `workflows-mbt-canary` を prefix 規約として明文化)。
PR の coverage gate に hosted credentials を必須にしない。

## Acceptance criteria

既存の原則 (machine-verifiable):

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

Review で追加された acceptance criteria:

- historical evidence に current fingerprint を後付けしない
- git commit SHA の変化だけでは evidence を STALE にしない
- coverage state は oracle-specific
- target requirement は globally stable ID で一度だけ count
- target denominator の縮小は regression gate で明示的に検出
- intentionally unsupported は target denominator に残る
- upstream-side crash/failure は local UNSUPPORTED に分類しない
- behavioral contract assertion がない probe は VERIFIED にならない
- generated inventory regeneration で human classification を失わない
- active discovery boundary 外の surface を coverage denominator と
  誤表示しない
- new upstream item の candidate → reviewed baseline promotion が追跡可能
- regression gate は base-branch baseline との比較のみで判定し、同じ PR
  での baseline 更新 (proposed baseline) で regression を自己承認できない
- intentional denominator 縮小 / metric 低下は `waivers[]` metadata なしに
  gate を通らない
- in-scope ref を持つ requirement は excluded にできない (scope は
  deterministic に導出)
- transitive dependency graph の変化で upstream candidate identity が
  変わり、旧 evidence が STALE になる

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
compat/inventory/upstream-api.json      # 抽出済み upstream API baseline (committed、machine field のみ)
compat/inventory/upstream-config.json   # Wrangler config baseline (committed)
compat/inventory/semantic.json          # docs/semantics 由来の人手 inventory
compat/inventory/classification.json    # human-owned 分類 (stable ID keyed): profile/target/reason
compat/inventory/discovery-roots.json   # per-profile discovery boundary spec
compat/inventory/extract.mjs            # workers-types AST + wrangler schema の抽出器
compat/check-inventory.mjs              # resolved inventory + classification validator
compat/coverage-baseline.json           # committed coverage baseline (regression gate 用)
compat/capabilities.json                # formatVersion 2: profile / upstream / requirements registry
compat/probes/catalog.json              # 既存維持 + per-probe contract block
compat/check-capabilities.mjs           # chain 全体 validator に拡張
compat/coverage.mjs                     # state 集計 → compat-results/coverage.json
compat/report.mjs                       # validator failure 伝播 + per-profile 表
compat/oracle/check.mjs                 # surface contract: api-surface snapshot → inventory 差分へ接続
compat-results/coverage.json            # per-profile × per-oracle numerator/denominator + item state
compat-results/report.md                # 既存 (coverage 表を追加)
.github/workflows/ci.yml                # PR: inventory validation + coverage gate
.github/workflows/compat-latest.yml     # daily: extract/compare inventory
.github/workflows/compat-hosted.yml     # hosted: final coverage report
```

`compat/inventory/` 配下は baseline JSON + 抽出器 + 分類 spec のみ。run 時の
生成物は `compat-results/` に集約し、commit 済みファイルと generated を
混ぜない。`compat/inventory/upstream-*.json` は machine field のみ持ち、
分類情報は `classification.json` だけが持つ。

## 実装 phase (依存関係順)

- **Phase 1 — foundation**: profile taxonomy + lifecycle (active/deferred),
  state model 定義 (oracle-specific), denominator rule, extended result
  schema (fingerprint fields、relevant-input hash), evidence freshness model
  (`declaredSupport` / `lastVerifiedEvidence` / `currentRunStatus`)
- **Phase 2 — discovery + inventory extraction**: `discovery-roots.json`、
  `inventory/extract.mjs` (TypeScript AST over candidate workers-types +
  wrangler `config-schema.json` walk)、stable ID 採番、contract
  fingerprint、committed baseline JSON、`check-inventory.mjs`
  (unclassified / undetected chain の検出)
- **Phase 3 — classification + chain mapping**: `classification.json`、
  capabilities.json formatVersion 2 (profile + upstream refs +
  requirements/requiredProbes)、既存 38 capability / 34 probe の backfill
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
ただし provenance を捏造しない。

- 既存 capability 行 → `profile` 付与 + upstream symbol mapping
  (例: `step.do` → `cloudflare:workers.WorkflowStep.do`)
- upstream symbol を持たない行 → `semantic` inventory item として登録
- **既存 differential result は `legacy` evidence として保持する**。
  過去 result が inventory hash / capability hash / normalization hash /
  config hash を実際に記録していないのに現在値を後付けすると false
  provenance になるため、必要な fingerprint が欠ける evidence は
  VERIFIED に使わず `STALE` / `legacy-unverified` とする。新 schema で
  再実行した結果だけを最初の valid `lastVerifiedEvidence` にする。
- `intentionally_unsupported` 行 → **`target: in-scope` のまま
  `state: UNSUPPORTED` + `unsupportedReason`** に移行 (denominator に
  残す)。`target: excluded` への変換は `exclusionReason` が別途必要で、
  coverage を上げる目的の変換は validator/gate が検出する。
- COMPATIBILITY.md の checkbox は人間向け説明として維持し、coverage 数値の
  source of truth は coverage.json に移す
