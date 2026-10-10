// Object-overload evidence is candidate-gated by Workers types >= 5.20261002.1.
// Keep exact validation/errors; only random instance IDs are reduced to checks.
export async function runBatchCreateProbe(env: any) {
  const binding = env.ORACLE;
  const prefix = "batch-" + crypto.randomUUID();
  const out: Record<string, unknown> = {};
  const params = { probe: "batch-echo", value: 42 };
  const shape = (result: any, ids: string[] = []) => ({
    objectResult: !Array.isArray(result),
    createdCount: result.created.length,
    ids: result.created.map((item: any) => ids.includes(item.id) ? ids.indexOf(item.id) : "generated"),
    uniqueIds: new Set(result.created.map((item: any) => item.id)).size === result.created.length,
    generatedIdsValid: result.created.every((item: any) => ids.includes(item.id) || /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(item.id)),
    handles: result.created.every((item: any) => typeof item.status === "function"),
    errors: result.errors.map((error: any) => ({ ...error, id: ids.includes(error.id) ? ids.indexOf(error.id) : error.id })),
  });
  const capture = async (options: unknown) => {
    try {
      const result = await binding.createBatch(options);
      return { accepted: true, createdCount: result.created.length, errors: result.errors };
    } catch (error) {
      return { name: (error as Error).name, message: (error as Error).message };
    }
  };
  const payloads = async (instances: any[]) => {
    const result = [];
    for (const instance of instances) {
      const end = Date.now() + 15000;
      for (;;) {
        const status = await instance.status();
        if (status.status === "complete") { result.push(status.output); break; }
        if (status.status === "errored") throw new Error("Batch instance errored: " + JSON.stringify(status.error));
        if (Date.now() >= end) throw new Error("Batch instance did not complete");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    return result;
  };

  const counted = await binding.createBatch({ count: 2, params });
  out.count = shape(counted);
  out.countPayloads = await payloads(counted.created);
  const explicit = prefix + "-explicit";
  const listed = await binding.createBatch({ instances: [{ id: explicit, params }, { params }] });
  out.instances = shape(listed, [explicit]);
  out.instancePayloads = await payloads(listed.created);

  const fresh = prefix + "-fresh";
  const partial = await binding.createBatch({ instances: [
    { id: explicit, params }, { id: explicit, params }, { params },
    { id: fresh, params }, { id: fresh, params },
  ] });
  out.partial = shape(partial, [explicit, fresh]);
  out.partialPayloads = await payloads(partial.created);
  out.allExisting = shape(await binding.createBatch({ instances: [{ id: fresh, params }] }), [fresh]);

  out.retentionAndHint = await capture({ count: 1, params,
    retention: { successRetention: "1 day", errorRetention: 1000 }, locationHint: "apac-ne" });
  out.instanceRetentionAndHint = await capture({ instances: [{ params,
    retention: { successRetention: "1.5 seconds", errorRetention: "1 ms" }, locationHint: "weur" }] });

  const validation: Record<string, unknown> = {};
  const cases: Record<string, unknown> = {
    missing: {}, null: null, scalar: 1, zeroCount: { count: 0 }, negativeCount: { count: -1 },
    fractionCount: { count: 1.5 }, stringCount: { count: "1" }, countOverflow: { count: 101 },
    emptyInstances: { instances: [] }, instancesOverflow: { instances: Array.from({ length: 101 }, () => ({})) },
    invalidInstances: { instances: "bad" }, nullInstance: { instances: [null] },
    nullId: { instances: [{ id: null }] }, emptyId: { instances: [{ id: "" }] },
    longId: { instances: [{ id: "a".repeat(101) }] }, spacedId: { instances: [{ id: "bad id" }] },
    reservedId: { instances: [{ id: "batch" }] }, reservedHash: { instances: [{ id: "cf_" + "a".repeat(64) }] },
    zeroRetention: { count: 1, retention: { successRetention: 0 } },
    fractionalRetention: { count: 1, retention: { errorRetention: 1.5 } },
    invalidDuration: { count: 1, retention: { successRetention: "tomorrow" } },
    nullDuration: { count: 1, retention: { successRetention: null } },
    nullRetention: { count: 1, retention: null },
    invalidHint: { count: 1, locationHint: "moon" },
    multipleIssues: { instances: [{ id: null, retention: { successRetention: 0 }, locationHint: "moon" }] },
  };
  for (const [name, options] of Object.entries(cases)) validation[name] = await capture(options);
  out.validation = validation;
  const sentinel = prefix + "-sentinel";
  out.atomicValidation = await capture({ instances: [{ id: sentinel, params }, { id: "bad id", params }] });
  out.noPartialCreation = shape(await binding.createBatch({ instances: [{ id: sentinel, params }] }), [sentinel]);

  // Runtime precedence is observable even though TS excludes both branches.
  out.countPrecedence = await capture({ count: 1, params, instances: [{ id: "bad id" }] });
  const legacy = await binding.createBatch([{ id: prefix + "-legacy", params }, { params }, { id: prefix + "-legacy", params }]);
  out.legacy = { arrayResult: Array.isArray(legacy), createdCount: legacy.length, handles: legacy.every((item: any) => typeof item.status === "function") };
  return out;
}
