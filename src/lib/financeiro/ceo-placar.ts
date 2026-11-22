/**
 * Placar da "Visão do CEO" (home do master): derivados PUROS sobre as mesmas leituras do
 * Cockpit financeiro (resumo, DRE, snapshots de projeção), recortados pelo escopo de empresa.
 *
 * Régua (parecer Codex 2026-11-20):
 * - Ausente ≠ zero: qualquer CNPJ do escopo sem o dado → o agregado é `null` ("—"), nunca a
 *   soma de quem respondeu (seria um total menor apresentado como total do grupo).
 * - Margem bruta do ÚLTIMO MÊS FECHADO COMUM a todas as empresas do escopo — o cockpit usa o
 *   último mês de CADA CNPJ e pode misturar meses; aqui o mês é o mesmo e vai visível no tile.
 *   Mês sem receita líquida não conta como "fechado" (DRE vazia não vira margem 0%).
 * - Margem bruta só de quem VENDE MERCADORIA. A Colacor SC só presta serviço (founder,
 *   2026-11-21; DRE de prod: CMV 0 todo mês e o custo inteiro em despesas operacionais), então
 *   `lucro_bruto = receita_liquida − 0` daria 100% sem significado: ela sai da conta e vai
 *   listada em `servicoFora`.
 * - Nas de mercadoria, CMV zerado (ou ausente) com receita > 0 é custo NÃO CLASSIFICADO, não
 *   margem de 100%: a margem do escopo vira `null` com o motivo.
 * - NCG de snapshot sem estoque (`ncg_completa !== true`) vai marcada `completa: false` — o
 *   valor fica (é o mesmo do cockpit, que o mostra como "Parcial"), mas sem leitura de sinal.
 * - Caixa soma saldos entre CNPJs, mas caixa NÃO é fungível entre CNPJs: a lista de empresas
 *   com saldo negativo acompanha o total, para o positivo de uma não esconder o aperto de outra.
 * - Caixa projetado (13 semanas, snapshot "realista" da engine A1, mesma coorte do cockpit): por CNPJ,
 *   se já está negativo,
 *   a partir de que semana fica negativo e o PIOR saldo do horizonte. A falta de caixa do escopo é
 *   a soma dos déficits no pior saldo de cada CNPJ — sem abater a sobra de outro (caixa não é
 *   fungível). CNPJ sem projeção → total `null`. Snapshot de antes de ontem vai com a defasagem.
 */
import type { Company, CompanySelection } from '@/contexts/CompanyContext';
import { consolidarTitulos, type TotaisTitulos } from '@/lib/financeiro/resumo-titulos';
import type { SnapshotEmpresa } from '@/lib/financeiro/cockpit-consolida-helpers';

const EMPRESAS_GRUPO: readonly Company[] = ['oben', 'colacor', 'colacor_sc'];

/** CNPJs que só prestam serviço (sem CMV por natureza) — fora da margem bruta. */
const EMPRESAS_SERVICO: readonly Company[] = ['colacor_sc'];

export function empresasDoEscopo(selection: CompanySelection): Company[] {
  return selection === 'all' ? [...EMPRESAS_GRUPO] : [selection];
}

/** Recorte mínimo do resumo financeiro por CNPJ que o placar usa. */
export type ResumoCnpj = TotaisTitulos & { saldo_total_cc: number | null };

/** Recorte mínimo de uma linha de DRE. */
export interface DreLinha {
  company: string;
  mes: number;
  receita_liquida: number;
  lucro_bruto: number;
  /** Custo da mercadoria vendida (positivo). Zero/ausente com receita = custo não classificado. */
  cmv: number | null;
  /** Categorias que caíram na heurística por descrição (sem mapeamento explícito). */
  qtd_categorias_sem_mapeamento?: number | null;
  /** Mês ainda aberto na contabilidade da DRE. */
  resultado_provisorio?: boolean | null;
}

/** Recorte mínimo do consolidado de projeção (NCG por CNPJ). */
export interface NcgFonte {
  ncg_por_empresa: { company: string; ncg: number | null; presente: boolean; completa: boolean }[];
  data_referencia: string | null;
}

export interface Margem {
  /** Fração (0,23 = 23%); `null` sem mês fechado comum ou sem DRE. */
  valor: number | null;
  /** Mês (1-12) usado; `null` quando indisponível. */
  mes: number | null;
  /** Empresas do escopo com CMV zerado/ausente no mês (→ `valor` null). Vazio = margem confiável. */
  semCmv: Company[];
  /** Empresas do escopo que só prestam serviço, deixadas fora da margem bruta. */
  servicoFora: Company[];
}

