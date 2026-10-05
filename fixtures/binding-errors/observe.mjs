function errorShape(error) {
  return {
    name: error.name,
    message: error.message,
    code: error.code ?? null,
    alreadyExists: error.alreadyExists ?? null,
  };
}

// get() may return a lazy handle: status() must also be observed.
export async function observeMissing(binding, id) {
  try {
    const instance = await binding.get(id);
    await instance.status();
    return { rejected: false };
  } catch (error) {
    return { rejected: true, error: errorShape(error) };
  }
}

export async function observeDuplicate(binding, id, contenders) {
  // Establish existence first: atomicity of simultaneous first creates is a
  // separate contract from the shape of a duplicate-create rejection.
  const winner = await binding.create({ id, params: {} });
  const settled = await Promise.allSettled(
    Array.from({ length: contenders - 1 }, () => binding.create({ id, params: {} })),
  );
  return {
    successes: 1 + settled.filter((result) => result.status === "fulfilled").length,
    errors: settled.filter((result) => result.status === "rejected")
      .map((result) => errorShape(result.reason)),
    winnerId: winner.id,
  };
}
