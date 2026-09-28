import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { Storage } from "./storage.mjs";

export class SQLiteStorage extends Storage {
  constructor(path) {
    super();
    mkdirSync(dirname(path), { recursive: true });
    this.path = path;
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    // Multiple executor processes may share one database; busy_timeout keeps a
    // contended writer retrying instead of surfacing SQLITE_BUSY.
    this.db.pragma("busy_timeout = 5000");
    this.#schema();
  }

  #schema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workflows (
        name TEXT PRIMARY KEY,
        binding TEXT NOT NULL,
        class_name TEXT NOT NULL,
        main TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS instances (
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
        scheduled_time INTEGER,
        success_retention_ms INTEGER,
        error_retention_ms INTEGER,
        expires_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(workflow_name) REFERENCES workflows(name)
      );
      CREATE TABLE IF NOT EXISTS steps (
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
        created_at INTEGER NOT NULL,
        completed_at INTEGER,
        PRIMARY KEY(instance_id, type, name, count),
        FOREIGN KEY(instance_id) REFERENCES instances(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS attempts (
        instance_id TEXT NOT NULL,
        step_type TEXT NOT NULL,
        step_name TEXT NOT NULL,
        step_count INTEGER NOT NULL,
        attempt INTEGER NOT NULL,
        state TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        error TEXT,
        PRIMARY KEY(instance_id, step_type, step_name, step_count, attempt),
        FOREIGN KEY(instance_id) REFERENCES instances(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS timers (
        instance_id TEXT NOT NULL,
        step_type TEXT NOT NULL,
        step_name TEXT NOT NULL,
        step_count INTEGER NOT NULL,
        kind TEXT NOT NULL,
        wake_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(instance_id, step_type, step_name, step_count, kind),
        FOREIGN KEY(instance_id) REFERENCES instances(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        consumed_at INTEGER,
        FOREIGN KEY(instance_id) REFERENCES instances(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS rollback_registrations (
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
        wake_at INTEGER,
        rollback_error TEXT,
        created_at INTEGER NOT NULL,
        completed_at INTEGER,
        PRIMARY KEY(instance_id, step_type, step_name, step_count),
        FOREIGN KEY(instance_id) REFERENCES instances(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS workflow_schedules (
        workflow_name TEXT NOT NULL,
        cron TEXT NOT NULL,
        last_checked_at INTEGER NOT NULL,
        PRIMARY KEY(workflow_name, cron),
        FOREIGN KEY(workflow_name) REFERENCES workflows(name)
      );
      CREATE TABLE IF NOT EXISTS scheduled_runs (
        workflow_name TEXT NOT NULL,
        cron TEXT NOT NULL,
        scheduled_time INTEGER NOT NULL,
        instance_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(workflow_name, cron, scheduled_time),
        FOREIGN KEY(instance_id) REFERENCES instances(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS execution_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        detail TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(instance_id) REFERENCES instances(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS step_streams (
        id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL,
        step_type TEXT NOT NULL,
        step_name TEXT NOT NULL,
        step_count INTEGER NOT NULL,
        state TEXT NOT NULL,
        byte_length INTEGER NOT NULL DEFAULT 0,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(instance_id) REFERENCES instances(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS stream_chunks (
        stream_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        bytes BLOB NOT NULL,
        PRIMARY KEY(stream_id, seq),
        FOREIGN KEY(stream_id) REFERENCES step_streams(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_instances_status ON instances(status);
      CREATE INDEX IF NOT EXISTS idx_timers_wake ON timers(wake_at);
      CREATE INDEX IF NOT EXISTS idx_events_unconsumed ON events(instance_id, type, consumed_at);
      CREATE INDEX IF NOT EXISTS idx_steps_ordinal ON steps(instance_id, ordinal);
      CREATE INDEX IF NOT EXISTS idx_rollback_runnable
        ON rollback_registrations(instance_id, state, wake_at);
    `);
    this.#migrate();
  }

  #migrate() {
    const ensureColumn = (table, name, definition) => {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
      if (!columns.some((column) => column.name === name)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      }
    };
    ensureColumn("instances", "public_id", "TEXT");
    this.db.prepare(
      "UPDATE instances SET public_id=id WHERE public_id IS NULL",
    ).run();
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_instances_workflow_public_id ON instances(workflow_name, public_id)",
    );
    ensureColumn("instances", "rollback_outcome", "TEXT");
    ensureColumn("instances", "rollback_error", "TEXT");
    ensureColumn("instances", "rollback_cause", "TEXT");
    ensureColumn("instances", "rollback_terminal_status", "TEXT");
    ensureColumn("instances", "schedule_cron", "TEXT");
    ensureColumn("instances", "scheduled_time", "INTEGER");
    ensureColumn("instances", "success_retention_ms", "INTEGER");
    ensureColumn("instances", "error_retention_ms", "INTEGER");
    ensureColumn("instances", "expires_at", "INTEGER");
    ensureColumn("rollback_registrations", "ordinal", "INTEGER");
    ensureColumn("rollback_registrations", "output", "TEXT");
    ensureColumn("rollback_registrations", "step_error", "TEXT");
    ensureColumn("rollback_registrations", "attempt", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn("rollback_registrations", "wake_at", "INTEGER");
    ensureColumn("rollback_registrations", "rollback_error", "TEXT");
    ensureColumn("rollback_registrations", "completed_at", "INTEGER");
    ensureColumn("instances", "lease_owner", "TEXT");
    ensureColumn("instances", "lease_expires_at", "INTEGER");
  }

  registerWorkflow(workflow) {
    this.db.prepare(`
      INSERT INTO workflows(name, binding, class_name, main, updated_at)
      VALUES(@name, @binding, @className, @main, @now)
      ON CONFLICT(name) DO UPDATE SET
        binding=excluded.binding, class_name=excluded.class_name,
        main=excluded.main, updated_at=excluded.updated_at
    `).run({ ...workflow, now: Date.now() });
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
      // Cloudflare reports duplicate create() as a plain Error; the
      // alreadyExists flag keeps it identifiable internally.
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
    this.db.prepare(`
      INSERT INTO instances(
        id, public_id, workflow_name, status, payload, schedule_cron, scheduled_time,
        success_retention_ms, error_retention_ms, expires_at,
        created_at, updated_at
      )
      VALUES(?, ?, ?, 'queued', ?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(
      storageId, id, workflowName, payload,
      schedule?.cron ?? null, schedule?.scheduledTime ?? null,
      retention?.successRetentionMs ?? null,
      retention?.errorRetentionMs ?? null,
      now, now,
    );
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
    return this.db.transaction(() => {
      const existing = this.db.prepare(`
        SELECT instance_id FROM scheduled_runs
        WHERE workflow_name=? AND cron=? AND scheduled_time=?
      `).get(workflowName, cron, scheduledTime);
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
      this.db.prepare(`
        INSERT INTO scheduled_runs(
          workflow_name, cron, scheduled_time, instance_id, created_at
        ) VALUES(?, ?, ?, ?, ?)
      `).run(workflowName, cron, scheduledTime, instance.id, Date.now());
      this.log(
        instance.id,
        "instance.scheduled",
        JSON.stringify({ cron, scheduledTime }),
      );
      return { created: true, id: instance.public_id };
    })();
  }

  getScheduleCursor(workflowName, cron) {
    return this.db.prepare(`
      SELECT last_checked_at FROM workflow_schedules
      WHERE workflow_name=? AND cron=?
    `).get(workflowName, cron)?.last_checked_at ?? null;
  }

  setScheduleCursor(workflowName, cron, lastCheckedAt) {
    this.db.prepare(`
      INSERT INTO workflow_schedules(workflow_name, cron, last_checked_at)
      VALUES(?, ?, ?)
      ON CONFLICT(workflow_name, cron)
      DO UPDATE SET last_checked_at=excluded.last_checked_at
    `).run(workflowName, cron, Math.trunc(lastCheckedAt));
  }

  // Executor leases: exactly one live executor may run an instance. A lease is
  // held only while the instance executes; suspension and terminal states
  // release it, and an expired lease is treated as a crashed executor.
  claimInstance(id, owner, ttlMs, now = Date.now()) {
    return this.db.prepare(`
      UPDATE instances
      SET lease_owner=@owner, lease_expires_at=@expiresAt
      WHERE id=@id
        AND (lease_expires_at IS NULL OR lease_expires_at <= @now OR lease_owner=@owner)
    `).run({ owner, expiresAt: now + ttlMs, id, now }).changes === 1;
  }

  renewLease(id, owner, ttlMs, now = Date.now()) {
    return this.db.prepare(`
      UPDATE instances SET lease_expires_at=@expiresAt
      WHERE id=@id AND lease_owner=@owner
    `).run({ expiresAt: now + ttlMs, id, owner }).changes === 1;
  }

  releaseLease(id, owner) {
    return this.db.prepare(`
      UPDATE instances SET lease_owner=NULL, lease_expires_at=NULL
      WHERE id=@id AND lease_owner=@owner
    `).run({ id, owner }).changes === 1;
  }

  // Fencing check executed inside committing transactions. A mutation that
  // runs under an executor lease verifies the lease is still held and
  // unexpired before the transaction commits, so an executor whose lease
  // lapsed (and was possibly reclaimed by another executor) cannot land
  // stale work on top of the new owner's. `lease` is the caller's
  // executorId; null skips the check (lifecycle commands are unfenced).
  assertLease(instanceId, lease) {
    if (lease == null) return;
    const row = this.db.prepare(
      "SELECT lease_owner, lease_expires_at FROM instances WHERE id=?",
    ).get(instanceId);
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
    return this.db.prepare(
      "DELETE FROM instances WHERE expires_at IS NOT NULL AND expires_at <= ?",
    ).run(now).changes;
  }

  getInstance(id) {
    return this.db.prepare("SELECT * FROM instances WHERE id = ?").get(id) ?? null;
  }

  getInstanceByPublic(workflowName, publicId) {
    return this.db.prepare(
      "SELECT * FROM instances WHERE workflow_name=? AND public_id=?",
    ).get(workflowName, publicId) ?? null;
  }

  findInstancesByPublic(publicId) {
    return this.db.prepare(
      "SELECT * FROM instances WHERE public_id=? ORDER BY created_at",
    ).all(publicId);
  }

  listInstances(workflowName, { status = null, offset = 0, limit = null } = {}) {
    this.deleteExpired(Date.now());
    const where = status == null
      ? "workflow_name = ?"
      : "workflow_name = ? AND status = ?";
    const args = status == null ? [workflowName] : [workflowName, status];
    const total = this.db.prepare(
      `SELECT COUNT(*) AS n FROM instances WHERE ${where}`,
    ).get(...args).n;
    const paged = limit == null
      ? this.db.prepare(
          `SELECT * FROM instances WHERE ${where} ORDER BY created_at`,
        ).all(...args)
      : this.db.prepare(
          `SELECT * FROM instances WHERE ${where} ORDER BY created_at LIMIT ? OFFSET ?`,
        ).all(...args, limit, offset);
    return { rows: paged, total };
  }

  setInstanceStatus(id, status, { output = undefined, error = undefined } = {}, lease = null) {
    return this.db.transaction(() => {
      this.assertLease(id, lease);
      this.setInstanceStatusInner(id, status, { output, error });
    })();
  }

  setInstanceStatusInner(id, status, { output = undefined, error = undefined } = {}) {
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
    this.db.prepare(`
      UPDATE instances
      SET status=@status, output=@output, error=@error,
          expires_at=@expiresAt, updated_at=@now
      WHERE id=@id
    `).run({
      id,
      status,
      output: nextOutput,
      error: nextError,
      expiresAt,
      now,
    });
    if (current.status !== status) {
      this.log(
        id,
        `instance.${status}`,
        JSON.stringify({ output: nextOutput, error: nextError }),
      );
    }
  }

  deleteInstance(id) {
    return this.db.prepare("DELETE FROM instances WHERE id = ?").run(id).changes > 0;
  }

  // Instances leased to a live foreign executor are not runnable here: they
  // stay out of the result set until the lease expires or is released.
  listRunnable(now = Date.now(), executorId = null) {
    return this.db.prepare(`
      SELECT DISTINCT i.*
      FROM instances i
      LEFT JOIN timers t ON t.instance_id = i.id
      WHERE (
          i.lease_owner IS NULL
          OR i.lease_owner = @executorId
          OR i.lease_expires_at <= @now
        )
        AND (
          i.status IN ('queued', 'running')
         OR (i.status = 'waiting' AND t.wake_at <= @now)
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
                   OR (rr.state = 'waiting_retry' AND rr.wake_at <= @now)
                 )
             )
           )
         )
        )
      ORDER BY i.created_at
    `).all({ now, executorId });
  }

  getStep(identity) {
    return this.db.prepare(`
      SELECT * FROM steps WHERE instance_id=? AND type=? AND name=? AND count=?
    `).get(identity.instanceId, identity.type, identity.name, identity.count) ?? null;
  }

  listSteps(instanceId) {
    return this.db.prepare(
      "SELECT * FROM steps WHERE instance_id=? ORDER BY ordinal",
    ).all(instanceId);
  }

  ensureStep(identity, ordinal, state, config, eventType = null, lease = null) {
    return this.db.transaction(() => {
      this.assertLease(identity.instanceId, lease);
      return this.ensureStepInner(identity, ordinal, state, config, eventType);
    })();
  }

  ensureStepInner(identity, ordinal, state, config, eventType = null) {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO steps(
        instance_id, type, name, count, ordinal, state, config, event_type, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      identity.instanceId, identity.type, identity.name, identity.count,
      ordinal, state, config, eventType, Date.now(),
    );
    if (result.changes > 0) {
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
    return this.db.transaction(() => {
      this.assertLease(identity.instanceId, lease);
      this.updateStepInner(identity, fields);
    })();
  }

  updateStepInner(identity, fields) {
    const allowed = ["state", "config", "output", "error", "event_type", "completed_at"];
    const entries = Object.entries(fields).filter(([key]) => allowed.includes(key));
    if (!entries.length) return;
    const sql = entries.map(([key]) => `${key} = @${key}`).join(", ");
    this.db.prepare(`
      UPDATE steps SET ${sql}
      WHERE instance_id=@instanceId AND type=@type AND name=@name AND count=@count
    `).run({ ...identity, ...Object.fromEntries(entries) });
  }

  startAttempt(identity, attempt, lease = null) {
    this.db.transaction(() => {
      this.assertLease(identity.instanceId, lease);
      this.db.prepare(`
        INSERT INTO attempts(
          instance_id, step_type, step_name, step_count, attempt, state, started_at
        ) VALUES(?, ?, ?, ?, ?, 'running', ?)
      `).run(
        identity.instanceId, identity.type, identity.name, identity.count,
        attempt, Date.now(),
      );
      this.log(
        identity.instanceId,
        "attempt.started",
        JSON.stringify({ name: `${identity.name}-${identity.count}`, attempt }),
      );
    })();
  }

  finishAttempt(identity, attempt, state, error = null, retryDelayMs = null, lease = null) {
    this.db.transaction(() => {
      this.assertLease(identity.instanceId, lease);
      this.finishAttemptInner(identity, attempt, state, error, retryDelayMs);
    })();
  }

  finishAttemptInner(identity, attempt, state, error = null, retryDelayMs = null) {
    this.db.prepare(`
      UPDATE attempts SET state=?, finished_at=?, error=?
      WHERE instance_id=? AND step_type=? AND step_name=? AND step_count=? AND attempt=?
    `).run(
      state, Date.now(), error, identity.instanceId, identity.type,
      identity.name, identity.count, attempt,
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
    return this.db.prepare(`
      SELECT COUNT(*) AS n FROM attempts
      WHERE instance_id=? AND step_type=? AND step_name=? AND step_count=?
    `).get(identity.instanceId, identity.type, identity.name, identity.count).n;
  }

  listAttempts(identity) {
    return this.db.prepare(`
      SELECT * FROM attempts
      WHERE instance_id=? AND step_type=? AND step_name=? AND step_count=?
      ORDER BY attempt
    `).all(identity.instanceId, identity.type, identity.name, identity.count);
  }

  completeDoStep(identity, attempt, output, rollback = null, stream = null, lease = null) {
    this.db.transaction(() => {
      this.assertLease(identity.instanceId, lease);
      this.finishAttemptInner(identity, attempt, "completed", null);
      this.updateStepInner(identity, {
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
        this.registerRollbackInner(
          identity, identity.ordinal, rollback.config, output, null,
        );
      }
      this.deleteTimerInner(identity, "retry");
      this.deleteTimerInner(identity, "attempt-timeout");
    })();
  }

  // `error` is the event/attempt-surface error; `stepError` is what replay
  // rethrows to run() — they differ for terminal NonRetryableError failures,
  // which Cloudflare reports as WorkflowFatalError while the rejection seen by
  // workflow code is a plain Error.
  finishDoStepTerminal(identity, attempt, error, rollback = null, stepError = null, lease = null) {
    this.db.transaction(() => {
      this.assertLease(identity.instanceId, lease);
      this.finishAttemptInner(identity, attempt, "failed", error);
      this.updateStepInner(identity, {
        state: "failed", error: stepError ?? error, completed_at: Date.now(),
      });
      this.log(
        identity.instanceId,
        "step.errored",
        JSON.stringify({ name: `${identity.name}-${identity.count}`, error }),
      );
      if (rollback) {
        this.registerRollbackInner(
          identity, identity.ordinal, rollback.config, null, error,
        );
      }
      this.deleteTimerInner(identity, "retry");
      this.deleteTimerInner(identity, "attempt-timeout");
    })();
  }

  // Output-serialization failures complete the attempt (the work ran fine —
  // the result could not be persisted) and fail the step without a
  // step.errored event, matching Cloudflare's event surface.
  failDoStepSerialization(identity, attempt, error, rollback = null, lease = null) {
    this.db.transaction(() => {
      this.assertLease(identity.instanceId, lease);
      this.finishAttemptInner(identity, attempt, "completed", null);
      this.updateStepInner(identity, {
        state: "failed", error, completed_at: Date.now(),
      });
      if (rollback) {
        this.registerRollbackInner(
          identity, identity.ordinal, rollback.config, null, error,
        );
      }
      this.deleteTimerInner(identity, "retry");
      this.deleteTimerInner(identity, "attempt-timeout");
    })();
  }

  scheduleRetry(identity, attempt, error, wakeAt, lease = null) {
    this.db.transaction(() => {
      this.assertLease(identity.instanceId, lease);
      const retryDelayMs = Math.max(0, Math.trunc(wakeAt - Date.now()));
      this.finishAttemptInner(identity, attempt, "failed", error, retryDelayMs);
      this.updateStepInner(identity, { state: "waiting_retry", error, completed_at: null });
      this.putTimerInner(identity, "retry", wakeAt);
      this.deleteTimerInner(identity, "attempt-timeout");
    })();
  }

  putTimer(identity, kind, wakeAt, lease = null) {
    this.db.transaction(() => {
      this.assertLease(identity.instanceId, lease);
      this.putTimerInner(identity, kind, wakeAt);
    })();
  }

  putTimerInner(identity, kind, wakeAt) {
    this.db.prepare(`
      INSERT INTO timers(
        instance_id, step_type, step_name, step_count, kind, wake_at, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(instance_id, step_type, step_name, step_count, kind)
      DO UPDATE SET wake_at=excluded.wake_at
    `).run(
      identity.instanceId, identity.type, identity.name, identity.count,
      kind, Math.trunc(wakeAt), Date.now(),
    );
  }

  getTimer(identity, kind) {
    return this.db.prepare(`
      SELECT * FROM timers
      WHERE instance_id=? AND step_type=? AND step_name=? AND step_count=? AND kind=?
    `).get(
      identity.instanceId, identity.type, identity.name, identity.count, kind,
    ) ?? null;
  }

  deleteTimer(identity, kind, lease = null) {
    this.db.transaction(() => {
      this.assertLease(identity.instanceId, lease);
      this.deleteTimerInner(identity, kind);
    })();
  }

  deleteTimerInner(identity, kind) {
    this.db.prepare(`
      DELETE FROM timers
      WHERE instance_id=? AND step_type=? AND step_name=? AND step_count=? AND kind=?
    `).run(identity.instanceId, identity.type, identity.name, identity.count, kind);
  }

  waitOnTimer(identity, ordinal, config, kind, wakeAt, lease = null) {
    return this.db.transaction(() => {
      this.assertLease(identity.instanceId, lease);
      const step = this.ensureStepInner(identity, ordinal, "waiting", config);
      let timer = this.getTimer(identity, kind);
      if (!timer && step.state !== "completed") {
        this.putTimerInner(identity, kind, wakeAt);
        timer = this.getTimer(identity, kind);
      }
      return { step: this.getStep(identity), timer };
    })();
  }

  completeTimerStep(identity, kind, lease = null) {
    this.db.transaction(() => {
      this.assertLease(identity.instanceId, lease);
      this.updateStepInner(identity, {
        state: "completed", output: null, error: null, completed_at: Date.now(),
      });
      this.deleteTimerInner(identity, kind);
      if (kind === "sleep") {
        this.log(
          identity.instanceId,
          "sleep.completed",
          JSON.stringify({ name: `${identity.name}-${identity.count}` }),
        );
      }
    })();
  }

  waitForEvent(identity, ordinal, config, eventType, wakeAt, encodedEvent, lease = null) {
    return this.db.transaction(() => {
      this.assertLease(identity.instanceId, lease);
      const step = this.ensureStepInner(
        identity, ordinal, "waiting", config, eventType,
      );
      if (step.state === "completed") return { step, event: null, timer: null };

      const event = this.db.prepare(`
        SELECT * FROM events
        WHERE instance_id=? AND type=? AND consumed_at IS NULL
        ORDER BY id LIMIT 1
      `).get(identity.instanceId, eventType);

      if (event) {
        const consumedAt = Date.now();
        this.db.prepare("UPDATE events SET consumed_at=? WHERE id=?")
          .run(consumedAt, event.id);
        const output = encodedEvent({ ...event, consumed_at: consumedAt });
        this.updateStepInner(identity, {
          state: "completed", output, error: null, completed_at: consumedAt,
        });
        this.deleteTimerInner(identity, "event-timeout");
        this.log(
          identity.instanceId,
          "wait.completed",
          JSON.stringify({ name: `${identity.name}-${identity.count}` }),
        );
        return { step: this.getStep(identity), event, timer: null };
      }

      let timer = this.getTimer(identity, "event-timeout");
      if (!timer) {
        this.putTimerInner(identity, "event-timeout", wakeAt);
        timer = this.getTimer(identity, "event-timeout");
      }
      return { step: this.getStep(identity), event: null, timer };
    })();
  }

  timeoutEventStep(identity, error, lease = null) {
    this.db.transaction(() => {
      this.assertLease(identity.instanceId, lease);
      this.updateStepInner(identity, {
        state: "failed", error, completed_at: Date.now(),
      });
      this.deleteTimerInner(identity, "event-timeout");
      this.log(
        identity.instanceId,
        "wait.timed_out",
        JSON.stringify({ name: `${identity.name}-${identity.count}` }),
      );
    })();
  }

  addEvent(instanceId, type, payload) {
    const now = Date.now();
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO events(instance_id, type, payload, created_at) VALUES(?, ?, ?, ?)
      `).run(instanceId, type, payload, now);
      const waiting = this.db.prepare(`
        SELECT 1 FROM steps
        WHERE instance_id=? AND type='waitForEvent' AND state='waiting' AND event_type=?
        LIMIT 1
      `).get(instanceId, type);
      if (waiting) {
        this.db.prepare(`
          UPDATE instances SET status='queued', updated_at=?
          WHERE id=? AND status='waiting'
        `).run(now, instanceId);
      }
    })();
  }

  registerRollback(identity, ordinal, config, output = null, stepError = null, lease = null) {
    this.db.transaction(() => {
      this.assertLease(identity.instanceId, lease);
      this.registerRollbackInner(identity, ordinal, config, output, stepError);
    })();
  }

  registerRollbackInner(identity, ordinal, config, output = null, stepError = null) {
    this.db.prepare(`
      INSERT INTO rollback_registrations(
        instance_id, step_type, step_name, step_count, ordinal, state, config,
        output, step_error, attempt, created_at
      ) VALUES(?, ?, ?, ?, ?, 'registered', ?, ?, ?, 0, ?)
      ON CONFLICT(instance_id, step_type, step_name, step_count)
      DO UPDATE SET
        ordinal=excluded.ordinal,
        config=excluded.config,
        output=excluded.output,
        step_error=excluded.step_error
      WHERE rollback_registrations.state = 'registered'
    `).run(
      identity.instanceId, identity.type, identity.name, identity.count,
      ordinal, config, output, stepError, Date.now(),
    );
  }

  listRollbackRegistrations(instanceId) {
    return this.db.prepare(`
      SELECT * FROM rollback_registrations
      WHERE instance_id=?
      ORDER BY ordinal DESC, created_at DESC
    `).all(instanceId);
  }

  getRollbackRegistration(identity) {
    return this.db.prepare(`
      SELECT * FROM rollback_registrations
      WHERE instance_id=? AND step_type=? AND step_name=? AND step_count=?
    `).get(
      identity.instanceId, identity.type, identity.name, identity.count,
    ) ?? null;
  }

  beginRollback(id, { terminalStatus = "terminated", cause = null } = {}, lease = null) {
    return this.db.transaction(() => {
      this.assertLease(id, lease);
      const instance = this.getInstance(id);
      if (!instance) throw new Error(`Unknown workflow instance: ${id}`);
      this.db.prepare(`
        UPDATE rollback_registrations
        SET state='pending', attempt=0, wake_at=NULL, rollback_error=NULL, completed_at=NULL
        WHERE instance_id=? AND state='registered'
      `).run(id);
      this.db.prepare(`
        UPDATE instances
        SET status='rollingBack', rollback_outcome=NULL, rollback_error=NULL,
            rollback_cause=?, rollback_terminal_status=?, updated_at=?
        WHERE id=?
      `).run(cause, terminalStatus, Date.now(), id);
      this.log(
        id,
        "instance.rollback.started",
        JSON.stringify({ terminalStatus, cause }),
      );
    })();
  }

  startRollbackAttempt(identity, attempt, lease = null) {
    return this.db.transaction(() => {
      this.assertLease(identity.instanceId, lease);
      this.startRollbackAttemptInner(identity, attempt);
    })();
  }

  startRollbackAttemptInner(identity, attempt) {
    const current = this.getRollbackRegistration(identity);
    this.db.prepare(`
      UPDATE rollback_registrations
      SET state='running', attempt=?, wake_at=NULL, rollback_error=NULL
      WHERE instance_id=? AND step_type=? AND step_name=? AND step_count=?
    `).run(
      attempt, identity.instanceId, identity.type, identity.name, identity.count,
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
    return this.db.transaction(() => {
      this.assertLease(identity.instanceId, lease);
      this.completeRollbackInner(identity);
    })();
  }

  completeRollbackInner(identity) {
    const current = this.getRollbackRegistration(identity);
    this.db.prepare(`
      UPDATE rollback_registrations
      SET state='completed', wake_at=NULL, rollback_error=NULL, completed_at=?
      WHERE instance_id=? AND step_type=? AND step_name=? AND step_count=?
    `).run(
      Date.now(), identity.instanceId, identity.type, identity.name, identity.count,
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
    this.db.transaction(() => {
      this.assertLease(identity.instanceId, lease);
      this.scheduleRollbackRetryInner(identity, attempt, error, wakeAt);
    })();
  }

  scheduleRollbackRetryInner(identity, attempt, error, wakeAt) {
    this.db.prepare(`
      UPDATE rollback_registrations
      SET state='waiting_retry', attempt=?, wake_at=?, rollback_error=?, completed_at=NULL
      WHERE instance_id=? AND step_type=? AND step_name=? AND step_count=?
    `).run(
      attempt, Math.trunc(wakeAt), error,
      identity.instanceId, identity.type, identity.name, identity.count,
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
    this.db.transaction(() => {
      this.assertLease(identity.instanceId, lease);
      this.failRollbackInner(identity, attempt, error);
    })();
  }

  failRollbackInner(identity, attempt, error) {
    this.db.prepare(`
      UPDATE rollback_registrations
      SET state='failed', attempt=?, wake_at=NULL, rollback_error=?, completed_at=?
      WHERE instance_id=? AND step_type=? AND step_name=? AND step_count=?
    `).run(
      attempt, error, Date.now(),
      identity.instanceId, identity.type, identity.name, identity.count,
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
    return this.db.transaction(() => {
      this.assertLease(id, lease);
      this.finishRollbackInner(id, outcome, error);
    })();
  }

  finishRollbackInner(id, outcome, error = null) {
    const instance = this.getInstance(id);
    if (!instance) throw new Error(`Unknown workflow instance: ${id}`);
    const terminalStatus = instance.rollback_terminal_status ?? "terminated";
    const now = Date.now();
    const retentionMs = terminalStatus === "errored"
      ? instance.error_retention_ms
      : instance.success_retention_ms;
    const expiresAt = retentionMs == null ? null : now + retentionMs;
    this.db.prepare(`
      UPDATE instances
      SET status=?, rollback_outcome=?, rollback_error=?,
          expires_at=?, updated_at=?
      WHERE id=?
    `).run(terminalStatus, outcome, error, expiresAt, now, id);
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
    this.db.transaction(() => {
      this.assertLease(instanceId, lease);
      const existing = this.db.prepare(`
        SELECT 1 FROM execution_events
        WHERE instance_id=? AND kind='instance.started'
        LIMIT 1
      `).get(instanceId);
      if (!existing) {
        this.log(instanceId, "instance.started", JSON.stringify({ params }));
      }
    })();
  }

  listExecutionEvents(instanceId, afterId = 0, limit = 100) {
    return this.db.prepare(`
      SELECT * FROM execution_events
      WHERE instance_id=? AND id>?
      ORDER BY id
      LIMIT ?
    `).all(instanceId, afterId, limit);
  }

  restartInstance(id, from = null) {
    return this.db.transaction(() => {
      const instance = this.getInstance(id);
      if (!instance) throw new Error(`Unknown workflow instance: ${id}`);
      let targetOrdinal = null;
      if (from) {
        const type = from.type ?? "do";
        const count = from.count ?? 1;
        const target = this.db.prepare(`
          SELECT * FROM steps WHERE instance_id=? AND type=? AND name=? AND count=?
        `).get(id, type, from.name, count);
        if (!target) {
          throw new Error(`Restart target not found: ${type}/${from.name}/${count}`);
        }
        targetOrdinal = target.ordinal;
      }
      const doomed = targetOrdinal == null
        ? this.db.prepare("SELECT * FROM steps WHERE instance_id=?").all(id)
        : this.db.prepare(
            "SELECT * FROM steps WHERE instance_id=? AND ordinal>=? ORDER BY ordinal",
          ).all(id, targetOrdinal);
      for (const step of doomed) {
        this.db.prepare(`
          DELETE FROM attempts
          WHERE instance_id=? AND step_type=? AND step_name=? AND step_count=?
        `).run(id, step.type, step.name, step.count);
        this.db.prepare(`
          DELETE FROM timers
          WHERE instance_id=? AND step_type=? AND step_name=? AND step_count=?
        `).run(id, step.type, step.name, step.count);
        this.db.prepare(`
          DELETE FROM rollback_registrations
          WHERE instance_id=? AND step_type=? AND step_name=? AND step_count=?
        `).run(id, step.type, step.name, step.count);
        this.db.prepare(`
          DELETE FROM steps WHERE instance_id=? AND type=? AND name=? AND count=?
        `).run(id, step.type, step.name, step.count);
      }
      this.db.prepare(`
        UPDATE instances
        SET status='queued', output=NULL, error=NULL, expires_at=NULL,
            rollback_outcome=NULL, rollback_error=NULL, rollback_cause=NULL,
            rollback_terminal_status=NULL, updated_at=?
        WHERE id=?
      `).run(Date.now(), id);
      this.log(id, "instance.restarted", JSON.stringify(from));
    })();
  }

  log(instanceId, kind, detail) {
    this.db.prepare(`
      INSERT INTO execution_events(instance_id, kind, detail, created_at)
      VALUES(?, ?, ?, ?)
    `).run(instanceId, kind, detail, Date.now());
  }

  // Persisted step streams. Chunks are written while the callback's returned
  // ReadableStream is pumped; the step_streams row flips to 'committed' inside
  // the step-completion transaction so a reader only ever sees complete
  // streams. A crashed write leaves a 'writing' row that beginStepStream
  // replaces when the step re-runs.
  beginStepStream(identity, streamId, lease = null) {
    return this.db.transaction(() => {
      this.assertLease(identity.instanceId, lease);
      this.db.prepare(`
        DELETE FROM step_streams
        WHERE instance_id=? AND step_type=? AND step_name=? AND step_count=?
      `).run(identity.instanceId, identity.type, identity.name, identity.count);
      this.db.prepare(`
        INSERT INTO step_streams(
          id, instance_id, step_type, step_name, step_count, state, created_at
        ) VALUES(?, ?, ?, ?, ?, 'writing', ?)
      `).run(
        streamId, identity.instanceId, identity.type, identity.name,
        identity.count, Date.now(),
      );
    })();
  }

  appendStreamChunk(streamId, seq, bytes, lease = null) {
    this.db.transaction(() => {
      if (lease != null) {
        const stream = this.db.prepare(
          "SELECT instance_id FROM step_streams WHERE id=?",
        ).get(streamId);
        this.assertLease(stream?.instance_id ?? null, lease);
      }
      this.db.prepare(`
        INSERT INTO stream_chunks(stream_id, seq, bytes) VALUES(?, ?, ?)
      `).run(streamId, seq, bytes);
    })();
  }

  commitStream(streamId, byteLength, chunkCount) {
    this.db.prepare(`
      UPDATE step_streams
      SET state='committed', byte_length=?, chunk_count=?
      WHERE id=?
    `).run(byteLength, chunkCount, streamId);
  }

  abandonStream(streamId) {
    this.db.prepare("DELETE FROM step_streams WHERE id=?").run(streamId);
  }

  getStream(streamId) {
    return this.db.prepare("SELECT * FROM step_streams WHERE id=?").get(streamId) ?? null;
  }

  openStream(streamId) {
    const stream = this.getStream(streamId);
    if (!stream || stream.state !== "committed") {
      const error = new Error(`Persisted stream is not committed: ${streamId}`);
      error.name = "WorkflowStreamError";
      throw error;
    }
    const chunk = this.db.prepare(
      "SELECT bytes FROM stream_chunks WHERE stream_id=? AND seq=?",
    );
    let seq = 0;
    return new ReadableStream({
      pull: (controller) => {
        const row = chunk.get(streamId, seq);
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
    this.db.close();
  }
}