export interface Caixa {
  saldo: number | null;
  /** A receber − a pagar (títulos abertos). */
  posicaoLiquida: number | null;
  /** CNPJs do escopo com saldo bancário negativo (o total os compensa com o saldo dos outros). */
  empresasNegativas: Company[];
}

export interface Vencidos {
  valor: number | null;
  /** Fração do vencido sobre o total a receber aberto. */
  pct: number | null;
}

export function caixaDoEscopo(resumo: Record<string, ResumoCnpj> | null, empresas: readonly Company[]): Caixa {
  const vazio: Caixa = { saldo: null, posicaoLiquida: null, empresasNegativas: [] };
  if (!resumo || empresas.length === 0) return vazio;
  const linhas = empresas.map((co) => resumo[co]);
  if (linhas.some((l) => l === undefined)) return vazio;
  const saldo = linhas.some((l) => l.saldo_total_cc === null)
    ? null
    : linhas.reduce((s, l) => s + (l.saldo_total_cc as number), 0);
  const empresasNegativas = empresas.filter((co) => {
    const v = resumo[co].saldo_total_cc;
    return v !== null && v < 0;
  });
  return { saldo, posicaoLiquida: consolidarTitulos(linhas).posicao_liquida, empresasNegativas };
}

export function vencidosDoEscopo(resumo: Record<string, ResumoCnpj> | null, empresas: readonly Company[]): Vencidos {
  if (!resumo || empresas.length === 0) return { valor: null, pct: null };
  const linhas = empresas.map((co) => resumo[co]);
  if (linhas.some((l) => l === undefined)) return { valor: null, pct: null };
  const t = consolidarTitulos(linhas);
  if (t.total_vencido_receber === null || t.total_a_receber === null) return { valor: null, pct: null };
  // Carteira aberta zerada é zero LEGÍTIMO (nada a receber, nada vencido).
  const pct = t.total_a_receber > 0 ? t.total_vencido_receber / t.total_a_receber : 0;
  return { valor: t.total_vencido_receber, pct };
}

/**
 * Margem bruta do último mês FECHADO (< mês corrente) presente em TODAS as empresas de
 * mercadoria do escopo, com receita líquida > 0 em cada uma.
 */
export function margemUltimoMesFechado(
  dre: readonly DreLinha[] | null,
  empresas: readonly Company[],
  mesCorrente: number,
): Margem {
  const servicoFora = empresas.filter((co) => EMPRESAS_SERVICO.includes(co));
  const mercadoria = empresas.filter((co) => !EMPRESAS_SERVICO.includes(co));
  const vazio: Margem = { valor: null, mes: null, semCmv: [], servicoFora };
  if (!dre || mercadoria.length === 0) return vazio;
  const mesesPorEmpresa = mercadoria.map(
    (co) => new Set(dre.filter((d) => d.company === co && d.mes < mesCorrente && d.receita_liquida > 0).map((d) => d.mes)),
  );
  const comuns = [...mesesPorEmpresa[0]].filter((m) => mesesPorEmpresa.every((s) => s.has(m)));
  if (comuns.length === 0) return vazio;
  const mes = Math.max(...comuns);
  const doMes = dre.filter((d) => d.mes === mes && mercadoria.includes(d.company as Company));
  // Receita sem custo classificado não é margem de 100%: o grupo inteiro degrada (ausente ≠ zero).
  const semCmv = mercadoria.filter((co) =>
    doMes.some((d) => d.company === co && d.receita_liquida > 0 && !(d.cmv !== null && d.cmv > 0)),
  );
  if (semCmv.length > 0) return { valor: null, mes, semCmv, servicoFora };
  const receita = doMes.reduce((s, d) => s + d.receita_liquida, 0);
  const lucro = doMes.reduce((s, d) => s + d.lucro_bruto, 0);
  return { valor: receita > 0 ? lucro / receita : null, mes, semCmv, servicoFora };
}

export interface Ncg {
  valor: number | null;
  dataReferencia: string | null;
  /** `false` quando algum CNPJ do escopo calculou a NCG sem estoque (valor parcial). */
  completa: boolean;
}

export function ncgDoEscopo(fonte: NcgFonte | null, empresas: readonly Company[]): Ncg {
  if (!fonte || empresas.length === 0) return { valor: null, dataReferencia: null, completa: false };
  let soma = 0;
  let completa = true;
  for (const co of empresas) {
    const linha = fonte.ncg_por_empresa.find((n) => n.company === co);
    if (!linha || !linha.presente || linha.ncg === null) {
      return { valor: null, dataReferencia: fonte.data_referencia, completa: false };
    }
    soma += linha.ncg;
    if (!linha.completa) completa = false;
  }
  return { valor: soma, dataReferencia: fonte.data_referencia, completa };
}

