export type SnapshotSemana = { inicio: string; total_entradas: number; total_saidas: number; saldo_final: number; saldo_inicial: number | null };

export type SnapshotEmpresa = {
  company: string;
  snapshot_at: string;          // ISO 'YYYY-MM-DDThh:mm:ssZ'
  ncg: number | null;
  saldo_tesouraria: number | null;
  semanas: SnapshotSemana[];
};

export type SemanaConsolidada = {
  inicio: string;
  semana_label: string;          // "dd/mm" do inicio
  entradas_previstas: number;
  saidas_previstas: number;
  saldo_projetado: number;
  por_empresa: { company: string; saldo_final: number }[];
  completa: boolean;             // nº empresas com a semana === esperadas.length
};

export type CockpitConsolidado = {
  projecao13: SemanaConsolidada[];
  ncg_total: number;
  ncg_por_empresa: { company: string; ncg: number | null; presente: boolean }[];
  ncg_parcial: boolean;
  saldo_tesouraria_total: number;
  saldo_tesouraria_parcial: boolean;
  empresas_presentes: string[];  // coorte, na ordem de `esperadas`
  empresas_ausentes: string[];   // sem nenhum snapshot
  empresas_stale: string[];      // têm snapshot, mas data < data_referencia
  parcial: boolean;
  data_referencia: string | null;
  snapshot_at_mais_antigo: string | null;
  // Transparência: caixa inicial que a projeção consolidada usou (Σ saldo_inicial da semana de menor
  // inicio das empresas presentes). null se algum presente faltar. Comparar com saldo bancário atual.
  caixa_inicial_projecao: number | null;
  caixa_inicial_por_empresa: { company: string; saldo_inicial: number | null; presente: boolean }[];
  caixa_inicial_parcial: boolean;
};

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const dataDe = (snapshotAt: string): string => snapshotAt.slice(0, 10);

// Parse das semanas do snapshot (campo `dados` jsonb). Os 3 campos core gateiam a validade da
// semana (inválido → semana dropada); `saldo_inicial` é só-display → fora do filtro (NÃO dropa a
// semana), mas ausente/não-número vira `null` (NUNCA 0 — `Number(null)===0` seria fabricação).
export function parseSnapshotSemanas(dadosRaw: unknown): SnapshotSemana[] {
  if (!Array.isArray(dadosRaw)) return [];
  return (dadosRaw as Array<Record<string, unknown>>)
    .map((w) => ({
      inicio: w && typeof w.inicio === 'string' ? w.inicio : '',
      total_entradas: Number(w?.total_entradas),
      total_saidas: Number(w?.total_saidas),
      saldo_final: Number(w?.saldo_final),
      // jsonb retorna número; null/ausente/não-número → null (ausente ≠ 0).
      saldo_inicial: typeof w?.saldo_inicial === 'number' && Number.isFinite(w.saldo_inicial) ? w.saldo_inicial : null,
    }))
    .filter((w): w is SnapshotSemana =>
      w.inicio !== '' &&
      Number.isFinite(w.total_entradas) &&
      Number.isFinite(w.total_saidas) &&
      Number.isFinite(w.saldo_final));
}

