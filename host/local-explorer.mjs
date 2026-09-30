import { decodeDurableValue } from "./serialization.mjs";

const BASE_PATH = "/cdn-cgi/local/explorer/api";
const NOT_FOUND = 10501;
const INVALID_DATE_RANGE = 10502;
const INTERNAL_ERROR = 10001;

const STATUS_NAMES = [
  "queued",
  "running",
  "paused",
  "errored",
  "terminated",
  "complete",
  "waitingForPause",
  "waiting",
];

function wrap(result, resultInfo = undefined) {
  return Response.json({
    success: true,
    errors: [],
    messages: [],
    result,
    ...(resultInfo == null ? {} : { result_info: resultInfo }),
  });
}

function fail(status, code, message) {
  return Response.json({
    success: false,
    errors: [{ code, message }],
    messages: [],
    result: null,
  }, { status });
}

function iso(ms) {
  return ms == null ? null : new Date(ms).toISOString();
}

function parseJson(value, fallback = null) {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function decode(value, fallback = undefined) {
  if (value == null) return fallback;
  try {
    return decodeDurableValue(value);
  } catch {
    return fallback;
  }
}

function visibleStatus(status) {
  return status === "rollingBack" ? "running" : status;
}

function workflowMetadata(runtime, workflow) {
  return {
    name: workflow.name,
    class_name: workflow.className,
    script_name: runtime.config.name,
  };
}

function allInstances(runtime, workflowName) {
  runtime.storage.deleteExpired(Date.now());
  return runtime.storage.listInstances(workflowName).rows;
}

function statusCounts(rows) {
  const counts = Object.fromEntries(STATUS_NAMES.map((status) => [status, 0]));
  for (const row of rows) {
    const status = visibleStatus(row.status);
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

function positiveInt(raw, fallback) {
  if (raw == null) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 ? value : null;
}

function parseDate(raw) {
  if (raw == null) return undefined;
  const value = Date.parse(raw);
  return Number.isNaN(value) ? null : value;
}

function instanceSummary(row) {
  return {
    id: row.public_id,
    status: visibleStatus(row.status),
    created_on: iso(row.created_at),
  };
}

function parsedError(value) {
  const error = parseJson(value, null);
  if (error == null) return null;
  if (typeof error === "object") return error;
  return { name: "Error", message: String(error) };
}

function isSensitive(step) {
  return parseJson(step.config, {})?.sensitive === "output";
}

function stepDetails(runtime, instanceRow, step) {
  const identity = {
    instanceId: instanceRow.id,
    type: step.type,
    name: step.name,
    count: step.count,
  };
  const start = iso(step.created_at);
  const end = iso(step.completed_at);

  if (step.type === "sleep") {
    return {
      name: step.name,
      start,
      end,
      finished: step.state === "completed",
      type: "sleep",
      error: parsedError(step.error),
    };
  }

  if (step.type === "waitForEvent") {
    return {
      name: step.name,
      start,
      end,
      finished: step.state === "completed" || step.state === "failed",
      type: "waitForEvent",
      error: parsedError(step.error),
      output: step.state === "completed"
        ? (isSensitive(step) ? "[REDACTED]" : decode(step.output, null))
        : null,
    };
  }

  const attempts = runtime.storage.listAttempts(identity).map((attempt) => ({
    start: iso(attempt.started_at),
    end: iso(attempt.finished_at),
    success: attempt.state === "completed"
      ? true
      : attempt.state === "failed"
        ? false
        : null,
    error: parsedError(attempt.error),
  }));

  return {
    name: step.name,
    start,
    end,
    success: step.state === "completed"
      ? true
      : step.state === "failed"
        ? false
        : null,
    type: "step",
    output: step.state === "completed"
      ? (isSensitive(step) ? "[REDACTED]" : decode(step.output))
      : undefined,
    config: parseJson(step.config, null),
    attempts,
  };
}

function instanceDetails(runtime, workflowName, publicId) {
  const row = runtime.requireInstance(publicId, workflowName);
  const events = runtime.storage.listExecutionEvents(row.id, 0, 10_000);
  const started = events.find((event) => event.kind === "instance.started");
  const ended = events.findLast?.((event) =>
    ["instance.complete", "instance.errored", "instance.terminated"].includes(event.kind)
  ) ?? [...events].reverse().find((event) =>
    ["instance.complete", "instance.errored", "instance.terminated"].includes(event.kind)
  );
  const steps = runtime.storage
    .listSteps(row.id)
    .map((step) => stepDetails(runtime, row, step));

  return {
    status: visibleStatus(row.status),
    params: parseJson(row.payload, null),
    queued: iso(row.created_at),
    start: iso(started?.created_at),
    end: iso(ended?.created_at),
    output: row.status === "complete" ? decode(row.output, null) : null,
    error: row.status === "errored" ? parsedError(row.error) : null,
    steps,
    step_count: steps.length,
  };
}

async function readJson(request, fallback) {
  const text = await request.text();
  if (!text) return fallback;
  return JSON.parse(text);
}

async function lifecycle(runtime, workflow, instanceId, body) {
  const binding = runtime.env()[workflow.binding];
  const instance = await binding.get(instanceId);
  switch (body.status) {
    case "pause":
      if (body.rollback !== undefined) {
        throw new TypeError("'rollback' is only valid when terminating.");
      }
      await instance.pause();
      break;
    case "resume":
      if (body.rollback !== undefined) {
        throw new TypeError("'rollback' is only valid when terminating.");
      }
      await instance.resume();
      break;
    case "restart":
      if (body.rollback !== undefined) {
        throw new TypeError("'rollback' is only valid when terminating.");
      }
      await instance.restart(body.from ? { from: body.from } : undefined);
      break;
    case "terminate":
      await instance.terminate(body.rollback === true ? { rollback: true } : undefined);
      break;
    default:
      throw new TypeError(`Unsupported workflow lifecycle status: ${body.status}`);
  }
  const status = await instance.status();
  return {
    status: status.status,
    timestamp: new Date().toISOString(),
  };
}

export async function handleWranglerLocalExplorer(runtime, request) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(BASE_PATH)) return null;

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": request.headers.get("origin") ?? "*",
        "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
        "access-control-allow-headers": "Content-Type",
      },
    });
  }

  const suffix = url.pathname.slice(BASE_PATH.length);
  const parts = suffix.split("/").filter(Boolean).map(decodeURIComponent);

  try {
    if (parts.length === 0 && request.method === "GET") {
      return wrap({
        name: "workflows.mbt local explorer compatibility API",
        version: 1,
      });
    }

    if (parts[0] !== "workflows") {
      return fail(404, NOT_FOUND, "Endpoint not found");
    }

    if (parts.length === 1 && request.method === "GET") {
      return wrap(
        runtime.config.workflows.map((workflow) => workflowMetadata(runtime, workflow)),
        { count: runtime.config.workflows.length },
      );
    }

    const workflowName = parts[1];
    const workflow = runtime.workflowByName.get(workflowName);
    if (!workflow) {
      return fail(404, NOT_FOUND, `Workflow '${workflowName}' not found.`);
    }

    if (parts.length === 2) {
      if (request.method === "GET") {
        const rows = allInstances(runtime, workflowName);
        return wrap({
          ...workflowMetadata(runtime, workflow),
          instances: statusCounts(rows),
        });
      }
      if (request.method === "DELETE") {
        for (const row of allInstances(runtime, workflowName)) {
          runtime.storage.deleteInstance(row.id);
        }
        return wrap({ status: "ok", success: true });
      }
      return fail(405, INTERNAL_ERROR, "Method not allowed");
    }

    if (parts[2] !== "instances") {
      return fail(404, NOT_FOUND, "Endpoint not found");
    }

    if (parts.length === 3) {
      if (request.method === "GET") {
        const page = positiveInt(url.searchParams.get("page"), 1);
        const perPage = positiveInt(url.searchParams.get("per_page"), 25);
        if (page == null || perPage == null || perPage > 1000) {
          return fail(400, INTERNAL_ERROR, "Invalid pagination parameters");
        }

        const dateStart = parseDate(url.searchParams.get("date_start"));
        const dateEnd = parseDate(url.searchParams.get("date_end"));
        if (dateStart === null || dateEnd === null) {
          return fail(400, INVALID_DATE_RANGE, "Invalid workflow instance date filter.");
        }
        if (dateStart !== undefined && dateEnd !== undefined && dateStart > dateEnd) {
          return fail(
            400,
            INVALID_DATE_RANGE,
            "'date_start' must not be after 'date_end'. Update 'date_start' or 'date_end' so 'date_start' is before or equal to 'date_end'.",
          );
        }

        const requestedStatus = url.searchParams.get("status");
        const rows = allInstances(runtime, workflowName);
        const counts = statusCounts(rows);
        const filtered = rows
          .filter((row) => requestedStatus == null || visibleStatus(row.status) === requestedStatus)
          .filter((row) => {
            if (dateStart === undefined && dateEnd === undefined) return true;
            return row.created_at >= (dateStart ?? -Infinity) &&
              row.created_at <= (dateEnd ?? Infinity);
          })
          .sort((a, b) => b.created_at - a.created_at);
        const offset = (page - 1) * perPage;
        const selected = filtered.slice(offset, offset + perPage).map(instanceSummary);
        return wrap(selected, {
          page,
          per_page: perPage,
          total_count: filtered.length,
          total_pages: Math.max(1, Math.ceil(filtered.length / perPage)),
          status_counts: counts,
        });
      }

      if (request.method === "POST") {
        const body = await readJson(request, {});
        const instance = await runtime.createInstance(workflowName, {
          id: body.id,
          params: body.params,
        });
        return wrap({ id: instance.id });
      }

      return fail(405, INTERNAL_ERROR, "Method not allowed");
    }

    if (
      parts.length === 5 &&
      parts[3] === "batch" &&
      parts[4] === "delete" &&
      request.method === "POST"
    ) {
      const body = await readJson(request, {});
      if (!Array.isArray(body.instances)) {
        return fail(400, INTERNAL_ERROR, "instances must be an array");
      }
      const result = await runtime.env()[workflow.binding].deleteBatch(body.instances);
      return wrap(result);
    }

    const instanceId = parts[3];

    if (parts.length === 4) {
      if (request.method === "GET") {
        return wrap(instanceDetails(runtime, workflowName, instanceId));
      }
      if (request.method === "DELETE") {
        const instance = await runtime.env()[workflow.binding].get(instanceId);
        await instance.delete();
        return wrap({ success: true });
      }
      return fail(405, INTERNAL_ERROR, "Method not allowed");
    }

    if (parts.length === 5 && parts[4] === "status" && request.method === "PATCH") {
      const body = await readJson(request, {});
      return wrap(await lifecycle(runtime, workflow, instanceId, body));
    }

    if (
      parts.length === 6 &&
      parts[4] === "events" &&
      request.method === "POST"
    ) {
      const eventType = parts[5];
      const payload = await readJson(request, undefined);
      const instance = await runtime.env()[workflow.binding].get(instanceId);
      await instance.sendEvent({ type: eventType, payload });
      return wrap({ success: true });
    }

    return fail(404, NOT_FOUND, "Endpoint not found");
  } catch (error) {
    const message = error?.message ?? String(error);
    const notFound =
      /not found/i.test(message) ||
      /Unknown workflow instance/i.test(message);
    const conflict = /cannot restart/i.test(message);
    const badRequest = error instanceof TypeError || error instanceof SyntaxError;
    return fail(
      notFound ? 404 : conflict ? 409 : badRequest ? 400 : 500,
      notFound ? NOT_FOUND : INTERNAL_ERROR,
      message,
    );
  }
}
