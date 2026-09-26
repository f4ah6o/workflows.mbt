import { AsyncLocalStorage } from "node:async_hooks";

export class WorkflowInstanceDeletedExecution extends Error {
  constructor(instanceStorageId) {
    super(`Workflow instance deleted during execution: ${instanceStorageId}`);
    this.name = "WorkflowInstanceDeletedExecution";
    this.instanceStorageId = instanceStorageId;
  }
}

export const workflowExecutionScope = new AsyncLocalStorage();
