export interface VisitaHojeRow {
  id: string;
  customer_user_id: string;
}

interface VisitaHojePreview {
  id: string;
  customer_user_id: string;
  nome: string;
}

export interface VisitasHojeResumo {
  total: number;
  preview: VisitaHojePreview[];
}

/**
 * Resumo do card "Visitas de hoje": total = todas as linhas (já filtradas por hoje),
 * preview = até `limit` enriquecidas com nome (fallback 'Cliente', espelha loadTodayVisits).
 * Puro, sem I/O.
 */
export function montarVisitasHoje(
  rows: VisitaHojeRow[],
  nomePorUsuario: Map<string, string>,
  limit = 3,
): VisitasHojeResumo {
  const preview = rows.slice(0, limit).map((r) => ({
    id: r.id,
    customer_user_id: r.customer_user_id,
    nome: nomePorUsuario.get(r.customer_user_id) || 'Cliente',
  }));
  return { total: rows.length, preview };
}
