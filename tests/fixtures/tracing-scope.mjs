// The same function runs against the Node host and an actual cf dev Workflow.
// Keep the observations explicit: no normalization or oracle-specific branches.
export async function observeTracingScope(tracing) {
  const root = tracing.getActiveSpan();
  const result = {
    ambientPresent: root !== undefined,
    ambientStable: root === tracing.getActiveSpan(),
    detachedPreservesActive: false,
    methods: {},
  };
  const detached = tracing.startSpan("detached");
  result.detachedPreservesActive = tracing.getActiveSpan() === root && detached !== root;
  for (const method of ["enterSpan", "startActiveSpan"]) {
    const scope = {};
    scope.syncReturn = tracing[method]("sync", (span, a, b) => {
      scope.syncActive = tracing.getActiveSpan() === span;
      return a + b;
    }, 3, 4);
    scope.afterSync = tracing.getActiveSpan() === root;
    scope.asyncReturn = await tracing[method]("outer", async (span) => {
      scope.distinctFromRoot = span !== root;
      scope.beforeAwait = tracing.getActiveSpan() === span;
      await Promise.resolve();
      scope.afterAwait = tracing.getActiveSpan() === span;
      scope.nested = await tracing.enterSpan("inner", async (inner) => {
        await Promise.resolve();
        return tracing.getActiveSpan() === inner && inner !== span;
      });
      scope.afterNested = tracing.getActiveSpan() === span;
      return "returned";
    });
    scope.afterAsync = tracing.getActiveSpan() === root;
    const thrown = new Error("sync failure");
    try {
      tracing[method]("throws", () => { throw thrown; });
    } catch (error) {
      scope.sameThrownError = error === thrown;
    }
    scope.afterThrow = tracing.getActiveSpan() === root;
    const rejected = new Error("async failure");
    try {
      await tracing[method]("rejects", async () => {
        await Promise.resolve();
        throw rejected;
      });
    } catch (error) {
      scope.sameRejectedError = error === rejected;
    }
    scope.afterRejection = tracing.getActiveSpan() === root;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const first = tracing[method]("concurrent-a", async (span) => {
      await gate;
      return tracing.getActiveSpan() === span;
    });
    const second = tracing[method]("concurrent-b", async (span) => {
      release();
      await Promise.resolve();
      return tracing.getActiveSpan() === span;
    });
    scope.concurrent = await Promise.all([first, second]);
    scope.afterConcurrent = tracing.getActiveSpan() === root;
    result.methods[method] = scope;
  }
  result.afterAll = tracing.getActiveSpan() === root;
  return result;
}