export interface LinhaEmpresa {
  empresa: Company;
  caixa: Caixa;
  vencidos: Vencidos;
  margem: Margem;
  ncg: Ncg;
}

/** Uma linha por CNPJ — o consolidado positivo pode esconder aperto numa empresa só. */
export function linhasPorEmpresa(
  resumo: Record<string, ResumoCnpj> | null,
  dre: readonly DreLinha[] | null,
  ncg: NcgFonte | null,
  empresas: readonly Company[],
  mesCorrente: number,
): LinhaEmpresa[] {
  return empresas.map((empresa) => ({
    empresa,
    caixa: caixaDoEscopo(resumo, [empresa]),
    vencidos: vencidosDoEscopo(resumo, [empresa]),
    margem: margemUltimoMesFechado(dre, [empresa], mesCorrente),
    ncg: ncgDoEscopo(ncg, [empresa]),
  }));
}

/** Por que um CNPJ não tem projeção utilizável (→ falta do escopo `null`). */
type MotivoSemProjecao = 'ausente' | 'desatualizada' | 'incompleta';

interface RupturaEmpresa {
  empresa: Company;
  /** `null` = projeção utilizável; senão os demais campos são null/false. */
  motivo: MotivoSemProjecao | null;
  /** Saldo já negativo na abertura da 1ª semana projetada. */
  negativaHoje: boolean;
  /** Início (YYYY-MM-DD) da 1ª semana com saldo negativo; `null` = positiva no horizonte. */
  primeiraNegativa: string | null;
  /** Menor saldo do horizonte (abertura incluída) e a semana em que ocorre. */
  pior: { inicio: string; saldo: number } | null;
  /** Data (YYYY-MM-DD) do snapshot usado. */
  snapshot: string | null;
}

export interface CaixaProjetado {
  /** Σ dos déficits (−pior saldo) dos CNPJs que ficam negativos; 0 = ninguém fica; `null` = algum sem projeção. */
  falta: number | null;
  porEmpresa: RupturaEmpresa[];
  /** Dias entre hoje e a data da coorte de snapshots (`null` sem snapshot). */
  diasDefasagem: number | null;
}

const HORIZONTE_SEMANAS = 13;
const DIA_MS = 86_400_000;

/**
 * Exige o horizonte INTEIRO: 13 semanas de 7 em 7 dias e a abertura da 1ª conhecida (Codex P1,
 * 2026-11-21) — semana faltando pode esconder o pior saldo, e abertura nula fabricaria "já negativa".
 */
function rupturaDaEmpresa(ultimo: SnapshotEmpresa | undefined, empresa: Company, dataCoorte: string | null): RupturaEmpresa {
  const sem = (motivo: MotivoSemProjecao): RupturaEmpresa => ({
    empresa, motivo, negativaHoje: false, primeiraNegativa: null, pior: null, snapshot: ultimo ? ultimo.snapshot_at.slice(0, 10) : null,
  });
  if (!ultimo) return sem('ausente');
  // Mesma coorte do cockpit: snapshot de data anterior à mais recente do grupo é desatualizado.
  if (dataCoorte !== null && ultimo.snapshot_at.slice(0, 10) !== dataCoorte) return sem('desatualizada');
  const semanas = [...ultimo.semanas].sort((a, b) => a.inicio.localeCompare(b.inicio)).slice(0, HORIZONTE_SEMANAS);
  const consecutivas = semanas.every((w, i) => i === 0 || Date.parse(w.inicio) - Date.parse(semanas[i - 1].inicio) === 7 * DIA_MS);
  const abertura = semanas[0]?.saldo_inicial ?? null;
  if (semanas.length < HORIZONTE_SEMANAS || !consecutivas || abertura === null) return sem('incompleta');
  const negativaHoje = abertura < 0;
  const primeira = negativaHoje ? semanas[0] : semanas.find((w) => w.saldo_final < 0);
  let pior = { inicio: semanas[0].inicio, saldo: abertura };
  for (const w of semanas) if (w.saldo_final < pior.saldo) pior = { inicio: w.inicio, saldo: w.saldo_final };
  return {
    empresa,
    motivo: null,
    negativaHoje,
    primeiraNegativa: primeira ? primeira.inicio : null,
    pior,
    snapshot: ultimo.snapshot_at.slice(0, 10),
  };
}

