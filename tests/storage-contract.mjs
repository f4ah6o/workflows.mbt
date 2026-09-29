// Shared workflow-semantic storage contract suite, run against every backend
// (SQLite always; PostgreSQL when WORKFLOWS_POSTGRES_URL is set). `open(t)`
// returns a fresh Storage implementation registered for t.after(close).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

export function storageContractTests(label, open) {
  const workflow = {
    name: "contract-wf",
    binding: "WF",
    className: "ContractWorkflow",
    main: "src/index.ts",
  };

  function freshInstance(storage, id = `pub-${randomUUID()}`) {
    return storage.createInstance({
      id,
      workflowName: workflow.name,
      payload: "{}",
    });
  }

  const identityOf = (instanceId, overrides = {}) => ({
    instanceId,
    type: "do",
    name: "step-a",
    count: 1,
    ordinal: 1,
    ...overrides,
  });

  test(`${label}: workflow registration and instance lifecycle`, (t) => {
    const storage = open(t);
    storage.registerWorkflow(workflow);
    const instance = freshInstance(storage, "public-1");
    assert.equal(instance.public_id, "public-1");
    assert.equal(instance.status, "queued");
    assert.equal(storage.getInstance(instance.id).id, instance.id);

    assert.throws(
      () =>
        storage.createInstance({
          id: "public-1",
          workflowName: workflow.name,
          payload: "{}",
        }),
      (error) => error.alreadyExists === true,
    );

    // The same public id under another workflow gets a distinct storage id.
    storage.registerWorkflow({ ...workflow, name: "contract-wf-2" });
    const other = storage.createInstance({
      id: "public-1",
      workflowName: "contract-wf-2",
      payload: "{}",
    });
    assert.notEqual(other.id, instance.id);
    assert.equal(
      storage.getInstanceByPublic("contract-wf-2", "public-1").id,
      other.id,
    );
    assert.equal(storage.findInstancesByPublic("public-1").length, 2);

    assert.equal(storage.getInstance("missing"), null);
    assert.throws(
      () => storage.setInstanceStatus("missing", "running"),
      /Unknown workflow instance/,
    );
  });

  test(`${label}: listInstances filters, paginates, and reports total`, (t) => {
    const storage = open(t);
    storage.registerWorkflow(workflow);
    for (let i = 0; i < 3; i += 1) freshInstance(storage);
    storage.setInstanceStatus(
      storage.listInstances(workflow.name).rows[0].id,
      "complete",
    );
    const all = storage.listInstances(workflow.name);
    assert.equal(all.total, 3);
    assert.equal(all.rows.length, 3);
    const complete = storage.listInstances(workflow.name, { status: "complete" });
    assert.equal(complete.total, 1);
    const paged = storage.listInstances(workflow.name, { offset: 1, limit: 1 });
    assert.equal(paged.rows.length, 1);
    assert.equal(paged.total, 3);
  });

  test(`${label}: executor lease claim, renew, release, expiry reclaim`, (t) => {
    const storage = open(t);
    storage.registerWorkflow(workflow);
    const instance = freshInstance(storage);

    assert.equal(storage.claimInstance(instance.id, "exec-a", 60_000), true);
    assert.equal(storage.claimInstance(instance.id, "exec-b", 60_000), false);
    assert.equal(storage.renewLease(instance.id, "exec-b", 60_000), false);
    assert.equal(storage.renewLease(instance.id, "exec-a", 60_000), true);
    assert.equal(storage.releaseLease(instance.id, "exec-b"), false);
    assert.equal(storage.releaseLease(instance.id, "exec-a"), true);
    assert.equal(storage.claimInstance(instance.id, "exec-b", 60_000), true);

    // An expired lease is reclaimable by another owner; one still live is not.
    const later = Date.now() + 61_000;
    assert.equal(storage.claimInstance(instance.id, "exec-a", 5_000, later), true);
    assert.equal(storage.claimInstance(instance.id, "exec-b", 60_000), false);
    assert.equal(
      storage.claimInstance(instance.id, "exec-b", 60_000, later + 5_001),
      true,
    );
  });

  test(`${label}: listRunnable excludes live foreign leases`, (t) => {
    const storage = open(t);
    storage.registerWorkflow(workflow);
    const instance = freshInstance(storage);
    const now = Date.now();

    assert.deepEqual(
      storage.listRunnable(now, "exec-b").map((row) => row.id),
      [instance.id],
    );
    assert.equal(storage.claimInstance(instance.id, "exec-a", 60_000, now), true);
    assert.deepEqual(storage.listRunnable(now, "exec-b"), []);
    assert.deepEqual(
      storage.listRunnable(now, "exec-a").map((row) => row.id),
      [instance.id],
    );
    // After the lease expires the instance is runnable again.
    assert.deepEqual(
      storage.listRunnable(now + 120_000, "exec-b").map((row) => row.id),
      [instance.id],
    );
  });

  test(`${label}: lease fencing rejects commits from a stale owner`, (t) => {
    const storage = open(t);
    storage.registerWorkflow(workflow);
    const instance = freshInstance(storage);
    const identity = identityOf(instance.id);
    assert.equal(storage.claimInstance(instance.id, "exec-a", 60_000), true);

    assert.throws(
      () =>
        storage.ensureStep(identity, 1, "running", "{}", null, "exec-b"),
      (error) => error.name === "WorkflowLeaseLostError",
    );
    assert.throws(
      () =>
        storage.setInstanceStatus(instance.id, "running", {}, "exec-b"),
      (error) => error.name === "WorkflowLeaseLostError",
    );
    // The real owner's commits succeed; unfenced (null-lease) calls stay open
    // for lifecycle commands.
    storage.ensureStep(identity, 1, "running", "{}", null, "exec-a");
    storage.setInstanceStatus(instance.id, "paused");
    assert.equal(storage.getInstance(instance.id).status, "paused");
  });

  test(`${label}: step completion, retry scheduling, and timers are atomic`, (t) => {
    const storage = open(t);
    storage.registerWorkflow(workflow);
    const instance = freshInstance(storage);
    const identity = identityOf(instance.id);

    storage.ensureStep(identity, 1, "running", "{}");
    storage.startAttempt(identity, 1);
    const wakeAt = Date.now() + 60_000;
    storage.scheduleRetry(identity, 1, "boom", wakeAt);
    assert.equal(storage.getStep(identity).state, "waiting_retry");
    assert.equal(storage.getTimer(identity, "retry").wake_at, wakeAt);
    assert.equal(storage.listAttempts(identity)[0].state, "failed");
    assert.equal(
      storage.listAttempts(identity)[0].error,
      "boom",
    );

    // Retried attempt commits the step and clears the retry timer.
    storage.startAttempt(identity, 2);
    storage.completeDoStep(identity, 2, '{"ok":true}', null);
    const step = storage.getStep(identity);
    assert.equal(step.state, "completed");
    assert.equal(step.output, '{"ok":true}');
    assert.equal(storage.getTimer(identity, "retry"), null);
    assert.equal(storage.countAttempts(identity), 2);
    assert.deepEqual(
      storage.listAttempts(identity).map((attempt) => attempt.state),
      ["failed", "completed"],
    );
  });

  test(`${label}: finishDoStepTerminal records failure and rollback`, (t) => {
    const storage = open(t);
    storage.registerWorkflow(workflow);
    const instance = freshInstance(storage);
    const identity = identityOf(instance.id);

    storage.ensureStep(identity, 1, "running", "{}");
    storage.startAttempt(identity, 1);
    storage.finishDoStepTerminal(
      identity,
      1,
      "WorkflowFatalError: nope",
      { config: '{"retry":{}}' },
      "nope",
    );
    const step = storage.getStep(identity);
    assert.equal(step.state, "failed");
    assert.equal(step.error, "nope");
    const registration = storage.getRollbackRegistration(identity);
    assert.equal(registration.state, "registered");
    assert.equal(registration.step_error, "WorkflowFatalError: nope");
  });

  test(`${label}: waitOnTimer and completeTimerStep drive durable sleeps`, (t) => {
    const storage = open(t);
    storage.registerWorkflow(workflow);
    const instance = freshInstance(storage);
    const identity = identityOf(instance.id, { type: "sleep", name: "nap" });
    const wakeAt = Date.now() + 5_000;

    const first = storage.waitOnTimer(identity, 1, '{"durationMs":5000}', "sleep", wakeAt);
    assert.equal(first.step.state, "waiting");
    assert.equal(first.timer.wake_at, wakeAt);

    // Re-entry is idempotent: the existing timer is reused, not reset.
    const second = storage.waitOnTimer(identity, 1, '{"durationMs":5000}', "sleep", wakeAt + 10_000);
    assert.equal(second.timer.wake_at, wakeAt);

    storage.completeTimerStep(identity, "sleep");
    assert.equal(storage.getStep(identity).state, "completed");
    assert.equal(storage.getTimer(identity, "sleep"), null);
  });

  test(`${label}: waitForEvent consumes buffered events atomically`, (t) => {
    const storage = open(t);
    storage.registerWorkflow(workflow);
    const instance = freshInstance(storage);
    const identity = identityOf(instance.id, {
      type: "waitForEvent",
      name: "approval",
    });
    const encode = (event) => JSON.stringify({ id: event.id, type: event.type });
    const wakeAt = Date.now() + 60_000;

    const idle = storage.waitForEvent(
      identity, 1, "{}", "approved", wakeAt, encode,
    );
    assert.equal(idle.step.state, "waiting");
    assert.equal(idle.event, null);
    assert.ok(idle.timer);

    storage.addEvent(instance.id, "approved", '{"ok":true}');
    const consumed = storage.waitForEvent(
      identity, 1, "{}", "approved", wakeAt, encode,
    );
    assert.equal(consumed.step.state, "completed");
    assert.equal(consumed.step.output, encode(consumed.event));
    assert.equal(consumed.timer, null);
    assert.equal(storage.getTimer(identity, "event-timeout"), null);

    // The event is consumed exactly once: a re-entrant wait sees none left.
    const replay = storage.waitForEvent(
      identity, 1, "{}", "approved", wakeAt, encode,
    );
    assert.equal(replay.step.state, "completed");
    assert.equal(replay.event, null);
  });

  test(`${label}: timeoutEventStep fails the wait and clears its timer`, (t) => {
    const storage = open(t);
    storage.registerWorkflow(workflow);
    const instance = freshInstance(storage);
    const identity = identityOf(instance.id, {
      type: "waitForEvent",
      name: "approval",
    });
    storage.waitForEvent(identity, 1, "{}", "approved", Date.now() + 5_000, (e) => e);
    storage.timeoutEventStep(identity, "Execution timed out after 5000ms");
    const step = storage.getStep(identity);
    assert.equal(step.state, "failed");
    assert.equal(step.error, "Execution timed out after 5000ms");
    assert.equal(storage.getTimer(identity, "event-timeout"), null);
  });

  test(`${label}: restart-from-step invalidates only the target onward`, (t) => {
    const storage = open(t);
    storage.registerWorkflow(workflow);
    const instance = freshInstance(storage);
    const first = identityOf(instance.id, { name: "A", ordinal: 1 });
    const second = identityOf(instance.id, { name: "B", ordinal: 2 });
    for (const identity of [first, second]) {
      storage.ensureStep(identity, identity.ordinal, "running", "{}");
      storage.startAttempt(identity, 1);
      storage.completeDoStep(identity, 1, `"${identity.name}"`, { config: "{}" });
      storage.putTimer(identity, "retry", Date.now() + 60_000);
    }

    storage.restartInstance(instance.id, { name: "B", type: "do", count: 1 });
    const steps = storage.listSteps(instance.id);
    assert.deepEqual(steps.map((step) => step.name), ["A"]);
    assert.equal(steps[0].state, "completed");
    const fresh = storage.getInstance(instance.id);
    assert.equal(fresh.status, "queued");
    assert.equal(fresh.output, null);
    assert.equal(storage.getTimer(second, "retry"), null);
    assert.equal(storage.getRollbackRegistration(second), null);
    assert.equal(storage.countAttempts(second), 0);

    assert.throws(
      () => storage.restartInstance(instance.id, { name: "nope" }),
      /Restart target not found/,
    );
  });

  test(`${label}: rollback registration and execution lifecycle`, (t) => {
    const storage = open(t);
    storage.registerWorkflow(workflow);
    const instance = freshInstance(storage);
    const identities = [
      identityOf(instance.id, { name: "first", ordinal: 1 }),
      identityOf(instance.id, { name: "second", ordinal: 2 }),
    ];
    storage.registerRollback(identities[0], 1, "{}", '"out-1"');
    storage.registerRollback(identities[1], 2, "{}", '"out-2"');
    assert.deepEqual(
      storage.listRollbackRegistrations(instance.id).map((row) => row.step_name),
      ["second", "first"],
    );

    storage.beginRollback(instance.id, { terminalStatus: "terminated" });
    assert.equal(storage.getInstance(instance.id).status, "rollingBack");
    assert.equal(
      storage.getRollbackRegistration(identities[0]).state,
      "pending",
    );

    storage.startRollbackAttempt(identities[1], 1);
    assert.equal(
      storage.getRollbackRegistration(identities[1]).state,
      "running",
    );
    storage.scheduleRollbackRetry(identities[1], 1, "rb boom", Date.now() + 5_000);
    assert.equal(
      storage.getRollbackRegistration(identities[1]).state,
      "waiting_retry",
    );
    storage.startRollbackAttempt(identities[1], 2);
    storage.completeRollback(identities[1]);
    assert.equal(
      storage.getRollbackRegistration(identities[1]).state,
      "completed",
    );

    storage.failRollback(identities[0], 1, "rb fail");
    storage.finishRollback(instance.id, "failed", "rb fail");
    const done = storage.getInstance(instance.id);
    assert.equal(done.status, "terminated");
    assert.equal(done.rollback_outcome, "failed");
    assert.equal(done.rollback_error, "rb fail");
  });

  test(`${label}: scheduled firing claims are idempotent`, (t) => {
    const storage = open(t);
    storage.registerWorkflow(workflow);
    const scheduledTime = Math.floor(Date.now() / 60_000) * 60_000;

    const first = storage.claimScheduledInstance({
      id: `cf_${randomUUID()}`,
      workflowName: workflow.name,
      payload: "{}",
      cron: "* * * * *",
      scheduledTime,
    });
    assert.equal(first.created, true);

    const second = storage.claimScheduledInstance({
      id: `cf_${randomUUID()}`,
      workflowName: workflow.name,
      payload: "{}",
      cron: "* * * * *",
      scheduledTime,
    });
    assert.equal(second.created, false);
    const { rows } = storage.listInstances(workflow.name);
    assert.equal(rows.length, 1);

    storage.setScheduleCursor(workflow.name, "* * * * *", scheduledTime);
    assert.equal(
      storage.getScheduleCursor(workflow.name, "* * * * *"),
      scheduledTime,
    );
    storage.setScheduleCursor(workflow.name, "* * * * *", scheduledTime + 60_000);
    assert.equal(
      storage.getScheduleCursor(workflow.name, "* * * * *"),
      scheduledTime + 60_000,
    );
  });

  test(`${label}: subscription event log orders and pages`, (t) => {
    const storage = open(t);
    storage.registerWorkflow(workflow);
    const instance = freshInstance(storage);
    const baseline = storage.listExecutionEvents(instance.id).at(-1).id;
    storage.log(instance.id, "one", null);
    storage.log(instance.id, "two", '{"a":1}');
    storage.log(instance.id, "three", null);

    const events = storage.listExecutionEvents(instance.id, baseline);
    assert.deepEqual(events.map((event) => event.kind), ["one", "two", "three"]);
    const resumed = storage.listExecutionEvents(instance.id, events[0].id);
    assert.deepEqual(resumed.map((event) => event.kind), ["two", "three"]);
    assert.equal(
      storage.listExecutionEvents(instance.id, baseline, 2).length,
      2,
    );
  });

  test(`${label}: persisted step streams commit atomically and reopen`, async (t) => {
    const storage = open(t);
    storage.registerWorkflow(workflow);
    const instance = freshInstance(storage);
    const identity = identityOf(instance.id);
    storage.ensureStep(identity, 1, "running", "{}");
    storage.startAttempt(identity, 1);

    storage.beginStepStream(identity, "stream-1");
    storage.appendStreamChunk("stream-1", 0, new Uint8Array([1, 2, 3]));
    storage.appendStreamChunk("stream-1", 1, new Uint8Array([4, 5]));
    // Uncommitted: the stream is not readable before the step commits.
    assert.throws(() => storage.openStream("stream-1"), /not committed/);
    storage.completeDoStep(identity, 1, null, null, {
      id: "stream-1",
      bytes: 5,
      chunks: 2,
    });
    assert.equal(storage.getStream("stream-1").state, "committed");

    const chunks = [];
    const reader = storage.openStream("stream-1").getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(...value);
    }
    assert.deepEqual(chunks, [1, 2, 3, 4, 5]);

    // A rerun replaces the abandoned/writing stream for the same step.
    storage.beginStepStream(identity, "stream-2");
    assert.equal(storage.getStream("stream-1"), null);
    storage.abandonStream("stream-2");
    assert.equal(storage.getStream("stream-2"), null);
  });

  test(`${label}: retention expiry deletes instances`, (t) => {
    const storage = open(t);
    storage.registerWorkflow(workflow);
    const instance = storage.createInstance({
      id: `pub-${randomUUID()}`,
      workflowName: workflow.name,
      payload: "{}",
      retention: { successRetentionMs: 1_000, errorRetentionMs: null },
    });
    storage.setInstanceStatus(instance.id, "complete");
    assert.ok(storage.getInstance(instance.id).expires_at != null);
    assert.equal(storage.deleteExpired(Date.now() + 10_000), 1);
    assert.equal(storage.getInstance(instance.id), null);
  });
}
