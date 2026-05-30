export type SnapshotSemana = { inicio: string; total_entradas: number; total_saidas: number; saldo_final: number };

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
};

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const dataDe = (snapshotAt: string): string => snapshotAt.slice(0, 10);

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
  };
}
