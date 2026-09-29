import { randomUUID } from "node:crypto";
import { MessageChannel, Worker, receiveMessageOnPort } from "node:worker_threads";
import { Storage } from "./storage.mjs";

// PostgreSQL implementation of the workflow-semantic storage contract —
// the portability proof that the runtime is not SQLite-specific.
//
// `pg` is an optional dependency and asynchronous, while the Storage contract
// is synchronous (callers use results immediately, like better-sqlite3). The
// real client therefore lives in postgres-worker.mjs on a worker thread; each
// method call is a request/response exchange: postMessage the request, block
// on a SharedArrayBuffer flag with Atomics.wait, then pull the reply with
// receiveMessageOnPort. Calls are fully serialized, so a BEGIN..COMMIT pair
// gives each multi-statement boundary the same single-writer atomicity the
// SQLite adapter gets from db.transaction().
//
// Lease fencing parity: assertLease uses SELECT ... FOR UPDATE inside the
// committing transaction. The row lock serializes the fence check against a
// competing claimInstance() UPDATE on the same instance row, so a stalled
// executor cannot commit after another executor has claimed the instance.
// Per-instance rows are only ever mutated by the lease holder, so READ
// COMMITTED suffices everywhere else.
export class PostgresStorage extends Storage {
  constructor(connectionString, { timeoutMs = 30_000, schema = null } = {}) {
    super();
    if (!connectionString) {
      throw new Error("PostgreSQL storage requires a connection string");
    }
    this.#timeoutMs = timeoutMs;
    this.#flag = new Int32Array(new SharedArrayBuffer(4));
    const channel = new MessageChannel();
    this.#port = channel.port1;
    this.#worker = new Worker(
      new URL("./postgres-worker.mjs", import.meta.url),
      {
        workerData: { flag: this.#flag },
        // Inheriting execArgv breaks the worker: --input-type only applies to
        // --eval/STDIN input, and node:test injects V8 flags that worker
        // threads reject (ERR_WORKER_INVALID_EXEC_ARGV). The .mjs entry is
        // ESM regardless, so no flags are needed.
        execArgv: [],
      },
    );
    this.#worker.on("error", (error) => {
      this.#workerError = error;
      // Wake a blocked caller so it surfaces the failure instead of waiting
      // out the timeout.
      Atomics.add(this.#flag, 0, 1);
      Atomics.notify(this.#flag, 0);
    });
    this.#worker.postMessage({ port: channel.port2 }, [channel.port2]);
    try {
      this.#call({ op: "connect", connectionString });
      if (schema != null) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
          throw new Error(`Invalid PostgreSQL storage schema name: ${schema}`);
        }
        this.#run(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
        this.#run(`SET search_path TO "${schema}"`);
      }
      this.#schema();
      this.#migrate();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  #worker;
  #port;
  #flag;
  #seq = 0;
  #timeoutMs;
  #workerError = null;

