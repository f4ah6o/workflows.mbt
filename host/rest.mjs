import { decodeDurableValue } from "./serialization.mjs";

const INSTANCE_STATUSES = new Set([
  "queued", "running", "paused", "errored", "terminated",
  "complete", "waitingForPause", "waiting", "rollingBack",
]);

function ok(result, { status = 200, resultInfo } = {}) {
  return Response.json({
    success: true,
    errors: [],
    messages: [],
    result,
    ...(resultInfo == null ? {} : { result_info: resultInfo }),
  }, { status });
}

function fail(code, message, status = 400) {
  return Response.json({
    success: false,
    errors: [{ code, message }],
    messages: [],
    result: null,
  }, { status });
}

function statusBody(runtime, workflowName, id) {
  const status = runtime.instanceStatus(id, workflowName);
  return {
    id: status.id,
    workflow_name: status.workflowName,
    status: status.status,
    output: status.output,
    error: status.error,
    rollback: status.rollback,
    created_at: status.createdAt.toISOString(),
    updated_at: status.updatedAt.toISOString(),
  };
}

async function readJson(request) {
  const text = await request.text();
  return text ? JSON.parse(text) : {};
}

function parseParams(value) {
  if (value == null) return {};
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

function parsePositiveInt(raw, fallback) {
  if (raw == null) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 ? value : null;
}

// GET .../instances/{id}/step?step_name=<name>[&count=<n>] — the upstream
// step-output endpoint. Structured outputs come back inside the JSON
// envelope; persisted streams are served as application/octet-stream.
function stepOutputResponse(runtime, row, url) {
  const stepName = url.searchParams.get("step_name");
  if (!stepName) return fail(400, "step_name query parameter is required", 400);
  const countParam = url.searchParams.get("count");
  const count = countParam == null ? null : Number(countParam);
  if (count != null && (!Number.isInteger(count) || count < 1)) {
    return fail(400, "count must be a positive integer", 400);
  }
  const steps = runtime.storage
    .listSteps(row.id)
    .filter((step) => step.name === stepName)
    .filter((step) => count == null || step.count === count)
    .filter((step) => step.type === "do" || step.type === "waitForEvent");
  const step = steps.at(-1);
  if (!step) {
    return fail(404, `Step not found: ${stepName}`, 404);
  }
  let sensitive = false;
  try {
    sensitive = JSON.parse(step.config ?? "{}")?.sensitive === "output";
  } catch {}
  const body = {
    name: `${step.name}-${step.count}`,
    type: step.type,
    status: step.state,
    finished: step.state === "completed" || step.state === "failed",
    ...(step.event_type == null ? {} : { event_type: step.event_type }),
    error: step.error == null ? null : JSON.parse(step.error),
  };
  if (step.state !== "completed" || step.output == null) {
    return ok(body);
  }
  const envelope = JSON.parse(step.output);
  if (envelope?.kind === "stream") {
    if (sensitive) return ok({ ...body, output: "[REDACTED]" });
    const stream = runtime.storage.openStream(envelope.streamId);
    return new Response(stream, {
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(envelope.bytes ?? 0),
      },
    });
  }
  return ok({
    ...body,
    output: sensitive ? "[REDACTED]" : decodeDurableValue(step.output),
  });
}

