import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export async function loadKernel(path = resolve("dist/workflows_core.mjs")) {
  const mod = await import(pathToFileURL(path).href);
  const required = [
    "wf_step_key",
    "wf_retry_delay_ms",
    "wf_default_retry_limit",
    "wf_default_retry_delay_ms",
    "wf_default_step_timeout",
    "wf_default_wait_timeout_ms",
    "wf_default_backoff",
    "wf_should_replay_output",
    "wf_deadline_ready",
    "wf_can_execute_instance",
    "wf_reuse_before_restart",
  ];
  for (const name of required) {
    if (typeof mod[name] !== "function") {
      throw new Error(`MoonBit kernel is missing export ${name}; run npm run build:core`);
    }
  }

  return {
    stepKey: mod.wf_step_key,
    retryDelayMs: mod.wf_retry_delay_ms,
    defaultRetryLimit: mod.wf_default_retry_limit,
    defaultRetryDelayMs: mod.wf_default_retry_delay_ms,
    defaultStepTimeout: mod.wf_default_step_timeout,
    defaultWaitTimeoutMs: mod.wf_default_wait_timeout_ms,
    defaultBackoff: mod.wf_default_backoff,
    shouldReplayOutput: mod.wf_should_replay_output,
    deadlineReady: mod.wf_deadline_ready,
    canExecuteInstance: mod.wf_can_execute_instance,
    reuseBeforeRestart: mod.wf_reuse_before_restart,
  };
}
