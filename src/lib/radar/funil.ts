// Radar H — o funil do lead empurrado (RPC radar_funil, migration 20261107230000). Puro: parser estrito da resposta,
// somas e taxas com "ausente ≠ zero" (NULL = o sensor não cobria a semana → "—"; 0 = medido e nada aconteceu).

export type CoberturaSemana = 'completa' | 'parcial' | 'ausente';
export type EstadoSensor = 'ok' | 'falhou' | 'parcial' | 'sem_dado_no_periodo' | 'sem_registro';

/** As colunas de contagem de cada (semana × vendedor), na ordem do funil. */
export const COLUNAS = [
  'email_enviados',
  'email_entregues',
  'email_falhos',
  'email_pendentes',
  'email_leads_entregues',
  'email_leads_clicados',
  'email_fichas',
  'card_dias',
  'card_leads_servidos',
  'card_leads_clicados',
  'card_fichas',
  'contatos',
  'contatos_empurrados',
  'cadastros_novos',
  'cadastros_novos_empurrados',
  'cadastros_vinculo',
] as const;
export type Coluna = (typeof COLUNAS)[number];
export type Contagens = Record<Coluna, number | null>;

/** Qual sensor cobre cada coluna (a cobertura da semana decide se a célula é "—" ou "parcial"). */
export const SENSOR_DA_COLUNA: Record<Coluna, string> = {
  email_enviados: 'email_envio',
  email_entregues: 'email_envio',
  email_falhos: 'email_envio',
  email_pendentes: 'email_envio',
  email_leads_entregues: 'email_envio',
  email_leads_clicados: 'abertura_email',
  email_fichas: 'ficha_email',
  card_dias: 'card_servido',
  card_leads_servidos: 'card_servido',
  card_leads_clicados: 'abertura_card',
  card_fichas: 'ficha_card',
  contatos: 'contato',
  contatos_empurrados: 'contato',
  cadastros_novos: 'cadastro',
  cadastros_novos_empurrados: 'cadastro',
  cadastros_vinculo: 'cadastro',
};

export interface LinhaFunil extends Contagens {
  semana: string;
  vendedorUserId: string;
}
export interface SemanaFunil {
  semana: string;
  corrente: boolean;
  cobertura: Record<string, CoberturaSemana>;
}
interface FalhaSensor {
  motivo: string;
  n: number;
}
export interface SensorFunil {
  sensor: string;
  rotulo: string;
  fonte: string;
  instaladoEm: string | null;
  coberturaDesde: string | null;
  ultimoRegistroEm: string | null;
  registrosPeriodo: number;
  falhasPeriodo: number;
  falhas: FalhaSensor[];
  estado: EstadoSensor;
}
interface VendedorFunil {
  userId: string;
  nome: string | null;
}
export interface PainelFunil {
  geradoEm: string;
  semanasPedidas: number;
  inicio: string;
  fim: string;
  semanas: SemanaFunil[];
  sensores: SensorFunil[];
  vendedores: VendedorFunil[];
  linhas: LinhaFunil[];
}

class FormaInvalida extends Error {
  constructor(onde: string) {
    super(`radar_funil: resposta fora da forma (${onde})`);
    this.name = 'FormaInvalida';
  }
}

function obj(v: unknown, onde: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new FormaInvalida(onde);
  return v as Record<string, unknown>;
}
function arr(v: unknown, onde: string): unknown[] {
  if (!Array.isArray(v)) throw new FormaInvalida(onde);
  return v;
}
function texto(v: unknown, onde: string): string {
  if (typeof v !== 'string' || v === '') throw new FormaInvalida(onde);
  return v;
}
function textoOuNull(v: unknown, onde: string): string | null {
  if (v === null || v === undefined) return null;
  return texto(v, onde);
}
function inteiro(v: unknown, onde: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new FormaInvalida(onde);
  return v;
}
/** NULL é dado (ausente); qualquer outra coisa que não seja inteiro ≥ 0 é erro — nunca vira 0 em silêncio. */
function inteiroOuNull(v: unknown, onde: string): number | null {
  if (v === null) return null;
  return inteiro(v, onde);
}

