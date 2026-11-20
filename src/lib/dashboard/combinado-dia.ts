/**
 * "Combinado do dia" — o mecanismo de adoção do Meu dia do CEO (plano Fable+Codex, 2026-11-20).
 *
 * O app já lista recompra atrasada e cobrança vencida, mas nada vira ação: o time vive no Omie/WhatsApp.
 * O combinado escolhe até 3 clientes por vendedora (cobrança recente primeiro — é caixa; depois recompra e
 * cliente esfriando),
 * e gera o texto que o CEO encaminha no WhatsApp. A vendedora devolve o desfecho no mesmo fio. Puro.
 */
import type { FilaItem } from '@/lib/cobranca/cobranca-helpers';
import type { CompradorSugerido } from '@/lib/venda-cliente/sugestoes';
import { addDias } from '@/lib/time/sp-day';

const MAX_ITENS_COMBINADO = 3;

export interface ItemCombinado {
  tipo: 'cobranca' | 'recompra' | 'esfriando';
  empresa: string;
  /** Chave do cliente: código Omie (cobrança) ou user_id do cliente (recompra, esfriando) — para cruzar depois. */
  clienteRef: string;
  nome: string;
  /** Valor de referência: saldo vencido (cobrança), preço da recompra, ou o comprado em 12 meses (esfriando,
   *  histórico — não somar com os outros). `null` = desconhecido — o texto diz "a confirmar", nunca R$ 0. */
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

/** Pedido válido (status de venda, não apagado) — o que `clientesEsfriando` lê. */
export interface PedidoEsfriando {
  customer_user_id: string | null;
  total: number | null;
  order_date_kpi: string | null;
  account: string | null;
}

/** Cliente que comprou no último ano e parou: a 3ª fonte do combinado. */
export interface ClienteEsfriando {
  clienteId: string;
  /** Empresa da última compra. */
  empresa: string;
  ultimaCompra: string;
  diasSemCompra: number;
  /** Soma HISTÓRICA dos últimos 12 meses. `null` se algum pedido não tem total (ausente ≠ zero). Não é
   *  potencial de venda de hoje: não somar à recompra nem à cobrança. */
  receita12m: number | null;
}

/** Dias sem comprar a partir dos quais o cliente "esfria". */
const DIAS_ESFRIANDO = 90;

function diasEntre(deIso: string, ateIso: string): number {
  const d = (s: string) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  return Math.round((d(ateIso) - d(deIso)) / 86_400_000);
}

/**
 * Clientes com compra em [hoje − 365, hoje] cuja última compra tem MAIS de 90 dias. Recebe só pedidos válidos
 * (quem busca filtra status e `deleted_at`). Ordem: receita de 12 meses desc; desconhecida vai ao fim. Puro.
 */
export function clientesEsfriando(pedidos: PedidoEsfriando[], hoje: string): ClienteEsfriando[] {
  const inicio = addDias(hoje, -365);
  const porCliente = new Map<string, { ultima: string; empresa: string; receita: number | null }>();
  for (const p of pedidos) {
    const dia = p.order_date_kpi?.slice(0, 10);
    if (!p.customer_user_id || !dia || dia < inicio || dia > hoje) continue;
    const atual = porCliente.get(p.customer_user_id);
    const valor = p.total == null ? null : Number(p.total);
    if (!atual) {
      porCliente.set(p.customer_user_id, { ultima: dia, empresa: p.account ?? '', receita: valor });
      continue;
    }
    atual.receita = atual.receita == null || valor == null ? null : atual.receita + valor;
    if (dia > atual.ultima) {
      atual.ultima = dia;
      atual.empresa = p.account ?? atual.empresa;
    }
  }
  const out: ClienteEsfriando[] = [];
  for (const [clienteId, c] of porCliente) {
    const dias = diasEntre(c.ultima, hoje);
    if (dias > DIAS_ESFRIANDO) {
      out.push({ clienteId, empresa: c.empresa, ultimaCompra: c.ultima, diasSemCompra: dias, receita12m: c.receita });
    }
  }
  return out.sort((a, b) => {
    if (a.receita12m == null && b.receita12m == null) return a.clienteId.localeCompare(b.clienteId);
    if (a.receita12m == null) return 1;
    if (b.receita12m == null) return -1;
    return b.receita12m - a.receita12m || a.clienteId.localeCompare(b.clienteId);
  });
}

/**
 * Os esfriando da carteira da vendedora, sem quem já está na recompra dela (o mesmo cliente não aparece
 * duas vezes no combinado). `donos`: cliente → dono atual da carteira elegível. Puro.
 */
export function esfriandoDaVendedora(
  lista: ClienteEsfriando[],
  donos: Map<string, string>,
  vendedoraId: string,
  jaNaRecompra: ReadonlySet<string>,
): ClienteEsfriando[] {
  return lista.filter((c) => donos.get(c.clienteId) === vendedoraId && !jaNaRecompra.has(c.clienteId));
}

function itemEsfriando(c: ClienteEsfriando, nomes: ReadonlyMap<string, string>): ItemCombinado {
  const quanto = c.receita12m != null ? `comprou ${brl(c.receita12m)} em 12 meses` : 'valor dos 12 meses a confirmar';
  return {
    tipo: 'esfriando',
    empresa: c.empresa,
    clienteRef: c.clienteId,
    nome: nomes.get(c.clienteId) ?? 'cliente sem nome no cadastro',
    valor: c.receita12m,
    detalhe: `esfriando: sem comprar há ${c.diasSemCompra} dias · ${quanto}`,
  };
}

/**
 * Até 3 itens, em rodízio cobrança → recompra → esfriando (cobrança primeiro: é caixa). Fonte vazia passa a
 * vez para a próxima. Lista vazia é "nada a combinar" SÓ quando todas as fontes foram lidas — quem chama decide.
 */
export function montarCombinado(
  cobrancas: FilaItem[],
  recompras: CompradorSugerido[],
  esfriando: ClienteEsfriando[] = [],
  nomesEsfriando: ReadonlyMap<string, string> = new Map(),
): ItemCombinado[] {
  const fontes = [
    cobrancas.map(itemCobranca),
    recompras.map(itemRecompra),
    esfriando.map((c) => itemEsfriando(c, nomesEsfriando)),
  ];
  const pos = fontes.map(() => 0);
  const out: ItemCombinado[] = [];
  let vez = 0;
  while (out.length < MAX_ITENS_COMBINADO && fontes.some((f, k) => pos[k] < f.length)) {
    const k = vez % fontes.length;
    if (pos[k] < fontes[k].length) out.push(fontes[k][pos[k]++]);
    vez++;
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
