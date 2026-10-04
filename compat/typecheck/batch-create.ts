// Unchanged Cloudflare call shapes, checked against the local binding types.
import type {
  Workflow,
  WorkflowBatchCreateOptions,
  WorkflowBatchCreateResult,
  WorkflowInstance,
  WorkflowInstanceLocationHint,
} from "../cloudflare-workers/types";

type Params = { value: number };
export async function batchCreateTypes(binding: Workflow<Params>) {
  const hint: WorkflowInstanceLocationHint = "apac-ne";
  const options: WorkflowBatchCreateOptions<Params> = {
    count: 2,
    params: { value: 42 },
    retention: { successRetention: "1 day", errorRetention: 1000 },
    locationHint: hint,
  };
  const counted: WorkflowBatchCreateResult = await binding.createBatch(options);
  const listed: WorkflowBatchCreateResult = await binding.createBatch({
    instances: [
      {},
      { params: { value: 7 }, locationHint: "weur" },
      { id: "explicit", params: { value: 8 } },
    ],
  });
  const legacy: WorkflowInstance[] = await binding.createBatch([
    {}, { id: "legacy" }, { params: { value: 9 } },
  ]);
  for (const error of listed.errors) {
    const index: number = error.index;
    const id: string | undefined = error.id;
    const code: number = error.code;
    const message: string = error.message;
    void [index, id, code, message];
  }
  await counted.created[0].status();
  await legacy[0].status();

  // @ts-expect-error Count and explicit instances are mutually exclusive.
  await binding.createBatch({ count: 2, instances: [] });
  // @ts-expect-error Shared params belong only to the count form.
  await binding.createBatch({ instances: [], params: { value: 1 } });
  // @ts-expect-error Location hints are the documented closed set.
  await binding.createBatch({ count: 1, locationHint: "moon" });
  // @ts-expect-error Workflow parameter type is preserved.
  await binding.createBatch({ instances: [{ params: { value: "bad" } }] });
}
