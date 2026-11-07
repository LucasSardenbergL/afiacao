/**
 * Plano de rateio do histórico de compras numa sucessão/cisão declarada (entrega 3: PR B = dados, PR C = esta tela).
 *
 * O gestor diz, por ITEM INTEIRO (empresa, código Omie), para qual empresa nova o histórico da antiga passa. Item sem
 * regra fica com a antiga; destino pendente (o CNPJ novo ainda sem cadastro) só passa a valer quando ficar ativo.
 * Cada publicação é uma revisão NOVA e imutável (versão otimista: `revisao` esperada); revogar é outra revisão.
 * Publicar e revogar só ENFILEIRAM o reprocesso: as sugestões de hoje se atualizam pelo cron, em até 1 minuto.
 *
 * Aqui só se LÊ a forma crua das RPCs (`cliente_sucessao_plano_do_evento`, `cliente_sucessao_plano_itens`) e se monta
 * o rascunho. Forma inesperada LANÇA: ausente ≠ "sem plano".
 */

type EstadoDestino = 'declarada' | 'ativa' | 'revogada';

export interface RegraVigente {
  empresa: string;
  omieCodigoProduto: number;
  descricao: string | null;
  novoDocumento: string;
  destinoSucessaoId: string;
  origem: 'item' | 'familia';
  familia: string | null;
  destinoEstado: EstadoDestino;
  destinoImpedimento: string | null;
}

export interface RevisaoPlano {
  revisao: number;
  revoga: boolean;
  motivo: string | null;
  publicadoPorNome: string | null;
  publicadoEm: string;
  regras: number;
}

export interface PlanoDoEvento {
  eventoId: string;
  /** 0 = nunca publicado. É a revisão esperada da próxima escrita. */
  revisao: number;
  revogado: boolean;
  regras: RegraVigente[];
  revisoes: RevisaoPlano[];
}

export interface ItemDaAntiga {
  empresa: string;
  omieCodigoProduto: number;
  descricao: string | null;
  familia: string | null;
  pedidos: number;
  ultimoPedido: string;
}

export interface DestinoDoEvento {
  destinoSucessaoId: string;
  novoDocumento: string;
  novoNome: string | null;
  estado: EstadoDestino;
  impedimento: string | null;
}

export interface ItensDoPlano {
  eventoId: string;
  /** false = o evento não tem mais declaração ativa (todas revogadas): nada a ratear. */
  ativo: boolean;
  tipo: 'cisao' | 'sucessao' | null;
  dataCorte: string | null;
  antigoDocumento: string | null;
  antigoNome: string | null;
  antigoResolvido: boolean;
  destinos: DestinoDoEvento[];
  itens: ItemDaAntiga[];
  /** O sensor do dia: sugestões da lista de HOJE que herdam deste evento, e quantas a farmer já viu. */
  sugestoesHoje: { herdadas: number; mostradas: number } | null;
}

const ESTADOS: readonly EstadoDestino[] = ['declarada', 'ativa', 'revogada'];
const ehTexto = (v: unknown): v is string => typeof v === 'string';
const textoOuNulo = (v: unknown): v is string | null => v === null || typeof v === 'string';
const ehInteiro = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

export function lerPlanoDoEvento(data: unknown): PlanoDoEvento {
  const rpc = 'cliente_sucessao_plano_do_evento';
  const r = obj(data);
  if (!r || !ehTexto(r.evento_id) || !ehInteiro(r.revisao) || typeof r.revogado !== 'boolean'
      || !Array.isArray(r.regras) || !Array.isArray(r.revisoes)) {
    throw new Error(`${rpc}: resposta fora da forma esperada`);
  }
  return {
    eventoId: r.evento_id, revisao: r.revisao, revogado: r.revogado,
    regras: r.regras.map((x) => {
      const g = obj(x);
      if (!g || !ehTexto(g.empresa) || !ehInteiro(g.omie_codigo_produto) || !textoOuNulo(g.descricao)
          || !ehTexto(g.novo_documento) || !ehTexto(g.destino_sucessao_id)
          || (g.origem !== 'item' && g.origem !== 'familia') || !textoOuNulo(g.familia)
          || !ESTADOS.includes(g.destino_estado as EstadoDestino) || !textoOuNulo(g.destino_impedimento)) {
        throw new Error(`${rpc}: regra fora da forma esperada`);
      }
      return {
        empresa: g.empresa, omieCodigoProduto: g.omie_codigo_produto, descricao: g.descricao,
        novoDocumento: g.novo_documento, destinoSucessaoId: g.destino_sucessao_id, origem: g.origem,
        familia: g.familia, destinoEstado: g.destino_estado as EstadoDestino, destinoImpedimento: g.destino_impedimento,
      };
    }),
    revisoes: r.revisoes.map((x) => {
      const v = obj(x);
      if (!v || !ehInteiro(v.revisao) || typeof v.revoga !== 'boolean' || !textoOuNulo(v.motivo)
          || !textoOuNulo(v.publicado_por_nome) || !ehTexto(v.publicado_em) || !ehInteiro(v.regras)) {
        throw new Error(`${rpc}: revisão fora da forma esperada`);
      }
      return {
        revisao: v.revisao, revoga: v.revoga, motivo: v.motivo, publicadoPorNome: v.publicado_por_nome,
        publicadoEm: v.publicado_em, regras: v.regras,
      };
    }),
  };
}

