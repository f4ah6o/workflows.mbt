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
        workflow_name TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL,
        output TEXT,
        error TEXT,
        rollback_outcome TEXT,
        rollback_error TEXT,
        schedule_cron TEXT,
        scheduled_time INTEGER,
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
    ensureColumn("instances", "rollback_outcome", "TEXT");
    ensureColumn("instances", "rollback_error", "TEXT");
    ensureColumn("instances", "schedule_cron", "TEXT");
    ensureColumn("instances", "scheduled_time", "INTEGER");
    ensureColumn("rollback_registrations", "ordinal", "INTEGER");
    ensureColumn("rollback_registrations", "output", "TEXT");
    ensureColumn("rollback_registrations", "step_error", "TEXT");
    ensureColumn("rollback_registrations", "attempt", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn("rollback_registrations", "wake_at", "INTEGER");
    ensureColumn("rollback_registrations", "rollback_error", "TEXT");
    ensureColumn("rollback_registrations", "completed_at", "INTEGER");
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

  createInstance({ id, workflowName, payload, schedule = null }) {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO instances(
        id, workflow_name, status, payload, schedule_cron, scheduled_time,
        created_at, updated_at
      )
      VALUES(?, ?, 'queued', ?, ?, ?, ?, ?)
    `).run(
      id, workflowName, payload,
      schedule?.cron ?? null, schedule?.scheduledTime ?? null,
      now, now,
    );
    this.log(id, "instance.created", null);
    return this.getInstance(id);
  }

  claimScheduledInstance({
    id,
    workflowName,
    payload,
    cron,
    scheduledTime,
  }) {
    return this.db.transaction(() => {
      const existing = this.db.prepare(`
        SELECT instance_id FROM scheduled_runs
        WHERE workflow_name=? AND cron=? AND scheduled_time=?
      `).get(workflowName, cron, scheduledTime);
      if (existing) {
        return { created: false, id: existing.instance_id };
      }

      this.createInstance({
        id,
        workflowName,
        payload,
        schedule: { cron, scheduledTime },
      });
      this.db.prepare(`
        INSERT INTO scheduled_runs(
          workflow_name, cron, scheduled_time, instance_id, created_at
        ) VALUES(?, ?, ?, ?, ?)
      `).run(workflowName, cron, scheduledTime, id, Date.now());
      this.log(
        id,
        "instance.scheduled",
        JSON.stringify({ cron, scheduledTime }),
      );
      return { created: true, id };
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

  getInstance(id) {
    return this.db.prepare("SELECT * FROM instances WHERE id = ?").get(id) ?? null;
  }

  listInstances(workflowName) {
    return this.db.prepare(
      "SELECT * FROM instances WHERE workflow_name = ? ORDER BY created_at",
    ).all(workflowName);
  }

  setInstanceStatus(id, status, { output = undefined, error = undefined } = {}) {
    const current = this.getInstance(id);
    if (!current) throw new Error(`Unknown workflow instance: ${id}`);
    const nextOutput = output === undefined ? current.output : output;
    const nextError = error === undefined ? current.error : error;
    this.db.prepare(`
      UPDATE instances SET status=@status, output=@output, error=@error, updated_at=@now
      WHERE id=@id
    `).run({
      id,
      status,
      output: nextOutput,
      error: nextError,
      now: Date.now(),
    });
    this.log(
      id,
      `instance.${status}`,
      JSON.stringify({ output: nextOutput, error: nextError }),
    );
  }

  deleteInstance(id) {
    return this.db.prepare("DELETE FROM instances WHERE id = ?").run(id).changes > 0;
  }

  listRunnable(now = Date.now()) {
    return this.db.prepare(`
      SELECT DISTINCT i.*
      FROM instances i
      LEFT JOIN timers t ON t.instance_id = i.id
      WHERE i.status IN ('queued', 'running')
         OR (i.status = 'waiting' AND t.wake_at <= ?)
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
                   OR (rr.state = 'waiting_retry' AND rr.wake_at <= ?)
                 )
             )
           )
         )
      ORDER BY i.created_at
    `).all(now, now);
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

  ensureStep(identity, ordinal, state, config, eventType = null) {
    this.db.prepare(`
      INSERT OR IGNORE INTO steps(
        instance_id, type, name, count, ordinal, state, config, event_type, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      identity.instanceId, identity.type, identity.name, identity.count,
      ordinal, state, config, eventType, Date.now(),
    );
    return this.getStep(identity);
  }

  updateStep(identity, fields) {
    const allowed = ["state", "config", "output", "error", "event_type", "completed_at"];
    const entries = Object.entries(fields).filter(([key]) => allowed.includes(key));
    if (!entries.length) return;
    const sql = entries.map(([key]) => `${key} = @${key}`).join(", ");
    this.db.prepare(`
      UPDATE steps SET ${sql}
      WHERE instance_id=@instanceId AND type=@type AND name=@name AND count=@count
    `).run({ ...identity, ...Object.fromEntries(entries) });
  }

  startAttempt(identity, attempt) {
    this.db.prepare(`
      INSERT INTO attempts(
        instance_id, step_type, step_name, step_count, attempt, state, started_at
      ) VALUES(?, ?, ?, ?, ?, 'running', ?)
    `).run(
      identity.instanceId, identity.type, identity.name, identity.count,
      attempt, Date.now(),
    );
  }

  finishAttempt(identity, attempt, state, error = null) {
    this.db.prepare(`
      UPDATE attempts SET state=?, finished_at=?, error=?
      WHERE instance_id=? AND step_type=? AND step_name=? AND step_count=? AND attempt=?
    `).run(
      state, Date.now(), error, identity.instanceId, identity.type,
      identity.name, identity.count, attempt,
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

  completeDoStep(identity, attempt, output, rollback = null) {
    this.db.transaction(() => {
      this.finishAttempt(identity, attempt, "completed", null);
      this.updateStep(identity, {
        state: "completed", output, error: null, completed_at: Date.now(),
      });
      if (rollback) {
        this.registerRollback(
          identity, identity.ordinal, rollback.config, output, null,
        );
      }
      this.deleteTimer(identity, "retry");
    })();
  }

  finishDoStepTerminal(identity, attempt, error, rollback = null) {
    this.db.transaction(() => {
      this.finishAttempt(identity, attempt, "failed", error);
      this.updateStep(identity, {
        state: "failed", error, completed_at: Date.now(),
      });
      if (rollback) {
        this.registerRollback(
          identity, identity.ordinal, rollback.config, null, error,
        );
      }
      this.deleteTimer(identity, "retry");
    })();
  }

  scheduleRetry(identity, attempt, error, wakeAt) {
    this.db.transaction(() => {
      this.finishAttempt(identity, attempt, "failed", error);
      this.updateStep(identity, { state: "waiting_retry", error, completed_at: null });
      this.putTimer(identity, "retry", wakeAt);
    })();
  }

  putTimer(identity, kind, wakeAt) {
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

  deleteTimer(identity, kind) {
    this.db.prepare(`
      DELETE FROM timers
      WHERE instance_id=? AND step_type=? AND step_name=? AND step_count=? AND kind=?
    `).run(identity.instanceId, identity.type, identity.name, identity.count, kind);
  }

  waitOnTimer(identity, ordinal, config, kind, wakeAt) {
    return this.db.transaction(() => {
      const step = this.ensureStep(identity, ordinal, "waiting", config);
      let timer = this.getTimer(identity, kind);
      if (!timer && step.state !== "completed") {
        this.putTimer(identity, kind, wakeAt);
        timer = this.getTimer(identity, kind);
      }
      return { step: this.getStep(identity), timer };
    })();
  }

  completeTimerStep(identity, kind) {
    this.db.transaction(() => {
      this.updateStep(identity, {
        state: "completed", output: null, error: null, completed_at: Date.now(),
      });
      this.deleteTimer(identity, kind);
    })();
  }

  waitForEvent(identity, ordinal, config, eventType, wakeAt, encodedEvent) {
    return this.db.transaction(() => {
      const step = this.ensureStep(
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
        this.updateStep(identity, {
          state: "completed", output, error: null, completed_at: consumedAt,
        });
        this.deleteTimer(identity, "event-timeout");
        return { step: this.getStep(identity), event, timer: null };
      }

      let timer = this.getTimer(identity, "event-timeout");
      if (!timer) {
        this.putTimer(identity, "event-timeout", wakeAt);
        timer = this.getTimer(identity, "event-timeout");
      }
      return { step: this.getStep(identity), event: null, timer };
    })();
  }

  timeoutEventStep(identity, error) {
    this.db.transaction(() => {
      this.updateStep(identity, {
        state: "failed", error, completed_at: Date.now(),
      });
      this.deleteTimer(identity, "event-timeout");
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

  registerRollback(identity, ordinal, config, output = null, stepError = null) {
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

  beginRollback(id) {
    return this.db.transaction(() => {
      const instance = this.getInstance(id);
      if (!instance) throw new Error(`Unknown workflow instance: ${id}`);
      this.db.prepare(`
        UPDATE rollback_registrations
        SET state='pending', attempt=0, wake_at=NULL, rollback_error=NULL, completed_at=NULL
        WHERE instance_id=? AND state='registered'
      `).run(id);
      this.db.prepare(`
        UPDATE instances
        SET status='rollingBack', rollback_outcome=NULL, rollback_error=NULL, updated_at=?
        WHERE id=?
      `).run(Date.now(), id);
      this.log(id, "instance.rollback.started", null);
    })();
  }

  startRollbackAttempt(identity, attempt) {
    this.db.prepare(`
      UPDATE rollback_registrations
      SET state='running', attempt=?, wake_at=NULL, rollback_error=NULL
      WHERE instance_id=? AND step_type=? AND step_name=? AND step_count=?
    `).run(
      attempt, identity.instanceId, identity.type, identity.name, identity.count,
    );
    this.log(
      identity.instanceId,
      "rollback.attempt.started",
      JSON.stringify({ type: identity.type, name: identity.name, count: identity.count, attempt }),
    );
  }

  completeRollback(identity) {
    this.db.prepare(`
      UPDATE rollback_registrations
      SET state='completed', wake_at=NULL, rollback_error=NULL, completed_at=?
      WHERE instance_id=? AND step_type=? AND step_name=? AND step_count=?
    `).run(
      Date.now(), identity.instanceId, identity.type, identity.name, identity.count,
    );
    this.log(
      identity.instanceId,
      "rollback.completed",
      JSON.stringify({ type: identity.type, name: identity.name, count: identity.count }),
    );
  }

  scheduleRollbackRetry(identity, attempt, error, wakeAt) {
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
      "rollback.retry.scheduled",
      JSON.stringify({
        type: identity.type, name: identity.name, count: identity.count,
        attempt, wakeAt: Math.trunc(wakeAt),
      }),
    );
  }

  failRollback(identity, attempt, error) {
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
      "rollback.failed",
      JSON.stringify({ type: identity.type, name: identity.name, count: identity.count, attempt }),
    );
  }

  finishRollback(id, outcome, error = null) {
    this.db.prepare(`
      UPDATE instances
      SET status='terminated', rollback_outcome=?, rollback_error=?, updated_at=?
      WHERE id=?
    `).run(outcome, error, Date.now(), id);
    this.log(id, `instance.rollback.${outcome}`, error);
    this.log(
      id,
      "instance.terminated",
      JSON.stringify({ rollbackOutcome: outcome }),
    );
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
        SET status='queued', output=NULL, error=NULL,
            rollback_outcome=NULL, rollback_error=NULL, updated_at=?
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

  close() {
    this.db.close();
  }
}
