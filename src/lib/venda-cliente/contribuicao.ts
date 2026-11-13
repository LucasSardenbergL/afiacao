// Demonstrativo de contribuição (venda por cliente, rodada 2, entrega 3) — só o founder.
// Borda do `jsonb` de `public.venda_contribuicao` (migration 20261113130000) + regras puras de apresentação.
//
// Money-path (docs/agent/money-path.md §2): toda chave é SEMPRE montada pelo `jsonb_build_object` da RPC —
// chave AUSENTE é forma desconhecida e LANÇA; NULL só onde a RPC o produz (soma sem linha computável, % com
// denominador zero). O lançamento cai no `isError` do react-query: a tela mostra a falha, nunca um número.
import type { Json } from '@/integrations/supabase/types';

export const JANELAS = ['12m', '90d'] as const;
export type Janela = (typeof JANELAS)[number];
export const EIXOS = ['empresa', 'cliente', 'pedido', 'sku', 'familia', 'vendedor'] as const;
export type Eixo = (typeof EIXOS)[number];
export const ORDENS = ['contribuicao_asc', 'desconto_desc', 'custo_prazo_desc', 'gap_piso_desc', 'receita_desc'] as const;
export type Ordem = (typeof ORDENS)[number];
export const EMPRESAS = ['oben', 'colacor'] as const;
export type Empresa = (typeof EMPRESAS)[number];

/** Métricas de um agrupamento (total, empresa ou linha do eixo). R$ em reais; % em pontos percentuais. */
export interface MetricasContribuicao {
  itens: number;
  itens_sem_preco: number;
  itens_desconto_nao_apurado: number;
  itens_desconto_invalido: number;
  /** Receita BRUTA das linhas cuja líquida é desconhecida (desconto não apurado/inválido, sem preço). */
  receita_bruta_sem_liquida: number | null;
  itens_custo_data: number;
  itens_custo_atual: number;
  itens_sem_custo: number;
  receita_bruta: number | null;
  desconto: number | null;
  receita_liquida: number | null;
  receita_com_custo: number | null;
  receita_custo_atual: number | null;
  custo: number | null;
  margem_bruta: number | null;
  margem_bruta_pct: number | null;
  pedidos: number;
  pedidos_prazo_ok: number;
  pedidos_sem_titulo: number;
  pedidos_taxa_ausente: number;
  pedidos_prazo_rejeitado: number;
  receita_com_prazo: number | null;
  custo_prazo: number | null;
  custo_prazo_pct: number | null;
  prazo_medio_dias: number | null;
  receita_contribuicao: number | null;
  custo_contribuicao: number | null;
  custo_prazo_contribuicao: number | null;
  contribuicao: number | null;
  contribuicao_pct: number | null;
  itens_com_piso: number;
  itens_abaixo_piso: number;
  gap_piso: number | null;
}

export interface LinhaContribuicao extends MetricasContribuicao {
  chave: string;
  rotulo: string;
  detalhe: { [k: string]: Json | undefined };
}

export type Contribuicao =
  | { indisponivel: true; janela: Janela; desde: string; ate: string; eixo: Eixo; motivo: string }
  | {
      indisponivel: false;
      janela: Janela;
      desde: string;
      ate: string;
      eixo: Eixo;
      empresa: string | null;
      ordem: Ordem;
      limite: number;
      offset: number;
      taxaCapital: { oben: number | null; colacor: number | null };
      /** Sempre presente: o agrupamento `()` da RPC monta o total mesmo sem item (contagens 0, somas null). */
      total: MetricasContribuicao;
      porEmpresa: Record<string, MetricasContribuicao>;
      totalLinhas: number;
      linhas: LinhaContribuicao[];
    };