  #call(message) {
    if (this.#workerError) throw this.#workerError;
    const id = (this.#seq += 1);
    const before = Atomics.load(this.#flag, 0);
    this.#worker.postMessage({ id, ...message });
    while (Atomics.load(this.#flag, 0) === before) {
      const waited = Atomics.wait(this.#flag, 0, before, this.#timeoutMs);
      if (waited === "timed-out") {
        throw new Error(
          `PostgreSQL storage worker did not respond within ${this.#timeoutMs}ms`,
        );
      }
    }
    if (this.#workerError) throw this.#workerError;
    for (;;) {
      const received = receiveMessageOnPort(this.#port);
      if (!received) {
        throw new Error("PostgreSQL storage worker returned no result");
      }
      const reply = received.message;
      if (reply.id !== id) continue;
      if (!reply.ok) {
        const error = new Error(reply.error?.message ?? "PostgreSQL query failed");
        error.name = reply.error?.name ?? "Error";
        if (reply.error?.code != null) error.code = reply.error.code;
        throw error;
      }
      return reply.result;
    }
  }

  #run(text, values = []) {
    return this.#call({ op: "query", text, values });
  }

  #one(text, values = []) {
    return this.#run(text, values).rows[0] ?? null;
  }

  #all(text, values = []) {
    return this.#run(text, values).rows;
  }

  // Single-connection equivalent of better-sqlite3's db.transaction(fn).
  #tx(fn) {
    this.#run("BEGIN");
    try {
      const result = fn();
      this.#run("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#run("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  #schema() {
    const ddl = [
      `CREATE TABLE IF NOT EXISTS workflows (
        name TEXT PRIMARY KEY,
        binding TEXT NOT NULL,
        class_name TEXT NOT NULL,
        main TEXT NOT NULL,
        updated_at BIGINT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS instances (
        id TEXT PRIMARY KEY,
        public_id TEXT NOT NULL,
        workflow_name TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL,
        output TEXT,
        error TEXT,
        rollback_outcome TEXT,
        rollback_error TEXT,
        rollback_cause TEXT,
        rollback_terminal_status TEXT,
        schedule_cron TEXT,
        scheduled_time BIGINT,
        success_retention_ms BIGINT,
        error_retention_ms BIGINT,
        expires_at BIGINT,
        lease_owner TEXT,
        lease_expires_at BIGINT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        FOREIGN KEY(workflow_name) REFERENCES workflows(name)
      )`,
      `CREATE TABLE IF NOT EXISTS steps (
        instance_id TEXT NOT NULL,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        count INTEGER NOT NULL,
        ordinal INTEGER NOT NULL,
        state TEXT NOT NULL,
        config TEXT,
        output TEXT,
        error TEXT,
        event_type TEXT,
        created_at BIGINT NOT NULL,
        completed_at BIGINT,
        PRIMARY KEY(instance_id, type, name, count),
        FOREIGN KEY(instance_id) REFERENCES instances(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS attempts (
        instance_id TEXT NOT NULL,
        step_type TEXT NOT NULL,
        step_name TEXT NOT NULL,
        step_count INTEGER NOT NULL,
        attempt INTEGER NOT NULL,
        state TEXT NOT NULL,
        started_at BIGINT NOT NULL,
        finished_at BIGINT,
        error TEXT,
        PRIMARY KEY(instance_id, step_type, step_name, step_count, attempt),
        FOREIGN KEY(instance_id) REFERENCES instances(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS timers (
        instance_id TEXT NOT NULL,
        step_type TEXT NOT NULL,
        step_name TEXT NOT NULL,
        step_count INTEGER NOT NULL,
        kind TEXT NOT NULL,
        wake_at BIGINT NOT NULL,
        created_at BIGINT NOT NULL,
        PRIMARY KEY(instance_id, step_type, step_name, step_count, kind),
        FOREIGN KEY(instance_id) REFERENCES instances(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS events (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        instance_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        consumed_at BIGINT,
        FOREIGN KEY(instance_id) REFERENCES instances(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS rollback_registrations (
        instance_id TEXT NOT NULL,
        step_type TEXT NOT NULL,
        step_name TEXT NOT NULL,
        step_count INTEGER NOT NULL,
        ordinal INTEGER,
        state TEXT NOT NULL,
        config TEXT,
        output TEXT,
        step_error TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        wake_at BIGINT,
        rollback_error TEXT,
        created_at BIGINT NOT NULL,
        completed_at BIGINT,
        PRIMARY KEY(instance_id, step_type, step_name, step_count),
        FOREIGN KEY(instance_id) REFERENCES instances(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS workflow_schedules (
        workflow_name TEXT NOT NULL,
        cron TEXT NOT NULL,
        last_checked_at BIGINT NOT NULL,
        PRIMARY KEY(workflow_name, cron),
        FOREIGN KEY(workflow_name) REFERENCES workflows(name)
      )`,
      `CREATE TABLE IF NOT EXISTS scheduled_runs (
        workflow_name TEXT NOT NULL,
        cron TEXT NOT NULL,
        scheduled_time BIGINT NOT NULL,
        instance_id TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        PRIMARY KEY(workflow_name, cron, scheduled_time),
        FOREIGN KEY(instance_id) REFERENCES instances(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS execution_events (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        instance_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        detail TEXT,
        created_at BIGINT NOT NULL,
        FOREIGN KEY(instance_id) REFERENCES instances(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS step_streams (
        id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL,
        step_type TEXT NOT NULL,
        step_name TEXT NOT NULL,
        step_count INTEGER NOT NULL,
        state TEXT NOT NULL,
        byte_length BIGINT NOT NULL DEFAULT 0,
        chunk_count BIGINT NOT NULL DEFAULT 0,
        created_at BIGINT NOT NULL,
        FOREIGN KEY(instance_id) REFERENCES instances(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS stream_chunks (
        stream_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        bytes BYTEA NOT NULL,
        PRIMARY KEY(stream_id, seq),
        FOREIGN KEY(stream_id) REFERENCES step_streams(id) ON DELETE CASCADE
      )`,
      `CREATE INDEX IF NOT EXISTS idx_instances_status ON instances(status)`,
      `CREATE INDEX IF NOT EXISTS idx_timers_wake ON timers(wake_at)`,
      `CREATE INDEX IF NOT EXISTS idx_events_unconsumed ON events(instance_id, type, consumed_at)`,
      `CREATE INDEX IF NOT EXISTS idx_steps_ordinal ON steps(instance_id, ordinal)`,
      `CREATE INDEX IF NOT EXISTS idx_rollback_runnable
        ON rollback_registrations(instance_id, state, wake_at)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_instances_workflow_public_id
        ON instances(workflow_name, public_id)`,
    ];
    for (const statement of ddl) this.#run(statement);
  }

  // Schema upgrades for databases created by an earlier revision of this
  // adapter, mirroring SQLiteStorage.#migrate().
  #migrate() {
    const ensureColumn = (table, name, definition) => {
      const columns = this.#all(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = $1`,
        [table],
      );
      if (!columns.some((column) => column.column_name === name)) {
        this.#run(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      }
    };
    ensureColumn("instances", "public_id", "TEXT");
    this.#run(
      "UPDATE instances SET public_id=id WHERE public_id IS NULL",
    );
    ensureColumn("instances", "rollback_outcome", "TEXT");
    ensureColumn("instances", "rollback_error", "TEXT");
    ensureColumn("instances", "rollback_cause", "TEXT");
    ensureColumn("instances", "rollback_terminal_status", "TEXT");
    ensureColumn("instances", "schedule_cron", "TEXT");
    ensureColumn("instances", "scheduled_time", "BIGINT");
    ensureColumn("instances", "success_retention_ms", "BIGINT");
    ensureColumn("instances", "error_retention_ms", "BIGINT");
    ensureColumn("instances", "expires_at", "BIGINT");
    ensureColumn("rollback_registrations", "ordinal", "INTEGER");
    ensureColumn("rollback_registrations", "output", "TEXT");
    ensureColumn("rollback_registrations", "step_error", "TEXT");
    ensureColumn(
      "rollback_registrations",
      "attempt",
      "INTEGER NOT NULL DEFAULT 0",
    );
    ensureColumn("rollback_registrations", "wake_at", "BIGINT");
    ensureColumn("rollback_registrations", "rollback_error", "TEXT");
    ensureColumn("rollback_registrations", "completed_at", "BIGINT");
    ensureColumn("instances", "lease_owner", "TEXT");
    ensureColumn("instances", "lease_expires_at", "BIGINT");
  }

  registerWorkflow(workflow) {
    this.#run(
      `INSERT INTO workflows(name, binding, class_name, main, updated_at)
       VALUES($1, $2, $3, $4, $5)
       ON CONFLICT(name) DO UPDATE SET
         binding=excluded.binding, class_name=excluded.class_name,
         main=excluded.main, updated_at=excluded.updated_at`,
      [workflow.name, workflow.binding, workflow.className, workflow.main, Date.now()],
    );
  }

