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
  // CNPJ alfanumérico (letra PRESERVADA pelo normalizarDocumento) cuja mutilação só-dígitos é o doc de
  // OUTRO registro Omie: o snapshot SQL (doc_to_user) ainda chaveia o profile pelo só-dígitos, então o
  // registro numérico casaria com o profile do alfanumérico (Codex ALTO, 2026-10-19). Antes da
  // preservação os dois tinham a MESMA chave mutilada e caíam no ramo acima — mantém o fail-closed.
  for (const doc of codigosPorDoc.keys()) {
    if (!/[A-Z]/.test(doc)) continue;
    const mutilado = doc.replace(/\D/g, "");
    if (mutilado && codigosPorDoc.has(mutilado)) ambiguos.add(mutilado);
  }
  return ambiguos;
}
// MIRROR-END
