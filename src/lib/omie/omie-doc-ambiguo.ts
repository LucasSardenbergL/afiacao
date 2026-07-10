// MIRROR-START omie doc-ambiguo — espelhado verbatim em supabase/functions/omie-analytics-sync/index.ts
// P1b (fail-closed money-path): documentos que aparecem em 2+ registros Omie com códigos de cliente
// DISTINTOS na MESMA conta são AMBÍGUOS — não provam identidade. Espelha o fail-closed do lado profile
// (fetchProfileDocUserMap: 2 users no mesmo doc → não mapeia). Sem isto, o último da paginação vencia por
// last-write-wins e gravava um código arbitrário na proof-table. Espelhado no edge (Deno não importa de
// src/); paridade textual no CI em src/__tests__/edge-money-path-invariants.test.ts.
export function docsComCodigoAmbiguoNoOmie(
  registros: ReadonlyArray<{ doc: string; codigo: number }>,
): Set<string> {
  const codigosPorDoc = new Map<string, Set<number>>();
  for (const r of registros) {
    if (!r.doc) continue; // doc vazio não vira chave (o boundary já filtra sem-doc)
    const s = codigosPorDoc.get(r.doc) ?? new Set<number>();
    s.add(r.codigo);
    codigosPorDoc.set(r.doc, s);
  }
  const ambiguos = new Set<string>();
  for (const [doc, cods] of codigosPorDoc) if (cods.size > 1) ambiguos.add(doc);
  return ambiguos;
}
// MIRROR-END