// GET .../instances/{id}/subscribe — streaming transport for the same
// subscription feed exposed by WorkflowInstance.subscribe(). Events are
// delivered as Server-Sent Events with `id:` set to the durable eventId so a
// client can resume with ?cursor=<lastEventId>.
function subscribeResponse(runtime, row, url) {
  const cursor = url.searchParams.get("cursor");
  const filterParam = url.searchParams.get("filter");
  const options = {};
  if (cursor != null) {
    const parsed = Number(cursor);
    if (!Number.isInteger(parsed) || parsed < 0) {
      return fail(400, "cursor must be a non-negative integer", 400);
    }
    options.cursor = parsed;
  }
  if (filterParam != null) {
    options.filter = filterParam.split(",").filter(Boolean);
  }

  let subscription;
  let closed = false;
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async pull(controller) {
      if (closed) return;
      try {
        subscription ??= await runtime.subscribeInstance(row.id, row.public_id, options);
        const { value, done } = await subscription.next();
        if (done) {
          closed = true;
          controller.enqueue(encoder.encode("event: done\ndata: {}\n\n"));
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(
          `id: ${value.eventId}\nevent: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`,
        ));
      } catch (error) {
        closed = true;
        controller.enqueue(encoder.encode(
          `event: error\ndata: ${JSON.stringify({ message: error?.message ?? String(error) })}\n\n`,
        ));
        controller.close();
      }
    },
    cancel() {
      closed = true;
      subscription?.[Symbol.dispose]?.();
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

export async function handleWorkflowRest(runtime, request) {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  if (
    parts.length < 5 ||
    parts[0] !== "accounts" ||
    parts[2] !== "workflows"
  ) {
    return null;
  }

  const workflowName = decodeURIComponent(parts[3]);
  const workflow = runtime.workflowByName.get(workflowName);
  if (!workflow) {
    return fail(404, "Workflow not found", 404);
  }
  if (parts[4] !== "instances") return null;

  try {
    if (parts.length === 5) {
      if (request.method === "GET") {
        const status = url.searchParams.get("status");
        if (status != null && !INSTANCE_STATUSES.has(status)) {
          return fail(400, `Unknown instance status filter: ${status}`, 400);
        }
        const page = parsePositiveInt(url.searchParams.get("page"), 1);
        const perPage = parsePositiveInt(url.searchParams.get("per_page"), 50);
        if (page == null || perPage == null || perPage > 1000) {
          return fail(400, "Invalid pagination parameters", 400);
        }
        const { rows, total } = runtime.storage.listInstances(workflowName, {
          status,
          offset: (page - 1) * perPage,
          limit: perPage,
        });
        const instances = rows.map((row) =>
          statusBody(runtime, workflowName, row.public_id)
        );
        return ok(instances, {
          resultInfo: {
            count: instances.length,
            page,
            per_page: perPage,
            total_count: total,
          },
        });
      }
      if (request.method === "POST") {
        const body = await readJson(request);
        const instance = await runtime.createInstance(workflowName, {
          id: body.instance_id,
          params: parseParams(body.params),
          retention: body.instance_retention,
        });
        return ok({
          id: instance.id,
          status: runtime.instanceStatus(instance.id, workflowName).status,
          trigger_source: "api",
        });
      }
      return fail(405, "Method not allowed", 405);
    }

    const binding = runtime.env()[workflow.binding];

    if (parts.length === 6 && parts[5] === "batch" && request.method === "POST") {
      const body = await readJson(request);
      if (!Array.isArray(body) || body.length < 1 || body.length > 100) {
        return fail(400, "Batch body must contain 1..100 instances", 400);
      }
      const created = [];
      for (const item of body) {
        try {
          const instance = await runtime.createInstance(workflowName, {
            id: item.instance_id,
            params: parseParams(item.params),
            retention: item.instance_retention,
          });
          created.push({
            id: instance.id,
            status: runtime.instanceStatus(instance.id, workflowName).status,
            trigger_source: "api",
          });
        } catch (error) {
          if (error?.alreadyExists !== true) throw error;
        }
      }
      return ok(created, {
        resultInfo: {
          count: created.length,
          per_page: created.length,
          total_count: created.length,
        },
      });
    }

    const instanceId = decodeURIComponent(parts[5]);
    const row = runtime.requireInstance(instanceId, workflowName);
    const instance = await binding.get(instanceId);

    if (parts.length === 6) {
      if (request.method === "GET") {
        return ok(statusBody(runtime, workflowName, instanceId));
      }
      if (request.method === "DELETE") {
        await instance.delete();
        return new Response(null, { status: 204 });
      }
    }

    if (parts.length === 7 && parts[6] === "step" && request.method === "GET") {
      return stepOutputResponse(runtime, row, url);
    }

    if (parts.length === 7 && parts[6] === "subscribe" && request.method === "GET") {
      return subscribeResponse(runtime, row, url);
    }

    if (parts.length === 7 && parts[6] === "status" && request.method === "PATCH") {
      const body = await readJson(request);
      if (body.status === "pause") await instance.pause();
      else if (body.status === "resume") await instance.resume();
      else if (body.status === "terminate") {
        await instance.terminate({ rollback: Boolean(body.rollback) });
      } else if (body.status === "restart") {
        await instance.restart(body.from ? { from: body.from } : undefined);
      } else {
        return fail(400, "Unsupported workflow lifecycle status", 400);
      }
      const status = runtime.instanceStatus(instanceId, workflowName);
      return ok({
        status: status.status,
        timestamp: status.updatedAt.toISOString(),
      });
    }

    if (
      parts.length === 8 &&
      parts[6] === "events" &&
      request.method === "POST"
    ) {
      const eventType = decodeURIComponent(parts[7]);
      const body = await readJson(request);
      await instance.sendEvent({
        type: eventType,
        payload: body,
      });
      return ok({
        instanceId,
        timestamp: new Date().toISOString(),
      });
    }

    return fail(404, "Endpoint not found", 404);
  } catch (error) {
    const bindingMissing = error?.message === "instance.not_found";
    const message = bindingMissing
      ? `Workflow instance not found: ${decodeURIComponent(parts[5])}`
      : error?.message ?? String(error);
    const notFound = bindingMissing || message.includes("not found");
    return fail(
      notFound ? 404 : 400,
      message,
      notFound ? 404 : 400,
    );
  }
}
