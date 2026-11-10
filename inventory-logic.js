// Inventory-count classification (no Firebase). Unit tested.
//
// "Expected in the drawer" = in service and not checked out to anyone.
// Devices that are out with staff are NOT expected, so they never show as missing.

export const expectedIn = (assets, scope = "") =>
  assets.filter((a) => a.active && a.status !== "out" && (!scope || a.category === scope)).map((a) => a.id).sort(nat);

function nat(a, b) { return String(a).localeCompare(String(b), undefined, { numeric: true }); }

/** What does one scanned code mean right now? */
export function classifyScan(code, assetsById, scope = "") {
  const a = assetsById.get(code);
  if (!a) return { kind: "unknown", code };
  if (!a.active) return { kind: "outOfService", asset: a };
  if (a.status === "out") return { kind: "outButPresent", asset: a };
  if (scope && a.category !== scope) return { kind: "outOfScope", asset: a };
  return { kind: "found", asset: a };
}

export function summarizeCount({ assets, scanned, unknown = [], scope = "" }) {
  const byId = new Map(assets.map((a) => [a.id, a]));
  const seen = [...new Set(scanned)];
  const expected = expectedIn(assets, scope);
  const res = { scope, expected, found: [], missing: [], outButPresent: [], outOfService: [], outOfScope: [], unknown: [...new Set(unknown)] };
  for (const id of seen) {
    const k = classifyScan(id, byId, scope);
    if (k.kind === "found") res.found.push(id);
    else if (k.kind === "outButPresent") res.outButPresent.push(id);
    else if (k.kind === "outOfService") res.outOfService.push(id);
    else if (k.kind === "outOfScope") res.outOfScope.push(id);
  }
  const got = new Set(res.found);
  res.missing = expected.filter((id) => !got.has(id));
  for (const k of ["found", "outButPresent", "outOfService", "outOfScope"]) res[k].sort(nat);
  return res;
}
