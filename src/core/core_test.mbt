///|
test "step identity includes type name and 1-origin count" {
  inspect(step_key("abc", "do", "process", 2), content="abc/do/process/2")
}

///|
test "retry backoff matches Cloudflare-compatible rules" {
  inspect(retry_delay_ms(10000, 1, "constant"), content="10000")
  inspect(retry_delay_ms(10000, 3, "linear"), content="30000")
  inspect(retry_delay_ms(10000, 3, "exponential"), content="40000")
}

///|
test "compatibility defaults are fixed in the MoonBit kernel" {
  inspect(default_retry_limit(), content="5")
  inspect(default_retry_delay_ms(), content="10000")
  inspect(default_step_timeout(), content="10 minutes")
  inspect(default_wait_timeout_ms(), content="86400000")
  inspect(default_backoff(), content="exponential")
}

///|
test "retry delay clamps negative bases and unknown backoffs stay constant" {
  inspect(retry_delay_ms(-5, 3, "linear"), content="0")
  inspect(retry_delay_ms(-5, 3, "exponential"), content="0")
  inspect(retry_delay_ms(10000, 3, "constant"), content="10000")
  inspect(retry_delay_ms(10000, 3, "bogus"), content="10000")
}

///|
test "only in-flight instance statuses may execute" {
  inspect(can_execute_instance("queued"), content="true")
  inspect(can_execute_instance("running"), content="true")
  inspect(can_execute_instance("waiting"), content="true")
  inspect(can_execute_instance("waitingForPause"), content="true")
  inspect(can_execute_instance("paused"), content="false")
  inspect(can_execute_instance("complete"), content="false")
  inspect(can_execute_instance("errored"), content="false")
  inspect(can_execute_instance("terminated"), content="false")
  inspect(can_execute_instance("rollingBack"), content="false")
}

///|
test "replay and timer decisions are deterministic" {
  inspect(should_replay_output("completed"), content="true")
  inspect(should_replay_output("running"), content="false")
  inspect(deadline_ready(20.0, 10.0), content="true")
  inspect(deadline_ready(9.0, 10.0), content="false")
  inspect(reuse_before_restart(2, 3), content="true")
  inspect(reuse_before_restart(3, 3), content="false")
}