  createInstance({
    id,
    workflowName,
    payload,
    schedule = null,
    retention = null,
  }) {
    if (this.getInstanceByPublic(workflowName, id)) {
      const error = new Error(`Workflow instance already exists: ${id}`);
      error.alreadyExists = true;
      throw error;
    }
    let storageId = id;
    if (this.getInstance(storageId)) {
      do {
        storageId = `wf_${randomUUID()}`;
      } while (this.getInstance(storageId));
    }
    const now = Date.now();
    try {
      this.#run(
        `INSERT INTO instances(
          id, public_id, workflow_name, status, payload, schedule_cron, scheduled_time,
          success_retention_ms, error_retention_ms, expires_at,
          created_at, updated_at
        )
        VALUES($1, $2, $3, 'queued', $4, $5, $6, $7, $8, NULL, $9, $10)`,
        [
          storageId, id, workflowName, payload,
          schedule?.cron ?? null, schedule?.scheduledTime ?? null,
          retention?.successRetentionMs ?? null,
          retention?.errorRetentionMs ?? null,
          now, now,
        ],
      );
    } catch (error) {
      // Two processes can pass the existence check at once; the unique index
      // decides, and the loser reports the same contract error.
      if (error.code === "23505") {
        const duplicate = new Error(`Workflow instance already exists: ${id}`);
        duplicate.alreadyExists = true;
        throw duplicate;
      }
      throw error;
    }
    this.log(storageId, "instance.created", null);
    return this.getInstance(storageId);
  }

  claimScheduledInstance({
    id,
    workflowName,
    payload,
    cron,
    scheduledTime,
    retention = null,
  }) {
    try {
      return this.#tx(() => {
        const existing = this.#one(
          `SELECT instance_id FROM scheduled_runs
           WHERE workflow_name=$1 AND cron=$2 AND scheduled_time=$3`,
          [workflowName, cron, scheduledTime],
        );
        if (existing) {
          return { created: false, id: existing.instance_id };
        }

        const instance = this.createInstance({
          id,
          workflowName,
          payload,
          schedule: { cron, scheduledTime },
          retention,
        });
        // A concurrent claimant blocks on the unique key until our transaction
        // commits, then inserts nothing — rolling back its orphan instance row.
        const inserted = this.#run(
          `INSERT INTO scheduled_runs(
            workflow_name, cron, scheduled_time, instance_id, created_at
          ) VALUES($1, $2, $3, $4, $5)
          ON CONFLICT(workflow_name, cron, scheduled_time) DO NOTHING`,
          [workflowName, cron, scheduledTime, instance.id, Date.now()],
        );
        if (inserted.rowCount === 0) {
          throw new ClaimLost();
        }
        this.log(
          instance.id,
          "instance.scheduled",
          JSON.stringify({ cron, scheduledTime }),
        );
        return { created: true, id: instance.public_id };
      });
    } catch (error) {
      if (!(error instanceof ClaimLost)) throw error;
      const winner = this.#one(
        `SELECT instance_id FROM scheduled_runs
         WHERE workflow_name=$1 AND cron=$2 AND scheduled_time=$3`,
        [workflowName, cron, scheduledTime],
      );
      return { created: false, id: winner.instance_id };
    }
  }

  getScheduleCursor(workflowName, cron) {
    return this.#one(
      `SELECT last_checked_at FROM workflow_schedules
       WHERE workflow_name=$1 AND cron=$2`,
      [workflowName, cron],
    )?.last_checked_at ?? null;
  }

  setScheduleCursor(workflowName, cron, lastCheckedAt) {
    this.#run(
      `INSERT INTO workflow_schedules(workflow_name, cron, last_checked_at)
       VALUES($1, $2, $3)
       ON CONFLICT(workflow_name, cron)
       DO UPDATE SET last_checked_at=excluded.last_checked_at`,
      [workflowName, cron, Math.trunc(lastCheckedAt)],
    );
  }

  // Executor leases: exactly one live executor may run an instance. A lease is
  // held only while the instance executes; suspension and terminal states
  // release it, and an expired lease is treated as a crashed executor.
  claimInstance(id, owner, ttlMs, now = Date.now()) {
    return this.#run(
      `UPDATE instances
       SET lease_owner=$1, lease_expires_at=$2
       WHERE id=$3
         AND (lease_expires_at IS NULL OR lease_expires_at <= $4 OR lease_owner=$1)`,
      [owner, now + ttlMs, id, now],
    ).rowCount === 1;
  }

  renewLease(id, owner, ttlMs, now = Date.now()) {
    return this.#run(
      `UPDATE instances SET lease_expires_at=$1
       WHERE id=$2 AND lease_owner=$3`,
      [now + ttlMs, id, owner],
    ).rowCount === 1;
  }

  releaseLease(id, owner) {
    return this.#run(
      `UPDATE instances SET lease_owner=NULL, lease_expires_at=NULL
       WHERE id=$1 AND lease_owner=$2`,
      [id, owner],
    ).rowCount === 1;
  }

  // Fencing check executed inside committing transactions. FOR UPDATE takes
  // the instance row lock, so the check is serialized against a concurrent
  // claimInstance() UPDATE — a commit can never land after a new owner has
  // claimed the instance. `lease` is the caller's executorId; null skips the
  // check (lifecycle commands are unfenced).
  assertLease(instanceId, lease) {
    if (lease == null) return;
    const row = this.#one(
      "SELECT lease_owner, lease_expires_at FROM instances WHERE id=$1 FOR UPDATE",
      [instanceId],
    );
    if (
      !row ||
      row.lease_owner !== lease ||
      (row.lease_expires_at != null && row.lease_expires_at <= Date.now())
    ) {
      const error = new Error(
        `Executor lease lost for workflow instance ${instanceId}`,
      );
      error.name = "WorkflowLeaseLostError";
      throw error;
    }
  }

  deleteExpired(now = Date.now()) {
    return this.#run(
      "DELETE FROM instances WHERE expires_at IS NOT NULL AND expires_at <= $1",
      [now],
    ).rowCount;
  }

  getInstance(id) {
    return this.#one("SELECT * FROM instances WHERE id = $1", [id]);
  }

  getInstanceByPublic(workflowName, publicId) {
    return this.#one(
      "SELECT * FROM instances WHERE workflow_name=$1 AND public_id=$2",
      [workflowName, publicId],
    );
  }

  findInstancesByPublic(publicId) {
    return this.#all(
      "SELECT * FROM instances WHERE public_id=$1 ORDER BY created_at",
      [publicId],
    );
  }

  listInstances(workflowName, { status = null, offset = 0, limit = null } = {}) {
    this.deleteExpired(Date.now());
    const where = status == null
      ? "workflow_name = $1"
      : "workflow_name = $1 AND status = $2";
    const args = status == null ? [workflowName] : [workflowName, status];
    const total = this.#one(
      `SELECT COUNT(*)::int AS n FROM instances WHERE ${where}`,
      args,
    ).n;
    const paged = limit == null
      ? this.#all(
          `SELECT * FROM instances WHERE ${where} ORDER BY created_at`,
          args,
        )
      : this.#all(
          `SELECT * FROM instances WHERE ${where}
           ORDER BY created_at LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
          [...args, limit, offset],
        );
    return { rows: paged, total };
  }

  setInstanceStatus(id, status, { output = undefined, error = undefined } = {}, lease = null) {
    return this.#tx(() => {
      this.assertLease(id, lease);
      this.#setInstanceStatusInner(id, status, { output, error });
    });
  }

  #setInstanceStatusInner(id, status, { output = undefined, error = undefined } = {}) {
    const current = this.getInstance(id);
    if (!current) throw new Error(`Unknown workflow instance: ${id}`);
    const nextOutput = output === undefined ? current.output : output;
    const nextError = error === undefined ? current.error : error;
    const now = Date.now();
    let expiresAt = current.expires_at;
    if (status === "complete" || status === "terminated") {
      expiresAt = current.success_retention_ms == null
        ? null
        : now + current.success_retention_ms;
    } else if (status === "errored") {
      expiresAt = current.error_retention_ms == null
        ? null
        : now + current.error_retention_ms;
    }
    this.#run(
      `UPDATE instances
       SET status=$1, output=$2, error=$3, expires_at=$4, updated_at=$5
       WHERE id=$6`,
      [status, nextOutput, nextError, expiresAt, now, id],
    );
    if (current.status !== status) {
      this.log(
        id,
        `instance.${status}`,
        JSON.stringify({ output: nextOutput, error: nextError }),
      );
    }
  }

  deleteInstance(id) {
    return this.#run(
      "DELETE FROM instances WHERE id = $1",
      [id],
    ).rowCount > 0;
  }

  // Instances leased to a live foreign executor are not runnable here: they
  // stay out of the result set until the lease expires or is released.
  listRunnable(now = Date.now(), executorId = null) {
    return this.#all(
      `SELECT DISTINCT i.*
       FROM instances i
       LEFT JOIN timers t ON t.instance_id = i.id
       WHERE (
           i.lease_owner IS NULL
           OR i.lease_owner = $1
           OR i.lease_expires_at <= $2
         )
         AND (
           i.status IN ('queued', 'running')
          OR (i.status = 'waiting' AND t.wake_at <= $2)
          OR (
            i.status = 'rollingBack'
            AND (
              NOT EXISTS (
                SELECT 1 FROM rollback_registrations rr0
                WHERE rr0.instance_id = i.id
              )
              OR EXISTS (
                SELECT 1 FROM rollback_registrations rr
                WHERE rr.instance_id = i.id
                  AND (
                    rr.state IN ('pending', 'running')
                    OR (rr.state = 'waiting_retry' AND rr.wake_at <= $2)
                  )
              )
            )
          )
         )
       ORDER BY i.created_at`,
      [executorId, now],
    );
  }

  getStep(identity) {
    return this.#one(
      `SELECT * FROM steps WHERE instance_id=$1 AND type=$2 AND name=$3 AND count=$4`,
      [identity.instanceId, identity.type, identity.name, identity.count],
    );
  }

  listSteps(instanceId) {
    return this.#all(
      "SELECT * FROM steps WHERE instance_id=$1 ORDER BY ordinal",
      [instanceId],
    );
  }

  ensureStep(identity, ordinal, state, config, eventType = null, lease = null) {
    return this.#tx(() => {
      this.assertLease(identity.instanceId, lease);
      return this.#ensureStepInner(identity, ordinal, state, config, eventType);
    });
  }

  #ensureStepInner(identity, ordinal, state, config, eventType = null) {
    const result = this.#run(
      `INSERT INTO steps(
        instance_id, type, name, count, ordinal, state, config, event_type, created_at
      ) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT(instance_id, type, name, count) DO NOTHING`,
      [
        identity.instanceId, identity.type, identity.name, identity.count,
        ordinal, state, config, eventType, Date.now(),
      ],
    );
    if (result.rowCount > 0) {
      if (identity.type === "do") {
        this.log(
          identity.instanceId,
          "step.started",
          JSON.stringify({ name: `${identity.name}-${identity.count}`, config }),
        );
      } else if (identity.type === "sleep") {
        let durationMs;
        try {
          const parsed = JSON.parse(config ?? "{}");
          durationMs = typeof parsed.durationMs === "number"
            ? parsed.durationMs
            : undefined;
        } catch {}
        this.log(
          identity.instanceId,
          "sleep.started",
          JSON.stringify({ name: `${identity.name}-${identity.count}`, durationMs }),
        );
      } else if (identity.type === "waitForEvent") {
        this.log(
          identity.instanceId,
          "wait.started",
          JSON.stringify({ name: `${identity.name}-${identity.count}`, eventType }),
        );
      }
    }
    return this.getStep(identity);
  }

  updateStep(identity, fields, lease = null) {
    return this.#tx(() => {
      this.assertLease(identity.instanceId, lease);
      this.#updateStepInner(identity, fields);
    });
  }

  #updateStepInner(identity, fields) {
    const allowed = ["state", "config", "output", "error", "event_type", "completed_at"];
    const entries = Object.entries(fields).filter(([key]) => allowed.includes(key));
    if (!entries.length) return;
    const sets = entries.map(([key], i) => `${key} = $${i + 5}`).join(", ");
    this.#run(
      `UPDATE steps SET ${sets}
       WHERE instance_id=$1 AND type=$2 AND name=$3 AND count=$4`,
      [
        identity.instanceId, identity.type, identity.name, identity.count,
        ...entries.map(([, value]) => value),
      ],
    );
  }

  startAttempt(identity, attempt, lease = null) {
    this.#tx(() => {
      this.assertLease(identity.instanceId, lease);
      this.#run(
        `INSERT INTO attempts(
          instance_id, step_type, step_name, step_count, attempt, state, started_at
        ) VALUES($1, $2, $3, $4, $5, 'running', $6)`,
        [
          identity.instanceId, identity.type, identity.name, identity.count,
          attempt, Date.now(),
        ],
      );
      this.log(
        identity.instanceId,
        "attempt.started",
        JSON.stringify({ name: `${identity.name}-${identity.count}`, attempt }),
      );
    });
  }

  finishAttempt(identity, attempt, state, error = null, retryDelayMs = null, lease = null) {
    this.#tx(() => {
      this.assertLease(identity.instanceId, lease);
      this.#finishAttemptInner(identity, attempt, state, error, retryDelayMs);
    });
  }

  #finishAttemptInner(identity, attempt, state, error = null, retryDelayMs = null) {
    this.#run(
      `UPDATE attempts SET state=$1, finished_at=$2, error=$3
       WHERE instance_id=$4 AND step_type=$5 AND step_name=$6 AND step_count=$7 AND attempt=$8`,
      [
        state, Date.now(), error, identity.instanceId, identity.type,
        identity.name, identity.count, attempt,
      ],
    );
    this.log(
      identity.instanceId,
      state === "completed" ? "attempt.completed" : "attempt.errored",
      JSON.stringify({
        name: `${identity.name}-${identity.count}`,
        attempt,
        error,
        retryDelayMs,
      }),
    );
  }

  countAttempts(identity) {
    return this.#one(
      `SELECT COUNT(*)::int AS n FROM attempts
       WHERE instance_id=$1 AND step_type=$2 AND step_name=$3 AND step_count=$4`,
      [identity.instanceId, identity.type, identity.name, identity.count],
    ).n;
  }

  listAttempts(identity) {
    return this.#all(
      `SELECT * FROM attempts
       WHERE instance_id=$1 AND step_type=$2 AND step_name=$3 AND step_count=$4
       ORDER BY attempt`,
      [identity.instanceId, identity.type, identity.name, identity.count],
    );
  }

  completeDoStep(identity, attempt, output, rollback = null, stream = null, lease = null) {
    this.#tx(() => {
      this.assertLease(identity.instanceId, lease);
      this.#finishAttemptInner(identity, attempt, "completed", null);
      this.#updateStepInner(identity, {
        state: "completed", output, error: null, completed_at: Date.now(),
      });
      // The stream becomes visible in the same transaction that commits the
      // step result, so readers never observe a partially-written stream.
      if (stream) this.commitStream(stream.id, stream.bytes, stream.chunks);
      const step = this.getStep(identity);
      let sensitiveOutput = false;
      try {
        sensitiveOutput = JSON.parse(step?.config ?? "{}")?.sensitive === "output";
      } catch {}
      this.log(
        identity.instanceId,
        "step.completed",
        JSON.stringify({
          name: `${identity.name}-${identity.count}`,
          ...(stream
            ? { stream: true, bytes: stream.bytes }
            : {
                output: sensitiveOutput ? null : output,
                redacted: sensitiveOutput,
              }),
        }),
      );
      if (rollback) {
        this.#registerRollbackInner(
          identity, identity.ordinal, rollback.config, output, null,
        );
      }
      this.#deleteTimerInner(identity, "retry");
      this.#deleteTimerInner(identity, "attempt-timeout");
    });
  }

  // `error` is the event/attempt-surface error; `stepError` is what replay
  // rethrows to run() — they differ for terminal NonRetryableError failures,
  // which Cloudflare reports as WorkflowFatalError while the rejection seen by
  // workflow code is a plain Error.
  finishDoStepTerminal(identity, attempt, error, rollback = null, stepError = null, lease = null) {
    this.#tx(() => {
      this.assertLease(identity.instanceId, lease);
      this.#finishAttemptInner(identity, attempt, "failed", error);
      this.#updateStepInner(identity, {
        state: "failed", error: stepError ?? error, completed_at: Date.now(),
      });
      this.log(
        identity.instanceId,
        "step.errored",
        JSON.stringify({ name: `${identity.name}-${identity.count}`, error }),
      );
      if (rollback) {
        this.#registerRollbackInner(
          identity, identity.ordinal, rollback.config, null, error,
        );
      }
      this.#deleteTimerInner(identity, "retry");
      this.#deleteTimerInner(identity, "attempt-timeout");
    });
  }

  // Output-serialization failures complete the attempt (the work ran fine —
  // the result could not be persisted) and fail the step without a
  // step.errored event, matching Cloudflare's event surface.
  failDoStepSerialization(identity, attempt, error, rollback = null, lease = null) {
    this.#tx(() => {
      this.assertLease(identity.instanceId, lease);
      this.#finishAttemptInner(identity, attempt, "completed", null);
      this.#updateStepInner(identity, {
        state: "failed", error, completed_at: Date.now(),
      });
      if (rollback) {
        this.#registerRollbackInner(
          identity, identity.ordinal, rollback.config, null, error,
        );
      }
      this.#deleteTimerInner(identity, "retry");
      this.#deleteTimerInner(identity, "attempt-timeout");
    });
  }

  scheduleRetry(identity, attempt, error, wakeAt, lease = null) {
    this.#tx(() => {
      this.assertLease(identity.instanceId, lease);
      const retryDelayMs = Math.max(0, Math.trunc(wakeAt - Date.now()));
      this.#finishAttemptInner(identity, attempt, "failed", error, retryDelayMs);
      this.#updateStepInner(identity, { state: "waiting_retry", error, completed_at: null });
      this.#putTimerInner(identity, "retry", wakeAt);
      this.#deleteTimerInner(identity, "attempt-timeout");
    });
  }

  putTimer(identity, kind, wakeAt, lease = null) {
    this.#tx(() => {
      this.assertLease(identity.instanceId, lease);
      this.#putTimerInner(identity, kind, wakeAt);
    });
  }

  #putTimerInner(identity, kind, wakeAt) {
    this.#run(
      `INSERT INTO timers(
        instance_id, step_type, step_name, step_count, kind, wake_at, created_at
      ) VALUES($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT(instance_id, step_type, step_name, step_count, kind)
      DO UPDATE SET wake_at=excluded.wake_at`,
      [
        identity.instanceId, identity.type, identity.name, identity.count,
        kind, Math.trunc(wakeAt), Date.now(),
      ],
    );
  }

  getTimer(identity, kind) {
    return this.#one(
      `SELECT * FROM timers
       WHERE instance_id=$1 AND step_type=$2 AND step_name=$3 AND step_count=$4 AND kind=$5`,
      [
        identity.instanceId, identity.type, identity.name, identity.count, kind,
      ],
    );
  }

  deleteTimer(identity, kind, lease = null) {
    this.#tx(() => {
      this.assertLease(identity.instanceId, lease);
      this.#deleteTimerInner(identity, kind);
    });
  }

  #deleteTimerInner(identity, kind) {
    this.#run(
      `DELETE FROM timers
       WHERE instance_id=$1 AND step_type=$2 AND step_name=$3 AND step_count=$4 AND kind=$5`,
      [identity.instanceId, identity.type, identity.name, identity.count, kind],
    );
  }

  waitOnTimer(identity, ordinal, config, kind, wakeAt, lease = null) {
    return this.#tx(() => {
      this.assertLease(identity.instanceId, lease);
      const step = this.#ensureStepInner(identity, ordinal, "waiting", config);
      let timer = this.getTimer(identity, kind);
      if (!timer && step.state !== "completed") {
        this.#putTimerInner(identity, kind, wakeAt);
        timer = this.getTimer(identity, kind);
      }
      return { step: this.getStep(identity), timer };
    });
  }

  completeTimerStep(identity, kind, lease = null) {
    this.#tx(() => {
      this.assertLease(identity.instanceId, lease);
      this.#updateStepInner(identity, {
        state: "completed", output: null, error: null, completed_at: Date.now(),
      });
      this.#deleteTimerInner(identity, kind);
      if (kind === "sleep") {
        this.log(
          identity.instanceId,
          "sleep.completed",
          JSON.stringify({ name: `${identity.name}-${identity.count}` }),
        );
      }
    });
  }

  waitForEvent(identity, ordinal, config, eventType, wakeAt, encodedEvent, lease = null) {
    return this.#tx(() => {
      this.assertLease(identity.instanceId, lease);
      const step = this.#ensureStepInner(
        identity, ordinal, "waiting", config, eventType,
      );
      if (step.state === "completed") return { step, event: null, timer: null };

      // FOR UPDATE serializes the consume against another waiter racing for
      // the same buffered event.
      const event = this.#one(
        `SELECT * FROM events
         WHERE instance_id=$1 AND type=$2 AND consumed_at IS NULL
         ORDER BY id LIMIT 1
         FOR UPDATE`,
        [identity.instanceId, eventType],
      );

      if (event) {
        const consumedAt = Date.now();
        this.#run(
          "UPDATE events SET consumed_at=$1 WHERE id=$2",
          [consumedAt, event.id],
        );
        const output = encodedEvent({ ...event, consumed_at: consumedAt });
        this.#updateStepInner(identity, {
          state: "completed", output, error: null, completed_at: consumedAt,
        });
        this.#deleteTimerInner(identity, "event-timeout");
        this.log(
          identity.instanceId,
          "wait.completed",
          JSON.stringify({ name: `${identity.name}-${identity.count}` }),
        );
        return { step: this.getStep(identity), event, timer: null };
      }

      let timer = this.getTimer(identity, "event-timeout");
      if (!timer) {
        this.#putTimerInner(identity, "event-timeout", wakeAt);
        timer = this.getTimer(identity, "event-timeout");
      }
      return { step: this.getStep(identity), event: null, timer };
    });
  }

  timeoutEventStep(identity, error, lease = null) {
    this.#tx(() => {
      this.assertLease(identity.instanceId, lease);
      this.#updateStepInner(identity, {
        state: "failed", error, completed_at: Date.now(),
      });
      this.#deleteTimerInner(identity, "event-timeout");
      this.log(
        identity.instanceId,
        "wait.timed_out",
        JSON.stringify({ name: `${identity.name}-${identity.count}` }),
      );
    });
  }

  addEvent(instanceId, type, payload) {
    const now = Date.now();
    this.#tx(() => {
      this.#run(
        `INSERT INTO events(instance_id, type, payload, created_at) VALUES($1, $2, $3, $4)`,
        [instanceId, type, payload, now],
      );
      const waiting = this.#one(
        `SELECT 1 FROM steps
         WHERE instance_id=$1 AND type='waitForEvent' AND state='waiting' AND event_type=$2
         LIMIT 1`,
        [instanceId, type],
      );
      if (waiting) {
        this.#run(
          `UPDATE instances SET status='queued', updated_at=$1
           WHERE id=$2 AND status='waiting'`,
          [now, instanceId],
        );
      }
    });
  }

  registerRollback(identity, ordinal, config, output = null, stepError = null, lease = null) {
    this.#tx(() => {
      this.assertLease(identity.instanceId, lease);
      this.#registerRollbackInner(identity, ordinal, config, output, stepError);
    });
  }

  #registerRollbackInner(identity, ordinal, config, output = null, stepError = null) {
    this.#run(
      `INSERT INTO rollback_registrations(
        instance_id, step_type, step_name, step_count, ordinal, state, config,
        output, step_error, attempt, created_at
      ) VALUES($1, $2, $3, $4, $5, 'registered', $6, $7, $8, 0, $9)
      ON CONFLICT(instance_id, step_type, step_name, step_count)
      DO UPDATE SET
        ordinal=excluded.ordinal,
        config=excluded.config,
        output=excluded.output,
        step_error=excluded.step_error
      WHERE rollback_registrations.state = 'registered'`,
      [
        identity.instanceId, identity.type, identity.name, identity.count,
        ordinal, config, output, stepError, Date.now(),
      ],
    );
  }

  listRollbackRegistrations(instanceId) {
    return this.#all(
      `SELECT * FROM rollback_registrations
       WHERE instance_id=$1
       ORDER BY ordinal DESC, created_at DESC`,
      [instanceId],
    );
  }

  getRollbackRegistration(identity) {
    return this.#one(
      `SELECT * FROM rollback_registrations
       WHERE instance_id=$1 AND step_type=$2 AND step_name=$3 AND step_count=$4`,
      [
        identity.instanceId, identity.type, identity.name, identity.count,
      ],
    );
  }

  beginRollback(id, { terminalStatus = "terminated", cause = null } = {}, lease = null) {
    return this.#tx(() => {
      this.assertLease(id, lease);
      const instance = this.getInstance(id);
      if (!instance) throw new Error(`Unknown workflow instance: ${id}`);
      this.#run(
        `UPDATE rollback_registrations
         SET state='pending', attempt=0, wake_at=NULL, rollback_error=NULL, completed_at=NULL
         WHERE instance_id=$1 AND state='registered'`,
        [id],
      );
      this.#run(
        `UPDATE instances
         SET status='rollingBack', rollback_outcome=NULL, rollback_error=NULL,
             rollback_cause=$1, rollback_terminal_status=$2, updated_at=$3
         WHERE id=$4`,
        [cause, terminalStatus, Date.now(), id],
      );
      this.log(
        id,
        "instance.rollback.started",
        JSON.stringify({ terminalStatus, cause }),
      );
    });
  }

  startRollbackAttempt(identity, attempt, lease = null) {
    return this.#tx(() => {
      this.assertLease(identity.instanceId, lease);
      this.#startRollbackAttemptInner(identity, attempt);
    });
  }

  #startRollbackAttemptInner(identity, attempt) {
    const current = this.getRollbackRegistration(identity);
    this.#run(
      `UPDATE rollback_registrations
       SET state='running', attempt=$1, wake_at=NULL, rollback_error=NULL
       WHERE instance_id=$2 AND step_type=$3 AND step_name=$4 AND step_count=$5`,
      [
        attempt, identity.instanceId, identity.type, identity.name, identity.count,
      ],
    );
    if ((current?.attempt ?? 0) === 0) {
      this.log(
        identity.instanceId,
        "rollback.step.started",
        JSON.stringify({ name: `${identity.name}-${identity.count}`, config: current?.config ?? null }),
      );
    }
    this.log(
      identity.instanceId,
      "rollback.attempt.started",
      JSON.stringify({ name: `${identity.name}-${identity.count}`, attempt }),
    );
  }

  completeRollback(identity, lease = null) {
    return this.#tx(() => {
      this.assertLease(identity.instanceId, lease);
      this.#completeRollbackInner(identity);
    });
  }

  #completeRollbackInner(identity) {
    const current = this.getRollbackRegistration(identity);
    this.#run(
      `UPDATE rollback_registrations
       SET state='completed', wake_at=NULL, rollback_error=NULL, completed_at=$1
       WHERE instance_id=$2 AND step_type=$3 AND step_name=$4 AND step_count=$5`,
      [
        Date.now(), identity.instanceId, identity.type, identity.name, identity.count,
      ],
    );
    this.log(
      identity.instanceId,
      "rollback.attempt.completed",
      JSON.stringify({ name: `${identity.name}-${identity.count}`, attempt: current?.attempt ?? 1 }),
    );
    this.log(
      identity.instanceId,
      "rollback.step.completed",
      JSON.stringify({ name: `${identity.name}-${identity.count}` }),
    );
  }

  scheduleRollbackRetry(identity, attempt, error, wakeAt, lease = null) {
    this.#tx(() => {
      this.assertLease(identity.instanceId, lease);
      this.#scheduleRollbackRetryInner(identity, attempt, error, wakeAt);
    });
  }

  #scheduleRollbackRetryInner(identity, attempt, error, wakeAt) {
    this.#run(
      `UPDATE rollback_registrations
       SET state='waiting_retry', attempt=$1, wake_at=$2, rollback_error=$3, completed_at=NULL
       WHERE instance_id=$4 AND step_type=$5 AND step_name=$6 AND step_count=$7`,
      [
        attempt, Math.trunc(wakeAt), error,
        identity.instanceId, identity.type, identity.name, identity.count,
      ],
    );
    this.log(
      identity.instanceId,
      "rollback.attempt.errored",
      JSON.stringify({
        name: `${identity.name}-${identity.count}`,
        attempt,
        error,
        retryDelayMs: Math.max(0, Math.trunc(wakeAt - Date.now())),
      }),
    );
  }

  failRollback(identity, attempt, error, lease = null) {
    this.#tx(() => {
      this.assertLease(identity.instanceId, lease);
      this.#failRollbackInner(identity, attempt, error);
    });
  }

  #failRollbackInner(identity, attempt, error) {
    this.#run(
      `UPDATE rollback_registrations
       SET state='failed', attempt=$1, wake_at=NULL, rollback_error=$2, completed_at=$3
       WHERE instance_id=$4 AND step_type=$5 AND step_name=$6 AND step_count=$7`,
      [
        attempt, error, Date.now(),
        identity.instanceId, identity.type, identity.name, identity.count,
      ],
    );
    this.log(
      identity.instanceId,
      "rollback.attempt.errored",
      JSON.stringify({ name: `${identity.name}-${identity.count}`, attempt, error }),
    );
    this.log(
      identity.instanceId,
      "rollback.step.errored",
      JSON.stringify({ name: `${identity.name}-${identity.count}`, error }),
    );
  }

  finishRollback(id, outcome, error = null, lease = null) {
    return this.#tx(() => {
      this.assertLease(id, lease);
      this.#finishRollbackInner(id, outcome, error);
    });
  }

  #finishRollbackInner(id, outcome, error = null) {
    const instance = this.getInstance(id);
    if (!instance) throw new Error(`Unknown workflow instance: ${id}`);
    const terminalStatus = instance.rollback_terminal_status ?? "terminated";
    const now = Date.now();
    const retentionMs = terminalStatus === "errored"
      ? instance.error_retention_ms
      : instance.success_retention_ms;
    const expiresAt = retentionMs == null ? null : now + retentionMs;
    this.#run(
      `UPDATE instances
       SET status=$1, rollback_outcome=$2, rollback_error=$3,
           expires_at=$4, updated_at=$5
       WHERE id=$6`,
      [terminalStatus, outcome, error, expiresAt, now, id],
    );
    this.log(id, `instance.rollback.${outcome}`, error);
    this.log(
      id,
      `instance.${terminalStatus}`,
      JSON.stringify({
        rollbackOutcome: outcome,
        error: terminalStatus === "errored" ? instance.error : null,
      }),
    );
  }

  markInstanceStarted(instanceId, params, lease = null) {
    this.#tx(() => {
      this.assertLease(instanceId, lease);
      const existing = this.#one(
        `SELECT 1 FROM execution_events
         WHERE instance_id=$1 AND kind='instance.started'
         LIMIT 1`,
        [instanceId],
      );
      if (!existing) {
        this.log(instanceId, "instance.started", JSON.stringify({ params }));
      }
    });
  }

  listExecutionEvents(instanceId, afterId = 0, limit = 100) {
    return this.#all(
      `SELECT * FROM execution_events
       WHERE instance_id=$1 AND id>$2
       ORDER BY id
       LIMIT $3`,
      [instanceId, afterId, limit],
    );
  }

  restartInstance(id, from = null) {
    return this.#tx(() => {
      const instance = this.getInstance(id);
      if (!instance) throw new Error(`Unknown workflow instance: ${id}`);
      let targetOrdinal = null;
      if (from) {
        const type = from.type ?? "do";
        const count = from.count ?? 1;
        const target = this.#one(
          `SELECT * FROM steps WHERE instance_id=$1 AND type=$2 AND name=$3 AND count=$4`,
          [id, type, from.name, count],
        );
        if (!target) {
          throw new Error(`Restart target not found: ${type}/${from.name}/${count}`);
        }
        targetOrdinal = target.ordinal;
      }
      const doomed = targetOrdinal == null
        ? this.#all("SELECT * FROM steps WHERE instance_id=$1", [id])
        : this.#all(
            "SELECT * FROM steps WHERE instance_id=$1 AND ordinal>=$2 ORDER BY ordinal",
            [id, targetOrdinal],
          );
      for (const step of doomed) {
        this.#run(
          `DELETE FROM attempts
           WHERE instance_id=$1 AND step_type=$2 AND step_name=$3 AND step_count=$4`,
          [id, step.type, step.name, step.count],
        );
        this.#run(
          `DELETE FROM timers
           WHERE instance_id=$1 AND step_type=$2 AND step_name=$3 AND step_count=$4`,
          [id, step.type, step.name, step.count],
        );
        this.#run(
          `DELETE FROM rollback_registrations
           WHERE instance_id=$1 AND step_type=$2 AND step_name=$3 AND step_count=$4`,
          [id, step.type, step.name, step.count],
        );
        this.#run(
          `DELETE FROM steps WHERE instance_id=$1 AND type=$2 AND name=$3 AND count=$4`,
          [id, step.type, step.name, step.count],
        );
      }
      this.#run(
        `UPDATE instances
         SET status='queued', output=NULL, error=NULL, expires_at=NULL,
             rollback_outcome=NULL, rollback_error=NULL, rollback_cause=NULL,
             rollback_terminal_status=NULL, updated_at=$1
         WHERE id=$2`,
        [Date.now(), id],
      );
      this.log(id, "instance.restarted", JSON.stringify(from));
    });
  }

  log(instanceId, kind, detail) {
    this.#run(
      `INSERT INTO execution_events(instance_id, kind, detail, created_at)
       VALUES($1, $2, $3, $4)`,
      [instanceId, kind, detail, Date.now()],
    );
  }

  // Persisted step streams. Chunks are written while the callback's returned
  // ReadableStream is pumped; the step_streams row flips to 'committed' inside
  // the step-completion transaction so a reader only ever sees complete
  // streams. A crashed write leaves a 'writing' row that beginStepStream
  // replaces when the step re-runs.
  beginStepStream(identity, streamId, lease = null) {
    return this.#tx(() => {
      this.assertLease(identity.instanceId, lease);
      this.#run(
        `DELETE FROM step_streams
         WHERE instance_id=$1 AND step_type=$2 AND step_name=$3 AND step_count=$4`,
        [identity.instanceId, identity.type, identity.name, identity.count],
      );
      this.#run(
        `INSERT INTO step_streams(
          id, instance_id, step_type, step_name, step_count, state, created_at
        ) VALUES($1, $2, $3, $4, $5, 'writing', $6)`,
        [
          streamId, identity.instanceId, identity.type, identity.name,
          identity.count, Date.now(),
        ],
      );
    });
  }

  appendStreamChunk(streamId, seq, bytes, lease = null) {
    this.#tx(() => {
      if (lease != null) {
        const stream = this.#one(
          "SELECT instance_id FROM step_streams WHERE id=$1",
          [streamId],
        );
        this.assertLease(stream?.instance_id ?? null, lease);
      }
      this.#run(
        `INSERT INTO stream_chunks(stream_id, seq, bytes) VALUES($1, $2, $3)`,
        [streamId, seq, bytes],
      );
    });
  }

  commitStream(streamId, byteLength, chunkCount) {
    this.#run(
      `UPDATE step_streams
       SET state='committed', byte_length=$1, chunk_count=$2
       WHERE id=$3`,
      [byteLength, chunkCount, streamId],
    );
  }

  abandonStream(streamId) {
    this.#run("DELETE FROM step_streams WHERE id=$1", [streamId]);
  }

  getStream(streamId) {
    return this.#one("SELECT * FROM step_streams WHERE id=$1", [streamId]);
  }

  openStream(streamId) {
    const stream = this.getStream(streamId);
    if (!stream || stream.state !== "committed") {
      const error = new Error(`Persisted stream is not committed: ${streamId}`);
      error.name = "WorkflowStreamError";
      throw error;
    }
    let seq = 0;
    return new ReadableStream({
      pull: (controller) => {
        const row = this.#one(
          "SELECT bytes FROM stream_chunks WHERE stream_id=$1 AND seq=$2",
          [streamId, seq],
        );
        if (!row) {
          controller.close();
          return;
        }
        seq += 1;
        controller.enqueue(new Uint8Array(row.bytes));
      },
    });
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#call({ op: "end" });
    } catch {}
    this.#port.close();
    this.#worker.terminate();
  }

  #closed = false;
}

// Internal control-flow signal: a concurrent scheduled-run claim won the
// unique key first; the loser rolls back its orphan instance insert.
class ClaimLost extends Error {}
