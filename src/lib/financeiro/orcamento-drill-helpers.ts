/**
 * Helper puro do "drill de variância por categoria" do Forecast de aterrissagem.
 *
 * Ao clicar numa linha de DRE que furou a meta, decompõe o realizado YTD daquela
 * linha pelas categorias do Omie (de onde o dinheiro veio), com delta vs o mesmo
 * período do ano anterior e uma reconciliação honesta contra o realizado contábil
 * (snapshot do DRE).
 *
 * Fato de domínio crítico (espelha o `montarDRE` do projeto): o snapshot agrega
 * sublinhas fiscais. A linha `deducoes` soma categorias mapeadas para deducoes,
 * ded_icms/iss/pis/cofins/ipi, das E o valor legado `impostos` (que normaliza para
 * deduções em ambos os regimes). A linha `impostos` do snapshot é 0 no Simples (o
 * DAS está em deducoes) e irpj+csll no Presumido. Por isso o drill usa um conjunto
 * de ALIASES por linha, regime-aware — senão as categorias fiscais somem do
 * decomposto e viram um resíduo gigante na reconciliação.
 *
 * Módulo leaf: funções puras, sem React, sem Supabase, sem imports do projeto.
 */

export type DimRowRaw = {
  categoria_codigo: string | null;
  categoria_descricao: string | null;
  mes: number | null;
  valor: number; // total_documento da view (CR ou CP)
};

type DrillComponente = {
  categoria_codigo: string;
  categoria_descricao: string; // label mais recente no período (ano atual), fallback ano-1, fallback código
  realizado_ytd: number;
  realizado_ytd_ano_anterior: number;
  delta: number; // realizado_ytd − realizado_ytd_ano_anterior
  delta_perc: number | null; // null se |ano_anterior| < EPSILON; senão (ano−ant)/abs(ant)
  peso_perc: number; // realizado_ytd / total_decomposto (0 se total ~0)
};

type DrillQualidade = 'ok' | 'parcial' | 'diagnostico';

export type DrillResult = {
  dre_linha: string;
  fontes: ('cr' | 'cp')[];
  meses_fechados: number[];
  componentes: DrillComponente[]; // ordenado por |realizado_ytd| desc
  total_decomposto: number;
  realizado_snapshot: number;
  residuo: number;
  residuo_perc: number | null;
  qualidade: DrillQualidade;
  forecast_nao_decomposto: number;
  variancia_anual: number | null;
};

const EPSILON_MONETARIO = 0.01;

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

const LINHAS_CR = new Set(['receita_bruta', 'receitas_financeiras', 'outras_receitas']);
const LINHAS_CP = new Set([
  'cmv',
  'despesas_operacionais',
  'despesas_administrativas',
  'despesas_comerciais',
  'despesas_financeiras',
  'outras_despesas',
  'impostos',
]);

const ALIASES_DEDUCOES = [
  'deducoes',
  'ded_icms',
  'ded_iss',
  'ded_pis',
  'ded_cofins',
  'ded_ipi',
  'das',
  'impostos',
];

export function fontesDaLinha(dreLinha: string): ('cr' | 'cp')[] {
  if (LINHAS_CR.has(dreLinha)) return ['cr'];
  if (dreLinha === 'deducoes') return ['cr', 'cp'];
  if (LINHAS_CP.has(dreLinha)) return ['cp'];
  return [];
}

export function aliasesDaLinha(dreLinha: string, regime: 'simples' | 'presumido'): string[] {
  if (dreLinha === 'deducoes') return [...ALIASES_DEDUCOES];
  if (dreLinha === 'impostos') return regime === 'simples' ? [] : ['irpj', 'csll'];
  return [dreLinha];
}

/**
 * Resolve quais códigos Omie pertencem a uma linha de DRE, regime-aware.
 *
 * Mapping ORDER-INDEPENDENT: processa `company === '_default'` primeiro, depois
 * `company !== '_default'` (estas sobrescrevem). Filtra os códigos cuja linha
 * resolvida ∈ aliases da linha. Deduplicado por construção (Map por código).
 *
 * Reusado pelo drill (v1) e pela concentração por entidade (v2).
 */
export function codigosDaLinha(
  mapping: { omie_codigo: string; dre_linha: string; company: string }[],
  dreLinha: string,
  regime: 'simples' | 'presumido',
): string[] {
  const aliases = new Set(aliasesDaLinha(dreLinha, regime));
  const codToLinha = new Map<string, string>();
  for (const m of mapping) if (m.company === '_default') codToLinha.set(m.omie_codigo, m.dre_linha);
  for (const m of mapping) if (m.company !== '_default') codToLinha.set(m.omie_codigo, m.dre_linha);
  const out: string[] = [];
  for (const [cod, linha] of codToLinha) if (aliases.has(linha)) out.push(cod);
  return out; // deduplicado por construção (Map por código)
}

type AggEntry = { soma: number; descMaxMes: string | null; maxMes: number };

