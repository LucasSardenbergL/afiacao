import { supabase } from '@/integrations/supabase/client';
import { fetchAllPages } from '@/lib/postgrest';

// "Margem Global", Margem Real/Potencial e Gap da aba Estratégica: a ÚLTIMA execução do Algoritmo A,
// INTEIRA. O `algorithm-a-audit` ACRESCENTA uma execução por vez em `margin_audit_log` (~508 clientes por
// semana, insert em lotes de 500, nunca regrava). A aba somava as 100 linhas mais recentes — 5–7% da
// execução (medido em prod, 2026-10-05: margem real R$ 2.179.687 × tela R$ 158.916; gap R$ 18,7 mi ×
// R$ 886 mil).
//
// COMO A EXECUÇÃO É RECONHECIDA (o log não tem id de execução nem marca de conclusão):
//  - FORMATO NOVO (edge ≥ v1.2): o edge carimba UM `calculated_at` (o início da execução) em todas as
//    linhas, e `created_at` segue no default do insert → `calculated_at ≠ created_at`. A execução = as
//    linhas desse carimbo, por igualdade.
//  - FORMATO ANTIGO: os dois são o `now()` do mesmo insert — iguais em 100% das 14.966 linhas (medido) —
//    e cada lote de 500 ganha o seu carimbo. Reconstrução: partindo do carimbo mais recente, o anterior
//    entra enquanto (a) também for do formato antigo, (b) estiver a < 1 s, (c) for um lote CHEIO (500) e
//    (d) for do mesmo período. Medido nas 54 transições do histórico: todo intervalo < 1 s (67–237 ms)
//    tem 500 linhas antes (fronteira de lote); execuções distintas ficam ≥ 7,9 s uma da outra.
//
// O que a tela NÃO pode afirmar: que a execução terminou. Um lote que falha depois de outro gravado deixa
// uma execução parcial indistinguível de uma carteira menor — daí `suspeitaInterrompida` (múltiplo exato
// do lote: indício, não diagnóstico) e o "conclusão não confirmada" no rodapé.

/** Tamanho do lote do insert no edge — espelho de `algorithm-a-audit` (um guardrail lê o edge). */
export const TAMANHO_LOTE_AUDITORIA = 500;
/** Intervalo máximo entre lotes da MESMA execução no formato antigo (medido: 67–237 ms; distintas ≥ 7,9 s). */
const INTERVALO_MAX_ENTRE_LOTES_MS = 1000;
/** Janela de leitura antes do carimbo mais recente (cobre os lotes do formato antigo com folga). */
const JANELA_LEITURA_MS = 30_000;
/** Quantos clientes a tabela da aba mostra (os maiores gaps). */
export const MAIORES_GAPS = 20;

export type LinhaAuditoria = {
  id: string;
  customer_user_id: string;
  period_start: string;
  period_end: string;
  margin_real: number | string | null;
  margin_potential: number | string | null;
  margin_gap: number | string | null;
  gap_pct: number | string | null;
  calculated_at: string;
  created_at: string;
};

export type Execucao = {
  linhas: LinhaAuditoria[];
  /** O carimbo mais recente (a âncora da leitura), no texto ORIGINAL — com os microssegundos. */
  carimbo: string;
  periodoInicio: string;
  periodoFim: string;
  formato: 'carimbo-unico' | 'reconstruida';
  /** Um lote compatível (< 1 s antes do mais antigo da cadeia) cairia ANTES do início da janela lida. */
  limiteDaJanela: boolean;
  /** A âncora mistura formatos ou períodos: não é uma execução reconhecível — a tela não soma. */
  inconsistente: boolean;
};

export type AgregadoExecucao = {
  linhas: number;
  clientes: number;
  /** linhas − clientes distintos. ≠ 0 invalida a soma (o escritor grava UMA linha por cliente). */
  duplicados: number;
  comMargemReal: number;
  /** Clientes com `margin_gap` conhecido (o gap da tela é parcial quando < clientes). */
  comGap: number;
  /** Σ das margens CONHECIDAS — `null` se nenhuma é (nunca R$ 0 fabricado). */
  margemReal: number | null;
  margemPotencial: number | null;
  /** Σ `margin_gap` de todos os clientes auditados (presente mesmo sem custo). */
  gap: number | null;
  maioresGaps: LinhaAuditoria[];
  /** Linhas = múltiplo exato do lote: uma execução interrompida deixa isso (uma completa também pode). */
  suspeitaInterrompida: boolean;
};

