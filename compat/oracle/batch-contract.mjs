// Batch object overloads were added after the pinned oracle. Track their
// entire declarations (including every union arm), without promoting the
// pinned contract or claiming runtime support from types alone.
import ts from "typescript";

export const batchCreateTypes = ["WorkflowBatchCreateOptions", "WorkflowBatchCreateResult"];

export function extractBatchDeclarations(text) {
  const source = ts.createSourceFile("workers-types.d.ts", text, ts.ScriptTarget.Latest, true);
  return Object.fromEntries(source.statements
    .filter((node) => ts.isTypeAliasDeclaration(node) && batchCreateTypes.includes(node.name.text))
    .map((node) => [node.name.text, node.getText(source)]));
}
