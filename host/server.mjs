import { createServer } from "node:http";
import { handleWorkflowRest } from "./rest.mjs";

async function nodeRequest(req, host, port) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${host}:${port}`}`);
  return new Request(url, {
    method: req.method,
    headers: req.headers,
    body: ["GET", "HEAD"].includes(req.method ?? "GET") ? undefined : body,
  });
}

async function writeResponse(res, response) {
  const headers = Object.fromEntries(response.headers);
  res.writeHead(response.status, headers);
  if (response.body == null) {
    res.end();
    return;
  }
  res.end(Buffer.from(await response.arrayBuffer()));
}

export async function startWorkflowHttpServer(
  runtime,
  { host = "127.0.0.1", port = 8787 } = {},
) {
  const server = createServer(async (req, res) => {
    try {
      const request = await nodeRequest(req, host, port);
      const response =
        await handleWorkflowRest(runtime, request) ??
        await runtime.fetch(request);
      await writeResponse(res, response);
    } catch (error) {
      await writeResponse(
        res,
        Response.json(
          { error: { name: error?.name ?? "Error", message: error?.message ?? String(error) } },
          { status: 500 },
        ),
      );
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}