type Obj = { [k: string]: Json | undefined };
const ehObj = (v: Json | undefined): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function obj(v: Json | undefined, onde: string): Obj {
  if (!ehObj(v)) throw new Error(`${onde}: não é objeto`);
  return v;
}
function campo(o: Obj, k: string, onde: string): Json {
  const v = o[k];
  if (v === undefined) throw new Error(`${onde}: sem "${k}"`);
  return v;
}
function str(o: Obj, k: string, onde: string): string {
  const v = campo(o, k, onde);
  if (typeof v !== 'string') throw new Error(`${onde}: "${k}" não é texto`);
  return v;
}
function strOuNulo(o: Obj, k: string, onde: string): string | null {
  const v = campo(o, k, onde);
  if (v !== null && typeof v !== 'string') throw new Error(`${onde}: "${k}" não é texto`);
  return v;
}
function num(o: Obj, k: string, onde: string): number {
  const v = campo(o, k, onde);
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${onde}: "${k}" não é número`);
  return v;
}
function numOuNulo(o: Obj, k: string, onde: string): number | null {
  const v = campo(o, k, onde);
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${onde}: "${k}" não é número`);
  return v;
}
/** Contagem: inteiro seguro ≥ 0 (count(*) nunca é fração, negativo ou null). */
function contagemOk(o: Obj, k: string, onde: string): number {
  const v = num(o, k, onde);
  if (!Number.isSafeInteger(v) || v < 0) throw new Error(`${onde}: "${k}" não é contagem`);
  return v;
}
function bool(o: Obj, k: string, onde: string): boolean {
  const v = campo(o, k, onde);
  if (typeof v !== 'boolean') throw new Error(`${onde}: "${k}" não é booleano`);
  return v;
}
function umDe<T extends string>(valores: readonly T[], v: string, onde: string): T {
  if (!(valores as readonly string[]).includes(v)) throw new Error(`${onde}: valor fora do domínio "${v}"`);
  return v as T;
}

const CONTAGENS = [
  'itens', 'itens_sem_preco', 'itens_desconto_nao_apurado', 'itens_desconto_invalido', 'itens_custo_data',
  'itens_custo_atual', 'itens_sem_custo', 'pedidos', 'pedidos_prazo_ok', 'pedidos_sem_titulo',
  'pedidos_taxa_ausente', 'pedidos_prazo_rejeitado', 'itens_com_piso', 'itens_abaixo_piso',
] as const;
const VALORES = [
  'receita_bruta_sem_liquida', 'receita_bruta', 'desconto', 'receita_liquida', 'receita_com_custo',
  'receita_custo_atual', 'custo', 'margem_bruta', 'margem_bruta_pct', 'receita_com_prazo', 'custo_prazo',
  'custo_prazo_pct', 'prazo_medio_dias', 'receita_contribuicao', 'custo_contribuicao',
  'custo_prazo_contribuicao', 'contribuicao', 'contribuicao_pct', 'gap_piso',
] as const;

function metricas(v: Json | undefined, onde: string): MetricasContribuicao {
  const o = obj(v, onde);
  const m: Record<string, number | null> = {};
  for (const k of CONTAGENS) m[k] = contagemOk(o, k, onde);
  for (const k of VALORES) m[k] = numOuNulo(o, k, onde);
  return m as unknown as MetricasContribuicao;
}

/** Lê o retorno de `venda_contribuicao` por forma; qualquer desvio LANÇA. */
export function lerContribuicao(data: Json | undefined): Contribuicao {
  const o = obj(data, 'venda_contribuicao');
  const janela = umDe(JANELAS, str(o, 'janela', 'venda_contribuicao'), 'venda_contribuicao.janela');
  const eixo = umDe(EIXOS, str(o, 'eixo', 'venda_contribuicao'), 'venda_contribuicao.eixo');
  const desde = str(o, 'desde', 'venda_contribuicao');
  const ate = str(o, 'ate', 'venda_contribuicao');
  if (bool(o, 'indisponivel', 'venda_contribuicao')) {
    return { indisponivel: true, janela, eixo, desde, ate, motivo: str(o, 'motivo', 'venda_contribuicao') };
  }
  const taxa = obj(campo(o, 'taxa_capital', 'venda_contribuicao'), 'venda_contribuicao.taxa_capital');
  const porEmpresaObj = obj(campo(o, 'por_empresa', 'venda_contribuicao'), 'venda_contribuicao.por_empresa');
  const porEmpresa: Record<string, MetricasContribuicao> = {};
  for (const [k, v] of Object.entries(porEmpresaObj)) porEmpresa[k] = metricas(v, `por_empresa.${k}`);
  const linhasJson = campo(o, 'linhas', 'venda_contribuicao');
  if (!Array.isArray(linhasJson)) throw new Error('venda_contribuicao: "linhas" não é lista');
  const linhas = linhasJson.map((l, i): LinhaContribuicao => {
    const onde = `linhas[${i}]`;
    const lo = obj(l, onde);
    return {
      ...metricas(lo, onde),
      chave: str(lo, 'chave', onde),
      rotulo: str(lo, 'rotulo', onde),
      detalhe: obj(campo(lo, 'detalhe', onde), `${onde}.detalhe`),
    };
  });
  return {
    indisponivel: false,
    janela,
    eixo,
    desde,
    ate,
    empresa: strOuNulo(o, 'empresa', 'venda_contribuicao'),
    ordem: umDe(ORDENS, str(o, 'ordem', 'venda_contribuicao'), 'venda_contribuicao.ordem'),
    limite: contagemOk(o, 'limite', 'venda_contribuicao'),
    offset: contagemOk(o, 'offset', 'venda_contribuicao'),
    taxaCapital: {
      oben: numOuNulo(taxa, 'oben', 'taxa_capital'),
      colacor: numOuNulo(taxa, 'colacor', 'taxa_capital'),
    },
    total: metricas(campo(o, 'total', 'venda_contribuicao'), 'total'),
    porEmpresa,
    totalLinhas: contagemOk(o, 'total_linhas', 'venda_contribuicao'),
    linhas,
  };
}

