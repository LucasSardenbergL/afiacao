// Radar H — o funil do lead empurrado (RPC radar_funil, migration 20261107233000). Puro: parser estrito da resposta,
// somas e taxas com "ausente ≠ zero" (NULL = o sensor não cobria a semana → "—"; 0 = medido e nada aconteceu).
// Pacote M (20261111134500): o universo de elegíveis e a adoção, as exibições do card (reposição incluída), a intenção
// de contato e o experimento da coorte (RPC radar_funil_experimento).

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
  'card_leads_exibidos',
  'card_leads_clicados_exibidos',
  'intencoes',
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
  card_leads_exibidos: 'card_exibido',
  card_leads_clicados_exibidos: 'card_exibido',
  intencoes: 'intencao',
};

/**
 * Colunas do pacote M: um banco anterior a ele não as manda (o Publish pode chegar antes da migration). Chave AUSENTE
 * vira NULL (o sensor não existe ali → "—"); chave presente segue o parser estrito.
 */
const COLUNAS_PACOTE_M: ReadonlySet<Coluna> = new Set(['card_leads_exibidos', 'card_leads_clicados_exibidos', 'intencoes']);

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
/** Adoção de um vendedor no período (pacote M). Datas ISO; NULL = não aconteceu no período. */
export interface AdocaoVendedor {
  userId: string;
  /** Tem a capability do Radar AGORA (a autorização histórica não é reconstruída). */
  elegivel: boolean;
  expostoEm: string | null;
  primeiraAcaoEm: string | null;
  ultimaAcaoEm: string | null;
  diasComAcao: number;
  acoes: number;
}
export interface AdocaoFunil {
  elegiveisAgora: number;
  vendedores: AdocaoVendedor[];
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
  /** NULL = banco anterior ao pacote M (sem o universo de elegíveis): a tela diz isso, não mostra 0. */
  adocao: AdocaoFunil | null;
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
    for (const col of COLUNAS) {
      c[col] = COLUNAS_PACOTE_M.has(col) && l[col] === undefined ? null : inteiroOuNull(l[col], `linhas[${i}].${col}`);
    }
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
    adocao: d.adocao === undefined ? null : lerAdocao(d.adocao),
  };
}

function booleano(v: unknown, onde: string): boolean {
  if (typeof v !== 'boolean') throw new FormaInvalida(onde);
  return v;
}

function lerAdocao(v: unknown): AdocaoFunil {
  const a = obj(v, 'adocao');
  return {
    elegiveisAgora: inteiro(a.elegiveis_agora, 'adocao.elegiveis_agora'),
    vendedores: arr(a.vendedores, 'adocao.vendedores').map((x, i) => {
      const o = obj(x, `adocao.vendedores[${i}]`);
      const onde = (k: string) => `adocao.vendedores[${i}].${k}`;
      return {
        userId: texto(o.user_id, onde('user_id')),
        elegivel: booleano(o.elegivel, onde('elegivel')),
        expostoEm: textoOuNull(o.exposto_em, onde('exposto_em')),
        primeiraAcaoEm: textoOuNull(o.primeira_acao_em, onde('primeira_acao_em')),
        ultimaAcaoEm: textoOuNull(o.ultima_acao_em, onde('ultima_acao_em')),
        diasComAcao: inteiro(o.dias_com_acao, onde('dias_com_acao')),
        acoes: inteiro(o.acoes, onde('acoes')),
      };
    }),
  };
}

/**
 * As 4 etapas da adoção, todas sobre o MESMO denominador (os elegíveis agora): elegível → exposto → 1ª ação humana
 * → uso em outro dia (ação em 2 dias ou mais). Quem agiu sem ser elegível hoje (perdeu o acesso) fica à parte.
 */
