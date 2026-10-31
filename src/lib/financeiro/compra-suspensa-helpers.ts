// "Segurar compra" (aba Ciclo, Oben): normaliza e resume o que as RPCs reposicao_compra_suspensa_* devolvem.
// A REGRA (quem é candidato, o que o motor segura, o que conta como evitado) vive no banco; aqui só se lê.
// Ausente ≠ zero: soma com nenhum termo conhecido é null (nunca 0), e o "evitado" é R$ de SUGESTÃO suprimida
// por run — não caixa economizado (Codex P1-7 da spec 2026-10-31-reposicao-compra-suspensa-design).
import { num } from '@/lib/financeiro/ciclo-cliente-helpers';

export type OrigemSuspensao = 'ciclo_ui' | 'lote_cobertura' | 'envelope';

export type SuspensaAtiva = {
  id: string; sku: number; descricao: string | null; fornecedor: string | null;
  motivo: string; origem: OrigemSuspensao; loteId: string | null;
  suspensoEm: string; revisarEm: string; suspensoPor: string | null; suspensoPorTexto: string | null;
  fotoValor: number | null; fotoCobertura365: number | null; fotoCobertura90: number | null;
  fotoNoMotor: boolean | null; fotoVenda90: number | null;
  saldoAtual: number | null; valorAtual: number | null; cobertura90Atual: number | null; cobertura365Atual: number | null;
  noMotorAtual: boolean | null; evitadoUltimoRun: number | null; qtdeUltimoRun: number | null;
};

export type RunMotor = {
  runId: string; criadoEm: string; dataCiclo: string; seguradasN: number; skusIncluidos: number;
  valorEvitado: number | null; linhasSemPreco: number;
};

export type Candidato = {
  sku: number; descricao: string | null; fornecedor: string | null; saldo: number; valor: number | null;
  dias365: number | null; dias90: number | null; noMotor: boolean; venda90: number | null; corante: boolean;
};

const txt = (x: unknown): string | null => (typeof x === 'string' && x.trim() !== '' ? x : null);
const bool = (x: unknown): boolean | null => (typeof x === 'boolean' ? x : null);
const ORIGENS: readonly string[] = ['ciclo_ui', 'lote_cobertura', 'envelope'];

/** Linha sem id, SKU, motivo ou data é descartada (nunca default fabricado). */
export function normalizarSuspensa(r: Record<string, unknown>): SuspensaAtiva | null {
  const id = txt(r.id); const sku = num(r.sku_codigo_omie); const motivo = txt(r.motivo);
  const suspensoEm = txt(r.suspenso_em); const revisarEm = txt(r.revisar_em);
  if (!id || sku === null || !motivo || !suspensoEm || !revisarEm) return null;
  const origem = typeof r.origem === 'string' && ORIGENS.includes(r.origem) ? (r.origem as OrigemSuspensao) : 'ciclo_ui';
  return {
    id, sku, descricao: txt(r.descricao), fornecedor: txt(r.fornecedor_nome), motivo, origem, loteId: txt(r.lote_id),
    suspensoEm, revisarEm, suspensoPor: txt(r.suspenso_por), suspensoPorTexto: txt(r.suspenso_por_texto),
    fotoValor: num(r.foto_valor), fotoCobertura365: num(r.foto_cobertura_dias), fotoCobertura90: num(r.foto_cobertura_90d_dias),
    fotoNoMotor: bool(r.foto_no_motor), fotoVenda90: num(r.foto_valor_vendido_90d),
    saldoAtual: num(r.saldo_atual), valorAtual: num(r.valor_atual),
    cobertura90Atual: num(r.cobertura_90d_atual), cobertura365Atual: num(r.cobertura_365d_atual),
    noMotorAtual: bool(r.no_motor_atual), evitadoUltimoRun: num(r.evitado_ultimo_run), qtdeUltimoRun: num(r.qtde_ultimo_run),
  };
}

export function normalizarRun(r: Record<string, unknown>): RunMotor | null {
  const runId = txt(r.run_id); const criadoEm = txt(r.criado_em); const dataCiclo = txt(r.data_ciclo);
  const seguradasN = num(r.suspensas_compra_n); const skusIncluidos = num(r.skus_incluidos); const semPreco = num(r.linhas_sem_preco);
  if (!runId || !criadoEm || !dataCiclo || seguradasN === null || skusIncluidos === null || semPreco === null) return null;
  return { runId, criadoEm, dataCiclo, seguradasN, skusIncluidos, valorEvitado: num(r.valor_evitado), linhasSemPreco: semPreco };
}

export function normalizarCandidato(r: Record<string, unknown>): Candidato | null {
  const sku = num(r.sku_codigo_omie); const saldo = num(r.saldo);
  if (sku === null || saldo === null || typeof r.no_motor !== 'boolean' || typeof r.corante !== 'boolean') return null;
  return {
    sku, descricao: txt(r.descricao), fornecedor: txt(r.fornecedor_nome), saldo, valor: num(r.valor),
    dias365: num(r.dias_365), dias90: num(r.dias_90), noMotor: r.no_motor, venda90: num(r.valor_vendido_90d), corante: r.corante,
  };
}