export function caixaProjetadoDoEscopo(
  snapshots: readonly SnapshotEmpresa[] | null,
  empresas: readonly Company[],
  hoje: string,
): CaixaProjetado {
  if (!snapshots || empresas.length === 0) return { falta: null, porEmpresa: [], diasDefasagem: null };
  const ultimos = new Map<string, SnapshotEmpresa>();
  for (const s of snapshots) {
    const atual = ultimos.get(s.company);
    if (!atual || Date.parse(s.snapshot_at) > Date.parse(atual.snapshot_at)) ultimos.set(s.company, s);
  }
  // Coorte = data mais recente entre TODOS os CNPJs lidos (régua do `consolidarCockpit`).
  let dataCoorte: string | null = null;
  for (const s of ultimos.values()) {
    const d = s.snapshot_at.slice(0, 10);
    if (dataCoorte === null || d > dataCoorte) dataCoorte = d;
  }
  const porEmpresa = empresas.map((co) => rupturaDaEmpresa(ultimos.get(co), co, dataCoorte));
  const falta = porEmpresa.some((r) => r.motivo !== null)
    ? null
    : porEmpresa.reduce((s, r) => s + (r.pior && r.pior.saldo < 0 ? -r.pior.saldo : 0), 0);
  const dias = dataCoorte === null ? NaN : Math.round((Date.parse(hoje) - Date.parse(dataCoorte)) / DIA_MS);
  return { falta, porEmpresa, diasDefasagem: Number.isFinite(dias) ? dias : null };
}

/**
 * Cobrança para o CEO — fonte: RPC `cobranca_fila` (uma linha por empresa credora × cliente no Omie
 * DAQUELA empresa). A chave é (company, omie_codigo_cliente), nunca o nome: o cliente do grupo tem 2
 * cadastros fiscais legítimos e `nome_cliente`/`cnpj_cpf` dos títulos vêm vazios em prod.
 */
export interface DevedorCobranca {
  company: Company;
  codigo: number;
  nome: string | null;
  /** `null` = saldo desconhecido (ausente ≠ zero). */
  saldoVencido: number | null;
  /** Títulos vencidos do cliente; `null` = desconhecido. 0 = caso aberto sem vencido (não é dívida). */
  nVencidas: number | null;
  diasMax: number | null;
  /** Atraso acima de 1 ano: provável perda — vai para o fim do "cobrar primeiro" (o valor fica no total). */
  antigo: boolean;
  responsavel: string | null;
  /** Estado do caso na fila (`a_contatar`, `contatado`, `promessa`, `pago_informado`, `negociado`, `disputa`, `cancelado_gestao`). */
  estado: string;
  promessaVencida: boolean;
}

const COMPANIES_VALIDAS: readonly Company[] = EMPRESAS_GRUPO;
const DIAS_CARTEIRA_ANTIGA = 365;
const numeroOuNull = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Linha crua da RPC → devedor; linha sem empresa/código válidos é descartada (não é devedor). */
export function devedorDaFila(raw: Record<string, unknown>): DevedorCobranca | null {
  const company = raw.company as Company;
  const codigo = numeroOuNull(raw.omie_codigo_cliente);
  if (!COMPANIES_VALIDAS.includes(company) || codigo === null) return null;
  const nome = typeof raw.nome_cliente === 'string' && raw.nome_cliente.trim() !== '' ? raw.nome_cliente.trim() : null;
  const diasMax = numeroOuNull(raw.dias_vencido_max);
  const responsavel = raw.dona_user_id
    ? typeof raw.dona_nome === 'string' && raw.dona_nome.trim() !== '' ? raw.dona_nome.trim() : 'sem nome'
    : null;
  return {
    company,
    codigo,
    nome,
    saldoVencido: numeroOuNull(raw.saldo_vencido),
    nVencidas: numeroOuNull(raw.n_vencidas),
    diasMax,
    antigo: diasMax !== null && diasMax > DIAS_CARTEIRA_ANTIGA,
    responsavel,
    estado: typeof raw.estado === 'string' && raw.estado !== '' ? raw.estado : 'a_contatar',
    promessaVencida: raw.promessa_situacao === 'vencida',
  };
}

/** Estados em que cobrar agora é a ação: falta contato ou o contato não virou acordo. */
const ESTADOS_ACIONAVEIS = new Set(['a_contatar', 'contatado']);