/** Instante em MICROSSEGUNDOS: o `Date.parse` corta a fração em ms (999,499 ms viraria 1.000). */
export function instanteUs(iso: string): number {
  const m = /^(.*T\d\d:\d\d:\d\d)(?:\.(\d+))?(.*)$/.exec(iso);
  if (!m) return Date.parse(iso) * 1000;
  return Date.parse(m[1] + (m[3] || 'Z')) * 1000 + Number((m[2] ?? '').padEnd(6, '0').slice(0, 6));
}
const formatoAntigo = (l: LinhaAuditoria) => l.calculated_at === l.created_at;
const periodo = (l: LinhaAuditoria) => `${l.period_start}|${l.period_end}`;

function numeroOuNull(v: number | string | null): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** As linhas da execução que termina em `carimboMax`, dentre as lidas na janela. `null` se a âncora não veio. */
export function reconhecerExecucao(linhas: LinhaAuditoria[], carimboMax: string, inicioJanela?: string): Execucao | null {
  const grupos = new Map<string, LinhaAuditoria[]>();
  for (const l of linhas) {
    const g = grupos.get(l.calculated_at);
    if (g) g.push(l);
    else grupos.set(l.calculated_at, [l]);
  }
  const ancora = grupos.get(carimboMax);
  if (!ancora || ancora.length === 0) return null;

  const carimbos = [...grupos.keys()].sort((a, b) => instanteUs(b) - instanteUs(a));
  const escolhidos = [carimboMax];
  let limiteDaJanela = false;
  const antigo = ancora.every(formatoAntigo);
  const inconsistente = new Set(ancora.map(formatoAntigo)).size > 1 || new Set(ancora.map(periodo)).size > 1;
  if (antigo) {
    const p0 = periodo(ancora[0]);
    let posterior = carimboMax;
    for (let i = carimbos.indexOf(carimboMax) + 1; ; i++) {
      if (i >= carimbos.length) {
        // acabaram os carimbos lidos: um lote anterior compatível (< 1 s antes) só poderia existir
        // se esse instante caísse ANTES do início da janela — aí a leitura não o teria visto
        limiteDaJanela =
          inicioJanela != null &&
          instanteUs(posterior) - INTERVALO_MAX_ENTRE_LOTES_MS * 1000 < instanteUs(inicioJanela);
        break;
      }
      const anterior = grupos.get(carimbos[i]) ?? [];
      const continua =
        anterior.every(formatoAntigo) &&
        instanteUs(posterior) - instanteUs(carimbos[i]) < INTERVALO_MAX_ENTRE_LOTES_MS * 1000 &&
        anterior.length === TAMANHO_LOTE_AUDITORIA &&
        anterior.every((l) => periodo(l) === p0);
      if (!continua) break;
      escolhidos.push(carimbos[i]);
      posterior = carimbos[i];
    }
  }
  const daExecucao = escolhidos.flatMap((c) => grupos.get(c) ?? []);
  return {
    linhas: daExecucao,
    carimbo: carimboMax,
    periodoInicio: ancora[0].period_start,
    periodoFim: ancora[0].period_end,
    formato: escolhidos.length > 1 || antigo ? 'reconstruida' : 'carimbo-unico',
    limiteDaJanela,
    inconsistente,
  };
}

/** Soma da execução: o conhecido é somado, o desconhecido continua desconhecido. */
export function agregarExecucao(linhas: LinhaAuditoria[]): AgregadoExecucao {
  const clientes = new Set(linhas.map((l) => l.customer_user_id)).size;
  const somar = (campo: 'margin_real' | 'margin_potential' | 'margin_gap') => {
    let soma = 0;
    let conhecidas = 0;
    for (const l of linhas) {
      const n = numeroOuNull(l[campo]);
      if (n == null) continue;
      soma += n;
      conhecidas++;
    }
    return { soma: conhecidas > 0 ? soma : null, conhecidas };
  };
  const real = somar('margin_real');
  const gap = somar('margin_gap');
  const maioresGaps = [...linhas]
    .sort(
      (a, b) =>
        (numeroOuNull(b.margin_gap) ?? -Infinity) - (numeroOuNull(a.margin_gap) ?? -Infinity) ||
        a.customer_user_id.localeCompare(b.customer_user_id),
    )
    .slice(0, MAIORES_GAPS);
  return {
    linhas: linhas.length,
    clientes,
    duplicados: linhas.length - clientes,
    comMargemReal: real.conhecidas,
    comGap: gap.conhecidas,
    margemReal: real.soma,
    margemPotencial: somar('margin_potential').soma,
    gap: gap.soma,
    maioresGaps,
    suspeitaInterrompida: linhas.length > 0 && linhas.length % TAMANHO_LOTE_AUDITORIA === 0,
  };
}