/** Soma só os termos conhecidos; nenhum conhecido → null (ausente ≠ zero). */
export function somaHonesta(valores: ReadonlyArray<number | null>): { total: number | null; desconhecidos: number } {
  let total: number | null = null; let desconhecidos = 0;
  for (const v of valores) {
    if (v === null) desconhecidos++;
    else total = (total ?? 0) + v;
  }
  return { total, desconhecidos };
}

export type ResumoSuspensas = {
  ativasN: number; noMotorN: number;
  fotoValor: number | null; fotoSemCusto: number;
  valorAtual: number | null; valorAtualSemCusto: number;
  /** Último run do motor no período: R$ de sugestão suprimida e quantas linhas ficaram sem preço (parcial). */
  ultimoRun: { em: string; seguradasN: number; evitado: number | null; semPreco: number } | null;
  /** Denominador do sensor: runs no período e quantos tiveram ≥1 linha segurada. */
  runsN: number; runsComSupressaoN: number;
  /** Σ do evitado nos runs do período: R$·run (a mesma necessidade reaparece a cada run) — não é caixa. */
  evitadoRunsSoma: number | null;
  /** Linhas sem preço em TODOS os runs do período: > 0 ⇒ a Σ acima é PARCIAL (Codex P2-3). */
  runsLinhasSemPreco: number;
  revisaoVencidaN: number;
};

export function resumirSuspensas(ativas: SuspensaAtiva[], runs: RunMotor[], hoje: string): ResumoSuspensas {
  const foto = somaHonesta(ativas.map((a) => a.fotoValor));
  const atual = somaHonesta(ativas.map((a) => a.valorAtual));
  const ordenados = [...runs].sort((a, b) => (a.criadoEm < b.criadoEm ? 1 : a.criadoEm > b.criadoEm ? -1 : 0));
  const ult = ordenados[0];
  const soma = somaHonesta(runs.map((r) => r.valorEvitado));
  return {
    ativasN: ativas.length,
    noMotorN: ativas.filter((a) => a.noMotorAtual === true).length,
    fotoValor: foto.total, fotoSemCusto: foto.desconhecidos,
    valorAtual: atual.total, valorAtualSemCusto: atual.desconhecidos,
    ultimoRun: ult ? { em: ult.criadoEm, seguradasN: ult.seguradasN, evitado: ult.valorEvitado, semPreco: ult.linhasSemPreco } : null,
    runsN: runs.length,
    runsComSupressaoN: runs.filter((r) => r.seguradasN > 0).length,
    evitadoRunsSoma: soma.total,
    runsLinhasSemPreco: runs.reduce((n, r) => n + r.linhasSemPreco, 0),
    revisaoVencidaN: ativas.filter((a) => a.revisarEm < hoje).length,
  };
}

/** Limiar PROVISÓRIO de risco de falta (dias de cobertura pela venda dos últimos 90d) — não é fill-rate. */
export const RISCO_FALTA_DIAS = 60;

/** Ordem de revisão: quem mais vende (90d) primeiro — é a lista para reativar rápido; empate por R$ parado. */
export function ordenarPorRisco(ativas: SuspensaAtiva[]): SuspensaAtiva[] {
  return [...ativas].sort((a, b) =>
    (b.fotoVenda90 ?? -1) - (a.fotoVenda90 ?? -1) || (b.valorAtual ?? -1) - (a.valorAtual ?? -1) || a.sku - b.sku);
}

export function emRiscoDeFalta(a: Pick<SuspensaAtiva, 'cobertura90Atual'>): boolean {
  return a.cobertura90Atual !== null && a.cobertura90Atual < RISCO_FALTA_DIAS;
}

export const OPCOES_REVISAO_DIAS = [30, 60, 90, 180] as const;
export type RevisaoDias = (typeof OPCOES_REVISAO_DIAS)[number];

/** 'YYYY-MM-DD' + N dias: aritmética em UTC de PROPÓSITO sobre a data civil (Date.UTC + getUTC*), sem passar pelo fuso do navegador. */
export function somarDias(ymd: string, dias: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + dias));
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p2(t.getUTCMonth() + 1)}-${p2(t.getUTCDate())}`;
}

export function resumirCandidatos(c: Candidato[]): { n: number; valor: number | null; semCusto: number; noMotorN: number; comVenda90N: number } {
  const s = somaHonesta(c.map((x) => x.valor));
  return { n: c.length, valor: s.total, semCusto: s.desconhecidos, noMotorN: c.filter((x) => x.noMotor).length, comVenda90N: c.filter((x) => (x.venda90 ?? 0) > 0).length };
}