export function lerItensDoPlano(data: unknown): ItensDoPlano {
  const rpc = 'cliente_sucessao_plano_itens';
  const r = obj(data);
  if (!r || !ehTexto(r.evento_id) || typeof r.ativo !== 'boolean' || !Array.isArray(r.destinos) || !Array.isArray(r.itens)) {
    throw new Error(`${rpc}: resposta fora da forma esperada`);
  }
  if (r.ativo && (
    (r.tipo !== 'cisao' && r.tipo !== 'sucessao') || !ehTexto(r.data_corte) || !ehTexto(r.antigo_documento)
    || !textoOuNulo(r.antigo_nome) || typeof r.antigo_resolvido !== 'boolean'
  )) {
    throw new Error(`${rpc}: evento fora da forma esperada`);
  }
  const s = obj(r.sugestoes_hoje);
  if (r.ativo && (!s || !ehInteiro(s.herdadas) || !ehInteiro(s.mostradas))) {
    throw new Error(`${rpc}: sensor do dia fora da forma esperada`);
  }
  return {
    eventoId: r.evento_id, ativo: r.ativo,
    tipo: r.ativo ? (r.tipo as 'cisao' | 'sucessao') : null,
    dataCorte: r.ativo ? (r.data_corte as string) : null,
    antigoDocumento: r.ativo ? (r.antigo_documento as string) : null,
    antigoNome: r.ativo ? (r.antigo_nome as string | null) : null,
    antigoResolvido: r.ativo ? (r.antigo_resolvido as boolean) : false,
    destinos: r.destinos.map((x) => {
      const d = obj(x);
      if (!d || !ehTexto(d.destino_sucessao_id) || !ehTexto(d.novo_documento) || !textoOuNulo(d.novo_nome)
          || !ESTADOS.includes(d.estado as EstadoDestino) || !textoOuNulo(d.impedimento)) {
        throw new Error(`${rpc}: destino fora da forma esperada`);
      }
      return {
        destinoSucessaoId: d.destino_sucessao_id, novoDocumento: d.novo_documento, novoNome: d.novo_nome,
        estado: d.estado as EstadoDestino, impedimento: d.impedimento,
      };
    }),
    itens: r.itens.map((x) => {
      const i = obj(x);
      if (!i || !ehTexto(i.empresa) || !ehInteiro(i.omie_codigo_produto) || !textoOuNulo(i.descricao)
          || !textoOuNulo(i.familia) || !ehInteiro(i.pedidos) || !ehTexto(i.ultimo_pedido)) {
        throw new Error(`${rpc}: item fora da forma esperada`);
      }
      return {
        empresa: i.empresa, omieCodigoProduto: i.omie_codigo_produto, descricao: i.descricao, familia: i.familia,
        pedidos: i.pedidos, ultimoPedido: i.ultimo_pedido,
      };
    }),
    sugestoesHoje: s && ehInteiro(s.herdadas) && ehInteiro(s.mostradas)
      ? { herdadas: s.herdadas, mostradas: s.mostradas } : null,
  };
}

// ── Escrita ───────────────────────────────────────────────────────────────────────────────────────────────────

export type ResultadoPlano =
  | { ok: true; revisao: number }
  | { ok: false; motivo: string; revisao: number | null; detalhe: string | null };

/** Resultado de publicar/revogar. Recusa de domínio volta `ok:false` com motivo; erro de verdade LANÇA. */
export function lerResultadoPlano(data: unknown, rpc: string): ResultadoPlano {
  const r = obj(data);
  if (!r || typeof r.ok !== 'boolean') throw new Error(`${rpc}: resposta fora da forma esperada`);
  if (r.ok) {
    if (!ehInteiro(r.revisao)) throw new Error(`${rpc}: resposta sem a revisão nova`);
    return { ok: true, revisao: r.revisao };
  }
  if (!ehTexto(r.motivo)) throw new Error(`${rpc}: recusa sem motivo`);
  const itens = Array.isArray(r.itens)
    ? r.itens.map((x) => { const i = obj(x); return i ? `${i.empresa}:${i.omie_codigo_produto}` : '?'; }).join(', ')
    : null;
  const detalhe = ehTexto(r.documentos) ? r.documentos : ehTexto(r.familias) ? r.familias : itens;
  return { ok: false, motivo: r.motivo, revisao: ehInteiro(r.revisao) ? r.revisao : null, detalhe };
}

