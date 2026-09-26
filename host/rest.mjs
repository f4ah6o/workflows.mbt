function json(value, init = {}) {
  return Response.json(value, init);
}

function statusBody(runtime, id) {
  const status = runtime.instanceStatus(id);
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
    return json({ errors: [{ code: 404, message: "Workflow not found" }] }, { status: 404 });
  }
  if (parts[4] !== "instances") return null;

  try {
    if (parts.length === 5) {
      if (request.method === "GET") {
        const instances = runtime.storage.listInstances(workflowName).map((row) =>
          statusBody(runtime, row.id)
        );
        return json({ result: instances });
      }
      if (request.method === "POST") {
        const body = await readJson(request);
        const instance = await runtime.createInstance(workflowName, {
          id: body.instance_id,
          params: parseParams(body.params),
          retention: body.instance_retention,
        });
        return json({ result: statusBody(runtime, instance.id) }, { status: 201 });
      }
      return json({ errors: [{ code: 405, message: "Method not allowed" }] }, { status: 405 });
    }

    const instanceId = decodeURIComponent(parts[5]);
    const binding = runtime.env()[workflow.binding];
    const instance = await binding.get(instanceId);

    if (parts.length === 6) {
      if (request.method === "GET") {
        return json({ result: statusBody(runtime, instanceId) });
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
        return json(
          { errors: [{ code: 400, message: "Unsupported workflow lifecycle status" }] },
          { status: 400 },
        );
      }
      return json({ result: statusBody(runtime, instanceId) });
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
      return json({ result: { id: instanceId, accepted: true } }, { status: 202 });
    }

    return json({ errors: [{ code: 404, message: "Endpoint not found" }] }, { status: 404 });
  } catch (error) {
    const notFound = String(error?.message).includes("not found");
    return json(
      {
        errors: [{
          code: notFound ? 404 : 400,
          message: error?.message ?? String(error),
        }],
      },
      { status: notFound ? 404 : 400 },
    );
  }
}