export interface Cobranca {
  /** Devedores com saldo vencido > 0. */
  devedores: number;
  semResponsavel: { n: number; valor: number };
  /** Promessas vencidas em qualquer caso da fila — inclusive com saldo ilegível (não some). */
  promessasVencidas: number;
  /** Com vencido e saldo desconhecido — o total fica incompleto e o card diz quantas. */
  saldoDesconhecido: number;
  /** Com saldo > 0 em pagamento informado, negociação, disputa ou cancelados pela gestão. */
  aguardando: number;
  /** Até `limite` devedores para cobrar: promessa vencida, depois a contatar/contatado até 1 ano, por saldo; antigos no fim. */
  top: DevedorCobranca[];
}

const acionavel = (d: DevedorCobranca) => d.promessaVencida || ESTADOS_ACIONAVEIS.has(d.estado);

/** `null` quando a fila de alguma empresa do escopo não foi lida (ausente ≠ "ninguém deve"). */
export function cobrancaDoEscopo(
  filas: Partial<Record<Company, readonly DevedorCobranca[]>> | null,
  empresas: readonly Company[],
  limite = 5,
): Cobranca | null {
  if (!filas || empresas.length === 0 || empresas.some((co) => filas[co] === undefined)) return null;
  const linhas = empresas.flatMap((co) => filas[co] as readonly DevedorCobranca[]);
  const devendo = linhas.filter((d) => d.saldoVencido !== null && d.saldoVencido > 0);
  const semResp = devendo.filter((d) => d.responsavel === null);
  const prioridade = (d: DevedorCobranca) => (d.promessaVencida ? 0 : d.antigo ? 2 : 1);
  return {
    devedores: devendo.length,
    semResponsavel: { n: semResp.length, valor: semResp.reduce((s, d) => s + (d.saldoVencido as number), 0) },
    promessasVencidas: linhas.filter((d) => d.promessaVencida).length,
    saldoDesconhecido: linhas.filter((d) => d.saldoVencido === null && d.nVencidas !== 0).length,
    aguardando: devendo.filter((d) => !acionavel(d)).length,
    top: devendo
      .filter(acionavel)
      .sort((a, b) => prioridade(a) - prioridade(b) || (b.saldoVencido as number) - (a.saldoVencido as number))
      .slice(0, limite),
  };
}

export interface LinhaComposicaoMargem {
  empresa: Company;
  receitaLiquida: number;
  cmv: number;
  lucroBruto: number;
  margem: number;
  /** Margem do mês anterior com receita e CMV > 0; `null` sem base. */
  margemAnterior: number | null;
  /** Categorias sem mapeamento explícito no mês (heurística) — `null` = não informado. */
  semMapeamento: number | null;
  provisorio: boolean;
}

/**
 * De onde vem a margem bruta do tile: receita, CMV e lucro por empresa de MERCADORIA no mesmo mês
 * do tile, com a margem do mês anterior e a confiança do mapeamento — para decidir preço olhando o
 * custo, não só o percentual. Vazio quando o tile não tem margem (sem mês comum ou CMV ausente).
 */
export function composicaoMargem(
  dre: readonly DreLinha[] | null,
  empresas: readonly Company[],
  mesCorrente: number,
): { mes: number | null; linhas: LinhaComposicaoMargem[] } {
  const m = margemUltimoMesFechado(dre, empresas, mesCorrente);
  if (!dre || m.valor === null || m.mes === null) return { mes: null, linhas: [] };
  const mes = m.mes;
  const linhaDo = (co: Company, mm: number) => dre.find((d) => d.company === co && d.mes === mm);
  const linhas = empresas
    .filter((co) => !m.servicoFora.includes(co))
    .map((co): LinhaComposicaoMargem | null => {
      const d = linhaDo(co, mes);
      if (!d || d.cmv === null || d.receita_liquida <= 0) return null;
      const ant = linhaDo(co, mes - 1);
      return {
        empresa: co,
        receitaLiquida: d.receita_liquida,
        cmv: d.cmv,
        lucroBruto: d.lucro_bruto,
        margem: d.lucro_bruto / d.receita_liquida,
        margemAnterior: ant && ant.receita_liquida > 0 && ant.cmv !== null && ant.cmv > 0 ? ant.lucro_bruto / ant.receita_liquida : null,
        semMapeamento: typeof d.qtd_categorias_sem_mapeamento === 'number' ? d.qtd_categorias_sem_mapeamento : null,
        provisorio: d.resultado_provisorio === true,
      };
    })
    .filter((l): l is LinhaComposicaoMargem => l !== null);
  return { mes, linhas };
}
