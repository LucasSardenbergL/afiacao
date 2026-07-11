// MIRROR-START computeVolumeOk
// Circuit-breaker de cobertura do run completo. baseline = mediana dos últimos completos; volumeOk =
// idsDistintos >= k*baseline. Sem baseline confiável (< minHistorico) → null (desconhecido, NUNCA true).
export function computeVolumeOk(
  idsDistintos: number,
  historico: number[],
  opts?: { k?: number; minHistorico?: number },
): { baseline: number | null; volumeOk: boolean | null } {
  const k = opts?.k ?? 0.9;
  const minHistorico = opts?.minHistorico ?? 3;
  const validos = historico.filter((n) => Number.isFinite(n) && n >= 0);
  if (validos.length < minHistorico) return { baseline: null, volumeOk: null };
  const ord = [...validos].sort((a, b) => a - b);
  const mid = Math.floor(ord.length / 2);
  const baseline = ord.length % 2 ? ord[mid] : Math.round((ord[mid - 1] + ord[mid]) / 2);
  const volumeOk = idsDistintos >= k * baseline;
  return { baseline, volumeOk };
}
// MIRROR-END computeVolumeOk
