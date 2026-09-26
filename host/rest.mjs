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
        const instances = runtime.storage.listInstances(workflowName).map((row) =>
          statusBody(runtime, workflowName, row.public_id)
        );
        return ok(instances, {
          resultInfo: {
            count: instances.length,
            per_page: instances.length,
            total_count: instances.length,
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
          if (error?.name !== "WorkflowInstanceAlreadyExistsError") throw error;
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
        payload: body.payload ?? body,
      });
      return ok({
        instanceId,
        timestamp: new Date().toISOString(),
      });
    }

    return fail(404, "Endpoint not found", 404);
  } catch (error) {
    const notFound = String(error?.message).includes("not found");
    return fail(
      notFound ? 404 : 400,
      error?.message ?? String(error),
      notFound ? 404 : 400,
    );
  }
}