export interface EtapasAdocao {
  elegiveis: number;
  expostos: number;
  comAcao: number;
  voltaram: number;
  foraDoUniverso: number;
}
export function etapasAdocao(a: AdocaoFunil, vendedor: string | null = null): EtapasAdocao {
  const vs = a.vendedores.filter((v) => vendedor === null || v.userId === vendedor);
  const el = vs.filter((v) => v.elegivel);
  return {
    elegiveis: vendedor === null ? a.elegiveisAgora : el.length,
    expostos: el.filter((v) => v.expostoEm !== null).length,
    comAcao: el.filter((v) => v.primeiraAcaoEm !== null).length,
    voltaram: el.filter((v) => v.diasComAcao >= 2).length,
    foraDoUniverso: vs.filter((v) => !v.elegivel && v.primeiraAcaoEm !== null).length,
  };
}

/** Experimento da coorte (RPC radar_funil_experimento, pacote M): as leituras de 20261029150100, sem mudança. */
export interface CoorteResultado {
  sorteio: string;
  grupo: string;
  sorteados: number;
  tocados: number;
  emConversa: number;
  virouCliente: number;
  cadastrosNovos: number;
  sorteadaEm: string | null;
  diasDeAcompanhamento: number | null;
}
export interface FaixaConversao {
  faixa: string;
  leadsTocados: number;
  emConversa: number;
  virouCliente: number;
  cadastrosNovos: number;
}
export interface ExperimentoFunil {
  geradoEm: string;
  coortes: CoorteResultado[];
  faixas: FaixaConversao[];
}
export function lerExperimento(data: unknown): ExperimentoFunil {
  const d = obj(data, 'experimento');
  return {
    geradoEm: texto(d.gerado_em, 'experimento.gerado_em'),
    coortes: arr(d.coortes, 'coortes').map((x, i) => {
      const c = obj(x, `coortes[${i}]`);
      const onde = (k: string) => `coortes[${i}].${k}`;
      return {
        sorteio: texto(c.sorteio, onde('sorteio')),
        grupo: texto(c.grupo, onde('grupo')),
        sorteados: inteiro(c.sorteados, onde('sorteados')),
        tocados: inteiro(c.tocados, onde('tocados')),
        emConversa: inteiro(c.em_conversa, onde('em_conversa')),
        virouCliente: inteiro(c.virou_cliente, onde('virou_cliente')),
        cadastrosNovos: inteiro(c.cadastros_novos, onde('cadastros_novos')),
        sorteadaEm: textoOuNull(c.sorteada_em, onde('sorteada_em')),
        diasDeAcompanhamento: inteiroOuNull(c.dias_de_acompanhamento ?? null, onde('dias_de_acompanhamento')),
      };
    }),
    faixas: arr(d.faixas, 'faixas').map((x, i) => {
      const f = obj(x, `faixas[${i}]`);
      const onde = (k: string) => `faixas[${i}].${k}`;
      return {
        faixa: texto(f.faixa, onde('faixa')),
        leadsTocados: inteiro(f.leads_tocados, onde('leads_tocados')),
        emConversa: inteiro(f.em_conversa, onde('em_conversa')),
        virouCliente: inteiro(f.virou_cliente, onde('virou_cliente')),
        cadastrosNovos: inteiro(f.cadastros_novos, onde('cadastros_novos')),
      };
    }),
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
  if (c.card_leads_exibidos !== null) {
    // Pacote M: clicado ⊂ exibido por construção (mesmo CNPJ, mesmo dia). Maior = defeito do painel, não do uso.
    if (maior(c.card_leads_clicados_exibidos, c.card_leads_exibidos)) {
      out.push({ etapa: 'card', detalhe: 'mais leads clicados do que exibidos no card: defeito da leitura, avise' });
    }
  } else if (maior(c.card_leads_clicados, c.card_leads_servidos)) {
    out.push({
      etapa: 'card',
      detalhe: `${c.card_leads_clicados} clique(s) no card com só ${c.card_leads_servidos} lead(s) da 1ª exibição do dia: antes do sensor de exibição, o lead que entra depois de um Assumir não contava no denominador (não é perda do sensor)`,
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