function agg(
  rows: DimRowRaw[],
  fechadosSet: Set<number>,
  codigosAlvo: Set<string>,
): Map<string, AggEntry> {
  const out = new Map<string, AggEntry>();
  for (const r of rows) {
    if (r.mes == null || !fechadosSet.has(r.mes)) continue;
    if (r.categoria_codigo == null || !codigosAlvo.has(r.categoria_codigo)) continue;
    const cod = r.categoria_codigo;
    const prev = out.get(cod);
    if (!prev) {
      out.set(cod, { soma: r.valor, descMaxMes: r.categoria_descricao, maxMes: r.mes });
    } else {
      prev.soma += r.valor;
      if (r.mes >= prev.maxMes) {
        prev.maxMes = r.mes;
        prev.descMaxMes = r.categoria_descricao;
      }
    }
  }
  return out;
}

export function drillLinha(input: {
  dreLinha: string;
  regime: 'simples' | 'presumido';
  rowsAno: DimRowRaw[];
  rowsAnoAnterior: DimRowRaw[];
  mesesFechados: number[];
  mapping: { omie_codigo: string; dre_linha: string; company: string }[];
  realizadoSnapshot: number;
  forecastRestante: number;
  varianciaAnual: number | null;
  limiteResiduoAbs?: number; // default 10000
  limiteResiduoPercOk?: number; // default 0.05
  limiteResiduoPercDiag?: number; // default 0.20
}): DrillResult {
  const {
    dreLinha,
    regime,
    rowsAno,
    rowsAnoAnterior,
    mesesFechados,
    mapping,
    realizadoSnapshot,
    forecastRestante,
    varianciaAnual,
  } = input;
  const limiteResiduoAbs = input.limiteResiduoAbs ?? 10000;
  const limiteResiduoPercOk = input.limiteResiduoPercOk ?? 0.05;
  const limiteResiduoPercDiag = input.limiteResiduoPercDiag ?? 0.2;

  const fontes = fontesDaLinha(dreLinha);

  // Reconciliação de qualidade compartilhada entre o caminho derivado e o normal.
  const computarQualidade = (somaBruta: number, residuo: number): { residuoPerc: number | null; qualidade: DrillQualidade } => {
    if (Math.abs(realizadoSnapshot) < EPSILON_MONETARIO) {
      return {
        residuoPerc: null,
        qualidade: Math.abs(somaBruta) < EPSILON_MONETARIO ? 'ok' : 'diagnostico',
      };
    }
    const residuoPerc = Math.abs(residuo) / Math.abs(realizadoSnapshot);
    let qualidade: DrillQualidade;
    if (residuoPerc <= limiteResiduoPercOk && Math.abs(residuo) <= limiteResiduoAbs) {
      qualidade = 'ok';
    } else if (residuoPerc > limiteResiduoPercDiag) {
      qualidade = 'diagnostico';
    } else {
      qualidade = 'parcial';
    }
    return { residuoPerc, qualidade };
  };

  // Caminho defensivo para linhas derivadas (sem fonte de categoria).
  if (fontes.length === 0) {
    const residuo = round2(realizadoSnapshot);
    const { residuoPerc, qualidade } = computarQualidade(0, residuo);
    return {
      dre_linha: dreLinha,
      fontes: [],
      meses_fechados: mesesFechados,
      componentes: [],
      total_decomposto: 0,
      realizado_snapshot: realizadoSnapshot,
      residuo,
      residuo_perc: residuoPerc,
      qualidade,
      forecast_nao_decomposto: forecastRestante,
      variancia_anual: varianciaAnual,
    };
  }

  const codigosAlvo = new Set(codigosDaLinha(mapping, dreLinha, regime));

  const fechadosSet = new Set(mesesFechados);
  const aggAno = agg(rowsAno, fechadosSet, codigosAlvo);
  const aggAnt = agg(rowsAnoAnterior, fechadosSet, codigosAlvo);

  let somaBrutaAno = 0;
  for (const e of aggAno.values()) somaBrutaAno += e.soma;

  const total_decomposto = round2(somaBrutaAno);
  const residuo = round2(realizadoSnapshot - somaBrutaAno);

  const componentes: DrillComponente[] = [];
  const codigos = new Set<string>([...aggAno.keys(), ...aggAnt.keys()]);
  for (const cod of codigos) {
    const eAno = aggAno.get(cod);
    const eAnt = aggAnt.get(cod);
    const ano = eAno?.soma ?? 0;
    const ant = eAnt?.soma ?? 0;
    const categoria_descricao = eAno?.descMaxMes ?? eAnt?.descMaxMes ?? cod;
    componentes.push({
      categoria_codigo: cod,
      categoria_descricao,
      realizado_ytd: round2(ano),
      realizado_ytd_ano_anterior: round2(ant),
      delta: round2(ano - ant),
      delta_perc: Math.abs(ant) < EPSILON_MONETARIO ? null : (ano - ant) / Math.abs(ant),
      peso_perc: Math.abs(somaBrutaAno) < EPSILON_MONETARIO ? 0 : ano / somaBrutaAno,
    });
  }

  componentes.sort((a, b) => Math.abs(b.realizado_ytd) - Math.abs(a.realizado_ytd));

  const { residuoPerc, qualidade } = computarQualidade(somaBrutaAno, residuo);

  return {
    dre_linha: dreLinha,
    fontes,
    meses_fechados: mesesFechados,
    componentes,
    total_decomposto,
    realizado_snapshot: realizadoSnapshot,
    residuo,
    residuo_perc: residuoPerc,
    qualidade,
    forecast_nao_decomposto: forecastRestante,
    variancia_anual: varianciaAnual,
  };
}
