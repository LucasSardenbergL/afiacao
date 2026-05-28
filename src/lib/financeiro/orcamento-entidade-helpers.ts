/**
 * Helper puro da "concentração por entidade" do drill de variância (v2).
 *
 * Ao drilar uma linha de DRE que furou a meta, além de decompor por categoria do
 * Omie (v1, `orcamento-drill-helpers`), respondemos "QUEM" puxou o valor: por
 * fornecedor (linhas de despesa, fonte CP) ou por cliente (linhas de receita,
 * fonte CR). Agrega títulos por identidade (CNPJ/CPF, fallback nome normalizado),
 * compara YTD vs ano-1 e produz dois Paretos honestos: concentração de NÍVEL
 * (quem representa o estoque atual) e de AUMENTO (quem puxou a alta vs ano-1).
 *
 * Módulo leaf: funções puras, sem React, sem Supabase, sem imports do projeto.
 */

export type EntidadeRowRaw = {
  entidade_id: string | null;
  entidade_nome: string | null;
  mes: number | null;
  valor: number;
};

export type EntidadeClasse = 'novo' | 'sumiu' | 'recorrente';

export type EntidadeComponente = {
  entidade_chave: string;
  entidade_label: string;
  sem_id: boolean;
  realizado_ytd: number;
  realizado_ytd_ano_anterior: number;
  delta: number;
  delta_perc: number | null;
  peso_perc: number;
  classe: EntidadeClasse;
};

export type EntidadeConcentracaoResult = {
  componentes: EntidadeComponente[];
  total_ano: number;
  total_ano_anterior: number;
  aumento_bruto: number;
  top_n: number;
  top_n_peso_nivel_perc: number;
  top_n_peso_aumento_perc: number | null;
  sem_aumento_bruto: boolean;
  truncado: boolean;
};

export const EPSILON_MONETARIO = 0.01;

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

const LINHAS_CP = new Set([
  'cmv',
  'despesas_operacionais',
  'despesas_administrativas',
  'despesas_comerciais',
  'despesas_financeiras',
  'outras_despesas',
]);
const LINHAS_CR = new Set(['receita_bruta', 'receitas_financeiras', 'outras_receitas']);

export function entidadeDaLinha(
  dreLinha: string,
):
  | { fonte: 'cp'; rotulo: 'fornecedor' }
  | { fonte: 'cr'; rotulo: 'cliente' }
  | null {
  if (LINHAS_CP.has(dreLinha)) return { fonte: 'cp', rotulo: 'fornecedor' };
  if (LINHAS_CR.has(dreLinha)) return { fonte: 'cr', rotulo: 'cliente' };
  return null;
}

export function parseMesDataEmissao(d: string | null): number | null {
  if (d == null) return null;
  const m = /^\d{4}-(\d{2})-\d{2}/.exec(d);
  if (!m) return null;
  return Number(m[1]);
}

/** Retorna o documento limpo (só dígitos) se for CPF (11) ou CNPJ (14) válido; senão null. */
function cnpjValido(s: string | null): string | null {
  const dig = (s ?? '').replace(/\D/g, '');
  if (dig.length !== 11 && dig.length !== 14) return null;
  // rejeita sentinelas todos-iguais (ex.: 00000000000000)
  if (/^(\d)\1+$/.test(dig)) return null;
  return dig;
}

