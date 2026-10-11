import assert from "node:assert/strict";
import test from "node:test";
import { extractBatchDeclarations } from "../compat/oracle/batch-contract.mjs";

test("batch extraction includes every option union arm and nested result field", () => {
  const text = `type WorkflowBatchCreateOptions<P = unknown> =
    | { count: number; params?: P; instances?: never }
    | { instances: { id?: string; params?: P }[]; count?: never };
    type WorkflowBatchCreateResult = { created: WorkflowInstance[];
      errors: { index: number; id?: string; code: number; message: string }[] };
    type Unrelated = { ignored: true };`;
  const declarations = extractBatchDeclarations(text);
  assert.deepEqual(Object.keys(declarations), ["WorkflowBatchCreateOptions", "WorkflowBatchCreateResult"]);
  assert.match(declarations.WorkflowBatchCreateOptions, /count\?: never/);
  assert.match(declarations.WorkflowBatchCreateResult, /message: string/);
  const changed = extractBatchDeclarations(text.replace("count?: never", "count?: number"));
  assert.notEqual(changed.WorkflowBatchCreateOptions, declarations.WorkflowBatchCreateOptions);
});

test("pre-overload pinned types produce no batch declaration claims", () => {
  assert.deepEqual(extractBatchDeclarations("declare abstract class Workflow {}"), {});
});
