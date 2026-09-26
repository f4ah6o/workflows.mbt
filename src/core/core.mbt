///|
/// Deterministic durable-execution decisions shared by every host operation.
/// OS I/O, SQLite calls, and JavaScript callback invocation deliberately live
/// outside this package; the host cannot override these state-machine rules.
#export_name("wf_step_key")
pub fn step_key(
  instance_id : String,
  step_type : String,
  name : String,
  count : Int,
) -> String {
  instance_id + "/" + step_type + "/" + name + "/" + count.to_string()
}

///|
fn pow2(n : Int) -> Int {
  if n <= 0 {
    1
  } else {
    2 * pow2(n - 1)
  }
}

///|
/// Compute the durable delay after a failed attempt. attempt is 1-origin and is
/// the attempt which just failed, so the first exponential retry uses base_ms.
#export_name("wf_retry_delay_ms")
pub fn retry_delay_ms(base_ms : Int, attempt : Int, backoff : String) -> Int {
  if base_ms < 0 {
    0
  } else if backoff == "linear" {
    base_ms * attempt
  } else if backoff == "exponential" {
    base_ms * pow2(attempt - 1)
  } else {
    base_ms
  }
}

///|
#export_name("wf_default_retry_limit")
pub fn default_retry_limit() -> Int {
  5
}

///|
#export_name("wf_default_retry_delay_ms")
pub fn default_retry_delay_ms() -> Int {
  10000
}

///|
#export_name("wf_default_wait_timeout_ms")
pub fn default_wait_timeout_ms() -> Int {
  86400000
}

///|
#export_name("wf_default_backoff")
pub fn default_backoff() -> String {
  "exponential"
}

///|
/// Only terminal completed steps replay their durable output without executing
/// user callback code again.
#export_name("wf_should_replay_output")
pub fn should_replay_output(state : String) -> Bool {
  state == "completed"
}

///|
/// A persisted deadline, not process uptime, decides whether a timer is ready.
#export_name("wf_deadline_ready")
pub fn deadline_ready(now_ms : Double, wake_at_ms : Double) -> Bool {
  now_ms >= wake_at_ms
}

///|
#export_name("wf_can_execute_instance")
pub fn can_execute_instance(status : String) -> Bool {
  status == "queued" ||
  status == "running" ||
  status == "waiting" ||
  status == "waitingForPause"
}

///|
/// Restart-from-step reuses every step that precedes the target ordinal.
#export_name("wf_reuse_before_restart")
pub fn reuse_before_restart(step_ordinal : Int, target_ordinal : Int) -> Bool {
  step_ordinal < target_ordinal
}