function normalizarNome(n: string | null): string {
  return (n ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
}

function chaveIdentidade(
  id: string | null,
  nome: string | null,
): { chave: string; sem_id: boolean } {
  const cnpj = cnpjValido(id);
  if (cnpj) return { chave: cnpj, sem_id: false };
  const nn = normalizarNome(nome);
  if (nn) return { chave: nn, sem_id: true };
  return { chave: 'sem_identificacao', sem_id: true };
}

type EntidadeAgg = { soma: number; label: string | null; sem_id: boolean };

function agg(rows: EntidadeRowRaw[], fechados: Set<number>): Map<string, EntidadeAgg> {
  const out = new Map<string, EntidadeAgg>();
  for (const row of rows) {
    if (row.mes == null || !fechados.has(row.mes)) continue;
    const { chave, sem_id } = chaveIdentidade(row.entidade_id, row.entidade_nome);
    const prev = out.get(chave);
    if (!prev) {
      out.set(chave, {
        soma: row.valor,
        label: row.entidade_nome && row.entidade_nome.trim() ? row.entidade_nome : null,
        sem_id,
      });
    } else {
      prev.soma += row.valor;
      // label = primeiro nome não-vazio visto
      if (prev.label == null && row.entidade_nome && row.entidade_nome.trim()) {
        prev.label = row.entidade_nome;
      }
    }
  }
  return out;
}

export function concentrarPorEntidade(input: {
  rowsAno: EntidadeRowRaw[];
  rowsAnoAnterior: EntidadeRowRaw[];
  mesesFechados: number[];
  topN?: number;
  truncado?: boolean;
}): EntidadeConcentracaoResult {
  const fechados = new Set(input.mesesFechados);
  const aggAno = agg(input.rowsAno, fechados);
  const aggAnt = agg(input.rowsAnoAnterior, fechados);

  let totalAnoBruto = 0;
  for (const e of aggAno.values()) totalAnoBruto += e.soma;
  let totalAntBruto = 0;
  for (const e of aggAnt.values()) totalAntBruto += e.soma;

  const chaves = new Set<string>([...aggAno.keys(), ...aggAnt.keys()]);
  const componentes: EntidadeComponente[] = [];
  for (const k of chaves) {
    const eAno = aggAno.get(k);
    const eAnt = aggAnt.get(k);
    const ano = eAno?.soma ?? 0;
    const ant = eAnt?.soma ?? 0;
    const entidade_label = eAno?.label ?? eAnt?.label ?? k;
    const sem_id = (eAno ?? eAnt)!.sem_id;
    let classe: EntidadeClasse;
    if (Math.abs(ant) < EPSILON_MONETARIO && ano > EPSILON_MONETARIO) classe = 'novo';
    else if (Math.abs(ano) < EPSILON_MONETARIO && ant > EPSILON_MONETARIO) classe = 'sumiu';
    else classe = 'recorrente';
    componentes.push({
      entidade_chave: k,
      entidade_label,
      sem_id,
      realizado_ytd: round2(ano),
      realizado_ytd_ano_anterior: round2(ant),
      delta: round2(ano - ant),
      delta_perc: Math.abs(ant) < EPSILON_MONETARIO ? null : (ano - ant) / Math.abs(ant),
      // denominador ABSOLUTO (coerente com o Pareto de nível) — evita % negativo/absurdo com estorno
      peso_perc: Math.abs(totalAnoBruto) < EPSILON_MONETARIO ? 0 : ano / Math.abs(totalAnoBruto),
      classe,
    });
  }

  // aumento_bruto = Σ max(ano − ant, 0) sobre TODAS as chaves (usa valores brutos)
  let aumentoBruto = 0;
  for (const k of chaves) {
    const ano = aggAno.get(k)?.soma ?? 0;
    const ant = aggAnt.get(k)?.soma ?? 0;
    aumentoBruto += Math.max(ano - ant, 0);
  }
  const aumento_bruto = round2(aumentoBruto);
  const sem_aumento_bruto = aumento_bruto <= EPSILON_MONETARIO;

  const top_n = input.topN ?? 3;

  // Pareto de NÍVEL: top-N por abs(realizado_ytd) / Σ abs(realizado_ytd)
  let somaAbsNivel = 0;
  for (const c of componentes) somaAbsNivel += Math.abs(c.realizado_ytd);
  const topNivel = [...componentes]
    .sort((a, b) => Math.abs(b.realizado_ytd) - Math.abs(a.realizado_ytd))
    .slice(0, top_n);
  let somaTopNivel = 0;
  for (const c of topNivel) somaTopNivel += Math.abs(c.realizado_ytd);
  const top_n_peso_nivel_perc =
    somaAbsNivel > EPSILON_MONETARIO ? Math.min(1, somaTopNivel / somaAbsNivel) : 0;

  // Pareto de AUMENTO: top-N por max(delta,0) / aumento_bruto
  let top_n_peso_aumento_perc: number | null;
  if (sem_aumento_bruto) {
    top_n_peso_aumento_perc = null;
  } else {
    const topAumento = [...componentes]
      .sort((a, b) => Math.max(b.delta, 0) - Math.max(a.delta, 0))
      .slice(0, top_n);
    let somaTopAumento = 0;
    for (const c of topAumento) somaTopAumento += Math.max(c.delta, 0);
    top_n_peso_aumento_perc = Math.min(1, somaTopAumento / aumento_bruto);
  }

  componentes.sort((a, b) => b.delta - a.delta);

  return {
    componentes,
    total_ano: round2(totalAnoBruto),
    total_ano_anterior: round2(totalAntBruto),
    aumento_bruto,
    top_n,
    top_n_peso_nivel_perc,
    top_n_peso_aumento_perc,
    sem_aumento_bruto,
    truncado: input.truncado ?? false,
  };
}

export type EntidadeReconciliacao = {
  qualidade: 'ok' | 'parcial' | 'diagnostico';
  diff: number | null;        // total-categoria(v1) − Σ entidades(v2); null se sem alvo
  diff_perc: number | null;   // |diff| / |total-categoria|; null se alvo ~0 ou ausente
};

/**
 * Classifica a reconciliação do v2 (Σ entidades) contra o total-por-categoria do v1
 * (mesma base viva). A diferença esperada é ~0; quando material, sinaliza honestamente
 * (pode incluir lançamentos no razão oposto — Codex P1 — ou truncamento). Mesmos
 * limiares do drill v1: `ok` ≤5% E ≤R$10k; `diagnostico` >20% ou truncado; senão `parcial`.
 */
export function classificarReconciliacaoEntidade(
  totalEntidades: number,
  totalCategoriaV1: number | null,
  truncado: boolean,
  limiteAbs = 10000,
  limitePercOk = 0.05,
  limitePercDiag = 0.2,
): EntidadeReconciliacao {
  if (truncado) return { qualidade: 'diagnostico', diff: null, diff_perc: null };
  if (totalCategoriaV1 == null) return { qualidade: 'ok', diff: null, diff_perc: null };
  const diff = round2(totalCategoriaV1 - totalEntidades);
  if (Math.abs(totalCategoriaV1) < EPSILON_MONETARIO) {
    return { qualidade: Math.abs(diff) < EPSILON_MONETARIO ? 'ok' : 'diagnostico', diff, diff_perc: null };
  }
  const diff_perc = Math.abs(diff) / Math.abs(totalCategoriaV1);
  let qualidade: EntidadeReconciliacao['qualidade'];
  if (diff_perc <= limitePercOk && Math.abs(diff) <= limiteAbs) qualidade = 'ok';
  else if (diff_perc > limitePercDiag) qualidade = 'diagnostico';
  else qualidade = 'parcial';
  return { qualidade, diff, diff_perc };
}

export async function coletarTitulosEntidade(input: {
  codigos: string[];
  chunkCodigos: number;
  pageSize: number;
  max: number;
  fetchPagina: (lote: string[], offset: number, limit: number) => Promise<EntidadeRowRaw[]>;
}): Promise<{ rows: EntidadeRowRaw[]; truncado: boolean }> {
  const { codigos, chunkCodigos, pageSize, max, fetchPagina } = input;
  if (codigos.length === 0) return { rows: [], truncado: false };

  const out: EntidadeRowRaw[] = [];
  let truncado = false;

  for (let i = 0; i < codigos.length && !truncado; i += chunkCodigos) {
    const lote = codigos.slice(i, i + chunkCodigos);
    let offset = 0;
    // loop de páginas dentro do lote
    for (;;) {
      const rows = await fetchPagina(lote, offset, pageSize);
      for (const row of rows) {
        out.push(row);
        if (out.length >= max) {
          truncado = true;
          break;
        }
      }
      if (truncado || rows.length < pageSize) break;
      offset += pageSize;
    }
  }

  return { rows: out, truncado };
}