const ESTADOS: readonly EstadoSensor[] = ['ok', 'falhou', 'parcial', 'sem_dado_no_periodo', 'sem_registro'];
const COBERTURAS: readonly CoberturaSemana[] = ['completa', 'parcial', 'ausente'];

export function lerPainelFunil(data: unknown): PainelFunil {
  const d = obj(data, 'raiz');
  const semanas = arr(d.semanas, 'semanas').map((x, i) => {
    const s = obj(x, `semanas[${i}]`);
    const cob = obj(s.cobertura, `semanas[${i}].cobertura`);
    const cobertura: Record<string, CoberturaSemana> = {};
    for (const [k, v] of Object.entries(cob)) {
      if (!COBERTURAS.includes(v as CoberturaSemana)) throw new FormaInvalida(`semanas[${i}].cobertura.${k}`);
      cobertura[k] = v as CoberturaSemana;
    }
    if (typeof s.corrente !== 'boolean') throw new FormaInvalida(`semanas[${i}].corrente`);
    return { semana: texto(s.semana, `semanas[${i}].semana`), corrente: s.corrente, cobertura };
  });
  const sensores = arr(d.sensores, 'sensores').map((x, i) => {
    const s = obj(x, `sensores[${i}]`);
    if (!ESTADOS.includes(s.estado as EstadoSensor)) throw new FormaInvalida(`sensores[${i}].estado`);
    return {
      sensor: texto(s.sensor, `sensores[${i}].sensor`),
      rotulo: texto(s.rotulo, `sensores[${i}].rotulo`),
      fonte: texto(s.fonte, `sensores[${i}].fonte`),
      instaladoEm: textoOuNull(s.instalado_em, `sensores[${i}].instalado_em`),
      coberturaDesde: textoOuNull(s.cobertura_desde, `sensores[${i}].cobertura_desde`),
      ultimoRegistroEm: textoOuNull(s.ultimo_registro_em, `sensores[${i}].ultimo_registro_em`),
      registrosPeriodo: inteiro(s.registros_periodo, `sensores[${i}].registros_periodo`),
      falhasPeriodo: inteiro(s.falhas_periodo, `sensores[${i}].falhas_periodo`),
      falhas: arr(s.falhas, `sensores[${i}].falhas`).map((f, j) => {
        const o = obj(f, `sensores[${i}].falhas[${j}]`);
        return { motivo: texto(o.motivo, `sensores[${i}].falhas[${j}].motivo`), n: inteiro(o.n, `sensores[${i}].falhas[${j}].n`) };
      }),
      estado: s.estado as EstadoSensor,
    };
  });
  const vendedores = arr(d.vendedores, 'vendedores').map((x, i) => {
    const v = obj(x, `vendedores[${i}]`);
    return { userId: texto(v.user_id, `vendedores[${i}].user_id`), nome: textoOuNull(v.nome, `vendedores[${i}].nome`) };
  });
  const linhas = arr(d.linhas, 'linhas').map((x, i) => {
    const l = obj(x, `linhas[${i}]`);
    const c = {} as Contagens;
    for (const col of COLUNAS) c[col] = inteiroOuNull(l[col], `linhas[${i}].${col}`);
    return { semana: texto(l.semana, `linhas[${i}].semana`), vendedorUserId: texto(l.vendedor_user_id, `linhas[${i}].vendedor_user_id`), ...c };
  });
  return {
    geradoEm: texto(d.gerado_em, 'gerado_em'),
    semanasPedidas: inteiro(d.semanas_pedidas, 'semanas_pedidas'),
    inicio: texto(d.inicio, 'inicio'),
    fim: texto(d.fim, 'fim'),
    semanas,
    sensores,
    vendedores,
    linhas,
  };
}

/** Soma que respeita a ausência: tudo NULL → NULL ("—"); senão, a soma do que foi medido. */
export function somar(valores: readonly (number | null)[]): number | null {
  let total: number | null = null;
  for (const v of valores) if (v !== null) total = (total ?? 0) + v;
  return total;
}

