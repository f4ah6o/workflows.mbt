// The storage contract is workflow-semantic: methods describe runtime
// operations (claims, durable timers, rollback registrations, stream commits),
// never SQL shapes. A second backend (e.g. PostgreSQL) proves portability by
// implementing this surface with the same atomic boundaries.
//
// Lease fencing: every committing method that can run inside a leased
// execution takes a trailing `lease` parameter (the caller's executorId).
// When non-null, the implementation MUST re-validate lease ownership inside
// the same transaction as the mutation and throw a `WorkflowLeaseLostError`
// if the lease was lost or expired — a check outside the transaction is not
// a fence. Lifecycle commands (restart, delete, pause-driven status writes)
// pass no lease and stay unfenced.
export class Storage {
  // Registration
  registerWorkflow(_workflow) { throw new Error("Storage.registerWorkflow not implemented"); }

  // Instance lifecycle
  createInstance(_instance) { throw new Error("Storage.createInstance not implemented"); }
  claimScheduledInstance(_schedule) { throw new Error("Storage.claimScheduledInstance not implemented"); }
  getScheduleCursor(_workflowName, _cron) { throw new Error("Storage.getScheduleCursor not implemented"); }
  setScheduleCursor(_workflowName, _cron, _lastCheckedAt) { throw new Error("Storage.setScheduleCursor not implemented"); }
  deleteExpired(_now) { throw new Error("Storage.deleteExpired not implemented"); }
  getInstance(_id) { throw new Error("Storage.getInstance not implemented"); }
  getInstanceByPublic(_workflowName, _publicId) { throw new Error("Storage.getInstanceByPublic not implemented"); }
  findInstancesByPublic(_publicId) { throw new Error("Storage.findInstancesByPublic not implemented"); }
  listInstances(_workflowName, _options) { throw new Error("Storage.listInstances not implemented"); }
  setInstanceStatus(_id, _status, _fields, _lease) { throw new Error("Storage.setInstanceStatus not implemented"); }
  deleteInstance(_id) { throw new Error("Storage.deleteInstance not implemented"); }
  listRunnable(_now, _executorId) { throw new Error("Storage.listRunnable not implemented"); }
  restartInstance(_id, _from) { throw new Error("Storage.restartInstance not implemented"); }
  markInstanceStarted(_instanceId, _params, _lease) { throw new Error("Storage.markInstanceStarted not implemented"); }

  // Executor leases (one active executor per instance; expiry = crash)
  claimInstance(_id, _owner, _ttlMs, _now) { throw new Error("Storage.claimInstance not implemented"); }
  renewLease(_id, _owner, _ttlMs, _now) { throw new Error("Storage.renewLease not implemented"); }
  releaseLease(_id, _owner) { throw new Error("Storage.releaseLease not implemented"); }
  assertLease(_instanceId, _lease) { throw new Error("Storage.assertLease not implemented"); }

  // Steps and attempts
  getStep(_identity) { throw new Error("Storage.getStep not implemented"); }
  listSteps(_instanceId) { throw new Error("Storage.listSteps not implemented"); }
  ensureStep(_identity, _ordinal, _state, _config, _eventType, _lease) { throw new Error("Storage.ensureStep not implemented"); }
  updateStep(_identity, _fields, _lease) { throw new Error("Storage.updateStep not implemented"); }
  startAttempt(_identity, _attempt, _lease) { throw new Error("Storage.startAttempt not implemented"); }
  finishAttempt(_identity, _attempt, _state, _error, _retryDelayMs, _lease) { throw new Error("Storage.finishAttempt not implemented"); }
  countAttempts(_identity) { throw new Error("Storage.countAttempts not implemented"); }
  listAttempts(_identity) { throw new Error("Storage.listAttempts not implemented"); }

  // Atomic step boundaries
  completeDoStep(_identity, _attempt, _output, _rollback, _stream, _lease) { throw new Error("Storage.completeDoStep not implemented"); }
  finishDoStepTerminal(_identity, _attempt, _error, _rollback, _stepError, _lease) { throw new Error("Storage.finishDoStepTerminal not implemented"); }
  failDoStepSerialization(_identity, _attempt, _error, _rollback, _lease) { throw new Error("Storage.failDoStepSerialization not implemented"); }
  scheduleRetry(_identity, _attempt, _error, _wakeAt, _lease) { throw new Error("Storage.scheduleRetry not implemented"); }

  // Durable timers (sleep, retry, event-timeout, attempt-timeout)
  putTimer(_identity, _kind, _wakeAt, _lease) { throw new Error("Storage.putTimer not implemented"); }
  getTimer(_identity, _kind) { throw new Error("Storage.getTimer not implemented"); }
  deleteTimer(_identity, _kind, _lease) { throw new Error("Storage.deleteTimer not implemented"); }
  waitOnTimer(_identity, _ordinal, _config, _kind, _wakeAt, _lease) { throw new Error("Storage.waitOnTimer not implemented"); }
  completeTimerStep(_identity, _kind, _lease) { throw new Error("Storage.completeTimerStep not implemented"); }

  // Events: consume + wait completion must be atomic
  waitForEvent(_identity, _ordinal, _config, _eventType, _wakeAt, _encodedEvent, _lease) { throw new Error("Storage.waitForEvent not implemented"); }
  timeoutEventStep(_identity, _error, _lease) { throw new Error("Storage.timeoutEventStep not implemented"); }
  addEvent(_instanceId, _type, _payload) { throw new Error("Storage.addEvent not implemented"); }

  // Rollback registrations and execution
  registerRollback(_identity, _ordinal, _config, _output, _stepError, _lease) { throw new Error("Storage.registerRollback not implemented"); }
  listRollbackRegistrations(_instanceId) { throw new Error("Storage.listRollbackRegistrations not implemented"); }
  getRollbackRegistration(_identity) { throw new Error("Storage.getRollbackRegistration not implemented"); }
  beginRollback(_id, _options, _lease) { throw new Error("Storage.beginRollback not implemented"); }
  startRollbackAttempt(_identity, _attempt, _lease) { throw new Error("Storage.startRollbackAttempt not implemented"); }
  completeRollback(_identity, _lease) { throw new Error("Storage.completeRollback not implemented"); }
  scheduleRollbackRetry(_identity, _attempt, _error, _wakeAt, _lease) { throw new Error("Storage.scheduleRollbackRetry not implemented"); }
  failRollback(_identity, _attempt, _error, _lease) { throw new Error("Storage.failRollback not implemented"); }
  finishRollback(_id, _outcome, _error, _lease) { throw new Error("Storage.finishRollback not implemented"); }

  // Persisted step streams
  beginStepStream(_identity, _streamId, _lease) { throw new Error("Storage.beginStepStream not implemented"); }
  appendStreamChunk(_streamId, _seq, _bytes, _lease) { throw new Error("Storage.appendStreamChunk not implemented"); }
  commitStream(_streamId, _byteLength, _chunkCount) { throw new Error("Storage.commitStream not implemented"); }
  abandonStream(_streamId) { throw new Error("Storage.abandonStream not implemented"); }
  getStream(_streamId) { throw new Error("Storage.getStream not implemented"); }
  openStream(_streamId) { throw new Error("Storage.openStream not implemented"); }

  // Execution event log (subscription feed)
  listExecutionEvents(_instanceId, _afterId, _limit) { throw new Error("Storage.listExecutionEvents not implemented"); }
  log(_instanceId, _kind, _detail) { throw new Error("Storage.log not implemented"); }

  close() {}
}