/**
 * Fração de uma receita sobre outra, para rotular COBERTURA ("sobre 41% da receita").
 * null quando qualquer lado é desconhecido ou o denominador não é positivo — nunca 0% fabricado.
 */
export function fracao(parte: number | null, todo: number | null): number | null {
  if (parte === null || todo === null || !(todo > 0)) return null;
  return parte / todo;
}

/**
 * Situação da contribuição completa de um agrupamento — decide o que a tela diz quando não há número:
 *  - 'completa'  : há contribuição computada (sobre a interseção);
 *  - 'sem_taxa'  : há prazo identificado mas a empresa não tem taxa de capital configurada;
 *  - 'sem_prazo' : nenhum pedido com título casado;
 *  - 'sem_custo' : nenhum item com receita E custo conhecidos;
 *  - 'sem_intersecao': há custo e há prazo, mas em itens DIFERENTES — nenhum item reúne as três pernas.
 */
export type SituacaoContribuicao = 'completa' | 'sem_taxa' | 'sem_prazo' | 'sem_custo' | 'sem_intersecao';
export function situacaoContribuicao(m: MetricasContribuicao): SituacaoContribuicao {
  if (m.contribuicao !== null) return 'completa';
  if (m.receita_com_custo === null) return 'sem_custo';
  if (m.pedidos_prazo_ok > 0) return 'sem_intersecao';
  if (m.pedidos_taxa_ausente > 0) return 'sem_taxa';
  return 'sem_prazo';
}

export const ROTULO_EIXO: Record<Eixo, string> = {
  empresa: 'Empresa',
  cliente: 'Cliente',
  pedido: 'Pedido',
  sku: 'SKU',
  familia: 'Família',
  vendedor: 'Vendedor',
};

export const ROTULO_ORDEM: Record<Ordem, string> = {
  contribuicao_asc: 'Menor contribuição',
  desconto_desc: 'Mais desconto',
  custo_prazo_desc: 'Maior custo do prazo',
  gap_piso_desc: 'Maior gap ao piso',
  receita_desc: 'Maior receita',
};

const PP = new Intl.NumberFormat('pt-BR', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 });
const TAXA = new Intl.NumberFormat('pt-BR', { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const FRACAO = new Intl.NumberFormat('pt-BR', { style: 'percent', maximumFractionDigits: 0 });

/** Pontos percentuais da RPC (48.7) → "48,7%"; null → "—" (ausente, nunca 0%). */
export const formatarPp = (v: number | null): string => (v === null ? '—' : PP.format(v / 100));
/** Taxa anual em fração (0.1775) → "17,75%"; null → "—". */
export const formatarTaxa = (v: number | null): string => (v === null ? '—' : TAXA.format(v));
/** Cobertura de uma receita sobre outra ("41%"); denominador desconhecido/zero → "—". */
export function formatarCobertura(parte: number | null, todo: number | null): string {
  const f = fracao(parte, todo);
  return f === null ? '—' : FRACAO.format(f);
}