export function consolidarCockpit(input: { esperadas: string[]; snapshots: SnapshotEmpresa[] }): CockpitConsolidado {
  const { esperadas, snapshots } = input;

  // 1. Dedupe por empresa: latest-wins por snapshot_at (não ordem do array).
  const dedup = new Map<string, SnapshotEmpresa>();
  for (const s of snapshots) {
    const atual = dedup.get(s.company);
    if (!atual || Date.parse(s.snapshot_at) > Date.parse(atual.snapshot_at)) {
      dedup.set(s.company, s);
    }
  }

  // 2. Coorte por DATA de referência: max(dataDe(snapshot_at)).
  let dataRef: string | null = null;
  for (const s of dedup.values()) {
    const d = dataDe(s.snapshot_at);
    if (dataRef === null || d > dataRef) dataRef = d;
  }

  // coorte = empresas cujo dataDe(snapshot_at) === dataRef
  const coorte = new Map<string, SnapshotEmpresa>();
  if (dataRef !== null) {
    for (const [company, s] of dedup) {
      if (dataDe(s.snapshot_at) === dataRef) coorte.set(company, s);
    }
  }

  // 3. Classificação na ordem de esperadas.
  const empresas_presentes = esperadas.filter((c) => coorte.has(c));
  const empresas_ausentes = esperadas.filter((c) => !dedup.has(c));
  const empresas_stale = esperadas.filter((c) => dedup.has(c) && !coorte.has(c));

  const parcial = empresas_ausentes.length + empresas_stale.length > 0;

  // 4. NCG.
  const ncg_por_empresa = esperadas.map((c) => {
    const s = coorte.get(c);
    return { company: c, ncg: s ? s.ncg : null, presente: !!s };
  });
  let ncgTotalRaw = 0;
  let algumNcgNull = false;
  for (const s of coorte.values()) {
    if (s.ncg != null) ncgTotalRaw += s.ncg;
    else algumNcgNull = true;
  }
  const ncg_total = round2(ncgTotalRaw);
  const ncg_parcial = parcial || algumNcgNull;

  // 5. Saldo tesouraria.
  let saldoTesRaw = 0;
  let algumSaldoNull = false;
  for (const s of coorte.values()) {
    if (s.saldo_tesouraria != null) saldoTesRaw += s.saldo_tesouraria;
    else algumSaldoNull = true;
  }
  const saldo_tesouraria_total = round2(saldoTesRaw);
  const saldo_tesouraria_parcial = parcial || algumSaldoNull;

  // 6. Projeção (só a coorte): união de inícios, ordenada asc, cap nas 13 primeiras.
  const iniciosSet = new Set<string>();
  for (const s of coorte.values()) {
    for (const w of s.semanas) iniciosSet.add(w.inicio);
  }
  const iniciosOrdenados = Array.from(iniciosSet).sort();
  const inicios13 = iniciosOrdenados.slice(0, 13);

  const projecao13: SemanaConsolidada[] = inicios13.map((inicio) => {
    let entradas = 0;
    let saidas = 0;
    let saldo = 0;
    const por_empresa: { company: string; saldo_final: number }[] = [];
    // percorre na ordem de esperadas para por_empresa determinístico
    for (const c of esperadas) {
      const s = coorte.get(c);
      if (!s) continue;
      const w = s.semanas.find((sw) => sw.inicio === inicio);
      if (!w) continue;
      entradas += w.total_entradas;
      saidas += w.total_saidas;
      saldo += w.saldo_final;
      por_empresa.push({ company: c, saldo_final: w.saldo_final });
    }
    return {
      inicio,
      semana_label: inicio.slice(8, 10) + '/' + inicio.slice(5, 7),
      entradas_previstas: round2(entradas),
      saidas_previstas: round2(saidas),
      saldo_projetado: round2(saldo),
      por_empresa,
      completa: por_empresa.length === esperadas.length,
    };
  });

  // 7. snapshot_at_mais_antigo da coorte.
  let snapshot_at_mais_antigo: string | null = null;
  for (const s of coorte.values()) {
    if (snapshot_at_mais_antigo === null || s.snapshot_at < snapshot_at_mais_antigo) {
      snapshot_at_mais_antigo = s.snapshot_at;
    }
  }

  // 8. Caixa inicial da projeção (transparência): saldo_inicial da semana de MENOR inicio COM
  // saldo_inicial válido de cada empresa presente (NÃO semanas[0] literal — robustez se a semana 0
  // foi filtrada). Σ; null se algum presente não tiver semana com saldo_inicial válido.
  const caixa_inicial_por_empresa = esperadas.map((c) => {
    const s = coorte.get(c);
    if (!s) return { company: c, saldo_inicial: null as number | null, presente: false };
    let melhor: { inicio: string; saldo_inicial: number } | null = null;
    for (const w of s.semanas) {
      if (w.saldo_inicial == null || !Number.isFinite(w.saldo_inicial)) continue;
      if (melhor == null || w.inicio < melhor.inicio) melhor = { inicio: w.inicio, saldo_inicial: w.saldo_inicial };
    }
    return { company: c, saldo_inicial: melhor ? melhor.saldo_inicial : null, presente: true };
  });
  let caixaIniRaw = 0;
  let algumCaixaIniNull = false;
  for (const e of caixa_inicial_por_empresa) {
    if (!e.presente) continue;
    if (e.saldo_inicial != null) caixaIniRaw += e.saldo_inicial;
    else algumCaixaIniNull = true;
  }
  const caixa_inicial_parcial = parcial || algumCaixaIniNull;
  // Coorte vazia (nenhum presente) → null, NÃO 0 (Codex P2: 0 seria caixa fabricado).
  const caixa_inicial_projecao = empresas_presentes.length === 0 || algumCaixaIniNull ? null : round2(caixaIniRaw);

  return {
    projecao13,
    ncg_total,
    ncg_por_empresa,
    ncg_parcial,
    saldo_tesouraria_total,
    saldo_tesouraria_parcial,
    empresas_presentes,
    empresas_ausentes,
    empresas_stale,
    parcial,
    data_referencia: dataRef,
    snapshot_at_mais_antigo,
    caixa_inicial_projecao,
    caixa_inicial_por_empresa,
    caixa_inicial_parcial,
  };
}

// Compara o caixa inicial que a projeção consolidada usou vs o saldo bancário atual (totalCC).
// Só quando a coorte é completa (caixa_inicial da coorte parcial × totalCC das 3 = maçã×laranja).
export function compararCaixaInicial(input: {
  caixaInicialProjecao: number | null;
  saldoAtualBanco: number;
  cohorteCompleta: boolean;
}): { disponivel: boolean; delta: number | null } {
  const disponivel = input.cohorteCompleta && input.caixaInicialProjecao != null;
  return { disponivel, delta: disponivel ? round2(input.saldoAtualBanco - (input.caixaInicialProjecao as number)) : null };
}
