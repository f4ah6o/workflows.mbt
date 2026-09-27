import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { handleWorkflowRest } from "./rest.mjs";

async function nodeRequest(req, host, port) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${host}:${port}`}`);
  const method = req.method ?? "GET";
  const streaming = !["GET", "HEAD"].includes(method);
  return new Request(url, {
    method,
    headers: req.headers,
    body: streaming ? Readable.toWeb(req) : undefined,
    duplex: streaming ? "half" : undefined,
  });
}

async function writeResponse(res, response) {
  const headers = Object.create(null);
  for (const [name, value] of response.headers) {
    if (name.toLowerCase() === "set-cookie") continue;
    headers[name] = value;
  }
  const setCookies = response.headers.getSetCookie();
  if (setCookies.length) headers["set-cookie"] = setCookies;
  res.writeHead(response.status, headers);
  if (response.body == null) {
    res.end();
    return;
  }
  await pipeline(Readable.fromWeb(response.body), res);
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
      if (res.headersSent) {
        res.destroy(error);
        return;
      }
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
