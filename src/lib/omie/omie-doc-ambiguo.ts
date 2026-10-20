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
  // SEM laço de "mutilação" (existiu entre o #3180 e o #3195, 2026-10-19): um CNPJ alfanumérico e o
  // numérico que é a sua mutilação só-dígitos são chaves DISTINTAS de donos distintos desde a migration
  // 20261019140000 — `omie_sync_identity_snapshot` chaveia o profile por `normalizar_documento()`,
  // letras preservadas. Marcar o numérico como ambíguo tirava o vínculo do dono CERTO (perdia
  // precisão, não só recall). Mutilação não é ambiguidade: o snapshot preserva letras.
  return ambiguos;
}
// MIRROR-END