/**
 * Soma de cada coluna sobre um conjunto de linhas. Com `cobertura`, coluna COBERTA sem nenhuma linha é 0 (o sensor
 * mediu e ninguém apareceu — ex.: nenhum vendedor no funil), e coluna AUSENTE é NULL mesmo que alguma linha traga
 * número. Sem `cobertura`, só a soma do que veio (tudo NULL → NULL).
 */
export function totalizar(linhas: readonly Contagens[], cobertura?: (col: Coluna) => CoberturaSemana): Contagens {
  const t = {} as Contagens;
  for (const col of COLUNAS) {
    const s = somar(linhas.map((l) => l[col]));
    t[col] = cobertura === undefined ? s : cobertura(col) === 'ausente' ? null : (s ?? 0);
  }
  return t;
}

/** Taxa num/den: sem denominador (NULL ou 0) ou sem numerador → NULL ("—"), nunca 0 % nem divisão por zero. */
export function taxa(num: number | null, den: number | null): number | null {
  if (num === null || den === null || den === 0) return null;
  return num / den;
}

/** Linhas de uma semana (todas ou de um vendedor). */
export function linhasDaSemana(p: PainelFunil, semana: string, vendedor: string | null): LinhaFunil[] {
  return p.linhas.filter((l) => l.semana === semana && (vendedor === null || l.vendedorUserId === vendedor));
}

/** Linhas de um vendedor no período inteiro. */
export function linhasDoVendedor(p: PainelFunil, vendedor: string): LinhaFunil[] {
  return p.linhas.filter((l) => l.vendedorUserId === vendedor);
}

/**
 * Pior cobertura entre as semanas de um recorte para o sensor de uma coluna: basta UMA semana ausente/parcial para
 * a soma do período não ser o período inteiro.
 */
export function coberturaDoPeriodo(p: PainelFunil, col: Coluna): CoberturaSemana {
  const sensor = SENSOR_DA_COLUNA[col];
  const estados = p.semanas.map((s) => s.cobertura[sensor] ?? 'ausente');
  if (estados.every((e) => e === 'ausente')) return 'ausente';
  if (estados.every((e) => e === 'completa')) return 'completa';
  return 'parcial';
}

export interface Inconsistencia {
  etapa: string;
  detalhe: string;
}

/**
 * Etapa seguinte maior que a anterior = sensor perdeu evento (o numerador ⊂ denominador por construção, exceto
 * onde dois sensores independentes se encontram: card servido × clique no card).
 */
export function inconsistencias(c: Contagens): Inconsistencia[] {
  const out: Inconsistencia[] = [];
  const maior = (a: number | null, b: number | null) => a !== null && b !== null && a > b;
  if (maior(c.card_leads_clicados, c.card_leads_servidos)) {
    out.push({
      etapa: 'card',
      detalhe: `${c.card_leads_clicados} clique(s) no card com só ${c.card_leads_servidos} lead(s) servido(s): o registro do card servido se perdeu`,
    });
  }
  if (maior(c.email_fichas, c.email_leads_clicados)) {
    out.push({ etapa: 'ficha_email', detalhe: 'mais fichas do que cliques no e-mail' });
  }
  if (maior(c.contatos_empurrados, c.contatos)) {
    out.push({ etapa: 'contato', detalhe: 'mais contatos em lead empurrado do que contatos' });
  }
  return out;
}

const nf = new Intl.NumberFormat('pt-BR');
const pf = new Intl.NumberFormat('pt-BR', { style: 'percent', maximumFractionDigits: 0 });
export const fmtContagem = (n: number | null): string => (n === null ? '—' : nf.format(n));
export const fmtTaxa = (t: number | null): string => (t === null ? '—' : pf.format(t));

/** "03/11" — a segunda-feira da semana, como o vendedor fala. */
export function rotuloSemana(semanaISO: string): string {
  const [, m, d] = semanaISO.split('-');
  return `${d}/${m}`;
}
