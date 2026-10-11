// Versioned local behavior for the actually resolved upstream candidate.
// Unknown candidates keep the pinned default so new drift stays observable.
export function tracingScopeFor(candidate) {
  return ["1.62.4", "1.62.5", "1.63.1"].includes(candidate?.versions?.vitePlugin)
    ? "invocation" : "callback";
}

export function probeApplies(probe, candidate) {
  if (probe.differential === false) return false;
  if (!probe.minimumWorkersTypes) return true;
  // Without candidate evidence, require all probes (never silently weaken a
  // validator or claim that a new API is unavailable).
  if (!candidate?.versions?.workersTypes) return true;
  const parse = (value) => {
    if (!/^\d+\.\d+\.\d+$/.test(value)) throw new Error("Invalid workers-types version: " + value);
    return value.split(".").map(Number);
  };
  const actual = parse(candidate.versions.workersTypes);
  const minimum = parse(probe.minimumWorkersTypes);
  for (let i = 0; i < 3; i += 1) {
    if (actual[i] !== minimum[i]) return actual[i] > minimum[i];
  }
  return true;
}

export function differentialProbes(catalog, candidate) {
  return catalog.probes.filter((probe) => probeApplies(probe, candidate)).map((probe) => probe.id);
}