const TEXTO_RECUSA: Record<string, string> = {
  revisao_mudou: 'Outra pessoa publicou ou revogou este plano agora há pouco. Recarreguei: confira e publique de novo.',
  evento_sem_declaracao_ativa: 'Esta sucessão não tem mais declaração ativa: não há o que ratear.',
  antigo_nao_resolvido: 'O CNPJ antigo não aponta para um cliente único no cadastro: resolva o cadastro antes.',
  destino_fora_do_evento: 'Uma das empresas novas não está (mais) nesta sucessão',
  regra_conflitante: 'O mesmo item foi para duas empresas novas',
  familia_sem_itens: 'Uma família não tem item comprado pela antiga antes do corte',
  sem_plano: 'Não há plano vigente para revogar.',
};

export function mensagemRecusaPlano(r: Extract<ResultadoPlano, { ok: false }>): string {
  const base = TEXTO_RECUSA[r.motivo] ?? `Não foi possível gravar (${r.motivo}).`;
  return r.detalhe && !base.endsWith('.') ? `${base}: ${r.detalhe}.` : base.endsWith('.') ? base : `${base}.`;
}

/** O aviso honesto do efeito: a escrita só enfileira; o cron reprocessa. */
export const AVISO_REPROCESSO = 'As sugestões de hoje se atualizam em até 1 minuto.';

// ── Rascunho (o que a tela edita antes de publicar) ──────────────────────────────────────────────────────────

/** chave do item → documento do destino. Ausente = fica com a antiga. */
export type Rascunho = Record<string, string>;

export const chaveItem = (i: { empresa: string; omieCodigoProduto: number }) => `${i.empresa}:${i.omieCodigoProduto}`;

/** O rascunho inicial é o plano VIGENTE (revogado ou nunca publicado = tudo com a antiga). */
export function rascunhoDoPlano(p: PlanoDoEvento): Rascunho {
  if (p.revogado) return {};
  const r: Rascunho = {};
  for (const g of p.regras) r[chaveItem(g)] = g.novoDocumento;
  return r;
}

/** Aplica um destino (ou "fica com a antiga" = null) a todos os itens de uma família. */
export function aplicarFamilia(r: Rascunho, itens: ItemDaAntiga[], familia: string, destino: string | null): Rascunho {
  const novo = { ...r };
  for (const i of itens) {
    if (i.familia !== familia) continue;
    if (destino) novo[chaveItem(i)] = destino; else delete novo[chaveItem(i)];
  }
  return novo;
}

export function mesmoRascunho(a: Rascunho, b: Rascunho): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

/**
 * As regras para `cliente_sucessao_plano_publicar`: só ITENS explícitos (a família na tela já virou itens, com a
 * mesma base de "comprado antes do corte" que a expansão do servidor usa). Ordenadas, para o payload ser estável.
 * Item do rascunho que não está na lista da antiga (o plano antigo tinha um item que ela não comprou antes do corte)
 * segue junto: o servidor aceita item explícito.
 */
export function regrasDoRascunho(r: Rascunho): { empresa: string; omie_codigo_produto: number; novo_documento: string }[] {
  return Object.entries(r)
    .map(([k, doc]) => {
      const i = k.indexOf(':');
      return { empresa: k.slice(0, i), omie_codigo_produto: Number(k.slice(i + 1)), novo_documento: doc };
    })
    .sort((a, b) => a.empresa.localeCompare(b.empresa) || a.omie_codigo_produto - b.omie_codigo_produto);
}

/** "3 itens para MARQUES · 2 para NOVA DOIS · 5 ficam com a antiga". */
export function resumoRascunho(r: Rascunho, itens: ItemDaAntiga[], destinos: DestinoDoEvento[]): string {
  const nome = new Map(destinos.map((d) => [d.novoDocumento, d.novoNome ?? d.novoDocumento]));
  const por = new Map<string, number>();
  for (const doc of Object.values(r)) por.set(doc, (por.get(doc) ?? 0) + 1);
  const ficam = itens.filter((i) => !r[chaveItem(i)]).length;
  const partes = [...por.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([doc, n]) => `${n} ${n === 1 ? 'item' : 'itens'} para ${nome.get(doc) ?? doc}`);
  partes.push(`${ficam} ${ficam === 1 ? 'fica' : 'ficam'} com a antiga`);
  return partes.join(' · ');
}