export type LeituraExecucao = { execucao: Execucao; agregado: AgregadoExecucao };

const COLUNAS =
  'id, customer_user_id, period_start, period_end, margin_real, margin_potential, margin_gap, gap_pct, calculated_at, created_at';

/**
 * Lê a última execução INTEIRA. `null` = nenhuma auditoria gravada (≠ falha, que LANÇA).
 *
 * A âncora (o carimbo mais recente) é lida antes e fixa a janela nas DUAS pontas — `<= âncora`, no texto
 * original (o `toISOString()` cortaria os microssegundos e excluiria o último lote). Cada página é uma
 * transação própria do PostgREST: um lote gravado no meio desloca os offsets. Por isso a contagem antes e
 * depois e os ids únicos; se o log mudou, a tentativa é descartada (uma nova, e depois desiste).
 */
export async function lerUltimaExecucaoAuditoria(): Promise<LeituraExecucao | null> {
  const { data: ancora, error: erroAncora } = await supabase
    .from('margin_audit_log')
    .select('calculated_at')
    .order('calculated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (erroAncora) throw erroAncora;
  if (!ancora) return null;
  const carimboMax = (ancora as { calculated_at: string }).calculated_at;
  const desde = new Date(Math.floor(instanteUs(carimboMax) / 1000) - JANELA_LEITURA_MS).toISOString();

  const contar = async () => {
    const { count, error } = await supabase
      .from('margin_audit_log')
      .select('id', { count: 'exact', head: true })
      .gte('calculated_at', desde)
      .lte('calculated_at', carimboMax);
    if (error) throw error;
    if (count == null) throw new Error('margin_audit_log: a contagem não veio');
    return count;
  };

  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    const antes = await contar();
    const linhas = await fetchAllPages<LinhaAuditoria>(
      (de, ate) =>
        supabase
          .from('margin_audit_log')
          .select(COLUNAS)
          .gte('calculated_at', desde)
          .lte('calculated_at', carimboMax)
          .order('id', { ascending: true })
          .range(de, ate) as unknown as PromiseLike<{ data: LinhaAuditoria[] | null; error: unknown }>,
      'margin_audit_log/ultima-execucao',
    );
    const depois = await contar();
    const estavel = antes === depois && linhas.length === depois && new Set(linhas.map((l) => l.id)).size === linhas.length;
    if (!estavel) continue;
    const execucao = reconhecerExecucao(linhas, carimboMax, desde);
    if (!execucao) throw new Error('margin_audit_log: o carimbo mais recente não voltou na leitura');
    return { execucao, agregado: agregarExecucao(execucao.linhas) };
  }
  throw new Error('margin_audit_log: o log mudou durante a leitura (uma execução gravando) — tente de novo');
}

/** "dd/mm/aaaa hh:mm" no fuso de SP — o dia sozinho não distingue execuções manuais do mesmo dia. */
export function dataHoraExecucao(carimbo: string): string {
  return new Date(carimbo).toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** O rodapé da auditoria: de QUANDO é o número e o que ele não garante. */
export function rodapeExecucao({ execucao, agregado }: LeituraExecucao): string {
  const partes = [
    `Execução de ${dataHoraExecucao(execucao.carimbo)} (horário de Brasília)`,
    `${agregado.clientes} clientes auditados`,
    'conclusão não confirmada pelo log',
  ];
  if (agregado.suspeitaInterrompida) {
    partes.push(`contagem é múltiplo exato do lote (${TAMANHO_LOTE_AUDITORIA}) — a execução pode ter sido interrompida`);
  }
  if (execucao.formato === 'reconstruida') partes.push('formato antigo: execução inferida pelos lotes');
  if (execucao.limiteDaJanela) partes.push('a inferência chegou ao limite da janela de leitura');
  return partes.join(' · ');
}
