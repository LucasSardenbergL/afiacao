/**
 * "Combinado do dia" — o mecanismo de adoção do Meu dia do CEO (plano Fable+Codex, 2026-11-20).
 *
 * O app já lista recompra atrasada e cobrança vencida, mas nada vira ação: o time vive no Omie/WhatsApp.
 * O combinado escolhe até 3 clientes por vendedora (cobrança recente primeiro — é caixa; depois recompra),
 * e gera o texto que o CEO encaminha no WhatsApp. A vendedora devolve o desfecho no mesmo fio. Puro.
 */
import type { FilaItem } from '@/lib/cobranca/cobranca-helpers';
import type { CompradorSugerido } from '@/lib/venda-cliente/sugestoes';

const MAX_ITENS_COMBINADO = 3;

export interface ItemCombinado {
  tipo: 'cobranca' | 'recompra';
  empresa: string;
  /** Chave do cliente: código Omie (cobrança) ou user_id do comprador (recompra) — para cruzar depois. */
  clienteRef: string;
  nome: string;
  /** Valor de referência. `null` = desconhecido (recompra sem preço) — o texto diz "valor a confirmar", nunca R$ 0. */
  valor: number | null;
  /** Uma linha legível: o que fazer com o cliente. */
  detalhe: string;
}

/** Estados em que a cobrança ainda espera um contato (promessa/negociação/disputa já têm dono do próximo passo). */
const ESTADOS_COBRAVEIS = new Set(['a_contatar', 'contatado']);

/**
 * Cobrança da vendedora que vale contato HOJE: dona = ela, até 45 dias (a faixa que ainda se recupera por
 * conversa), com saldo vencido conhecido, sem promessa aberta e sem próximo contato agendado para depois.
 * Maior saldo primeiro.
 */
export function cobrancasDoDia(fila: FilaItem[], vendedoraId: string, hoje: string): FilaItem[] {
  return fila
    .filter(
      (f) =>
        f.donaUserId === vendedoraId &&
        f.faixa === '<=45d' &&
        ESTADOS_COBRAVEIS.has(f.estado) &&
        f.saldoVencido != null &&
        f.saldoVencido > 0 &&
        f.promessaSituacao !== 'aberta' &&
        (f.proximoContatoEm == null || f.proximoContatoEm.slice(0, 10) <= hoje),
    )
    .sort((a, b) => (b.saldoVencido ?? 0) - (a.saldoVencido ?? 0) || a.omieCodigoCliente - b.omieCodigoCliente);
}

/**
 * Só as sugestões de RECOMPRA (as ondas de complemento/sistema vêm na mesma resposta e não são "atrasado"),
 * com o valor recalculado sobre elas: soma dos `valorRef`, `null` se QUALQUER uma não tem valor (mesma regra
 * da RPC — ausente ≠ zero). Ordem: valor desc; sem valor vai ao fim.
 */
export function recomprasDoDia(compradores: CompradorSugerido[]): CompradorSugerido[] {
  return compradores
    .map((c): CompradorSugerido => {
      const sugestoes = c.sugestoes.filter((s) => s.tipo === 'recompra');
      const valorRefTotal = sugestoes.some((s) => s.valorRef == null)
        ? null
        : sugestoes.reduce((t, s) => t + (s.valorRef as number), 0);
      return { ...c, sugestoes, valorRefTotal };
    })
    .filter((c) => c.sugestoes.length > 0)
    .sort((a, b) => {
      if (a.valorRefTotal == null && b.valorRefTotal == null) return a.compradorId.localeCompare(b.compradorId);
      if (a.valorRefTotal == null) return 1;
      if (b.valorRefTotal == null) return -1;
      return b.valorRefTotal - a.valorRefTotal || a.compradorId.localeCompare(b.compradorId);
    });
}

const brl = (v: number): string => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function itemCobranca(f: FilaItem): ItemCombinado {
  const dias = f.diasVencidoMax != null ? `, até ${f.diasVencidoMax} dias` : '';
  return {
    tipo: 'cobranca',
    empresa: f.company,
    clienteRef: String(f.omieCodigoCliente),
    nome: f.nomeCliente ?? `cliente Omie ${f.omieCodigoCliente}`,
    valor: f.saldoVencido,
    detalhe: `cobrar ${brl(f.saldoVencido ?? 0)} vencido${dias}`,
  };
}

function itemRecompra(c: CompradorSugerido): ItemCombinado {
  const [primeira, ...resto] = c.sugestoes;
  const produto = primeira.descricao ?? 'item da última compra';
  const mais = resto.length > 0 ? ` e mais ${resto.length} ${resto.length === 1 ? 'item' : 'itens'}` : '';
  const valor = c.valorRefTotal != null ? ` · ref. ${brl(c.valorRefTotal)}` : ' · valor a confirmar';
  return {
    tipo: 'recompra',
    empresa: primeira.empresa,
    clienteRef: c.compradorId,
    nome: c.nome ?? 'cliente sem nome no cadastro',
    valor: c.valorRefTotal,
    detalhe: `recompra atrasada: ${produto}${mais}${valor}`,
  };
}

/**
 * Até 3 itens, alternando cobrança e recompra (cobrança primeiro: é caixa). Se uma lista acaba, a outra
 * completa. Lista vazia é "nada a combinar" SÓ quando as duas fontes foram lidas — quem chama decide isso.
 */
export function montarCombinado(cobrancas: FilaItem[], recompras: CompradorSugerido[]): ItemCombinado[] {
  const c = cobrancas.map(itemCobranca);
  const r = recompras.map(itemRecompra);
  const out: ItemCombinado[] = [];
  let i = 0;
  let j = 0;
  while (out.length < MAX_ITENS_COMBINADO && (i < c.length || j < r.length)) {
    const vezDaCobranca = out.length % 2 === 0;
    if ((vezDaCobranca && i < c.length) || j >= r.length) out.push(c[i++]);
    else out.push(r[j++]);
  }
  return out;
}

/** dd/mm a partir de YYYY-MM-DD. */
function ddmm(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

/** Texto pronto para o CEO colar no WhatsApp da vendedora. */
export function textoCombinado(opts: {
  vendedora: string;
  hoje: string;
  itens: ItemCombinado[];
  nomeEmpresa: (codigo: string) => string;
  linkApp: string;
}): string {
  const primeiroNome = opts.vendedora.split(/\s+/)[0] ?? opts.vendedora;
  const linhas = opts.itens.map(
    (it, k) => `${k + 1}. ${it.nome} (${opts.nomeEmpresa(it.empresa)}): ${it.detalhe}`,
  );
  return [
    `Combinado de hoje (${ddmm(opts.hoje)}), ${primeiroNome}:`,
    '',
    ...linhas,
    '',
    'Me devolve o desfecho de cada um até o fim do dia (falou? fechou? prometeu pagar quando?).',
    `Detalhes no app: ${opts.linkApp}`,
  ].join('\n');
}
