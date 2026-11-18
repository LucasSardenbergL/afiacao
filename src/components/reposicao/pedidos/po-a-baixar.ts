// Núcleo puro da fila "PO a baixar no Omie" (Fase 1 da baixa automática — spec baixa-pedido-compra §19).
// A RPC `reposicao_po_a_baixar` é a fonte; aqui só normalizamos na FRONTEIRA (a resposta entra por cast)
// e decidimos ordem e texto. Nada aqui escreve no Omie.

type TipoPoABaixar ='po_contado_com_nf' | 'nf_pendente';

export interface ItemPoABaixar {
  tipo: TipoPoABaixar;
  numeroPedido: string | null;
  fornecedorNome: string | null;
  /** Unidades que o motor ainda conta como "a caminho" (só po_contado_com_nf). Ausente ≠ zero. */
  unidadesContadas: number | null;
  numeroNfe: string | null;
  nidReceb: number | null;
  nfRecebidaEm: string | null;
  classe: string | null;
  motivos: string[];
  pedidosSugeridos: string[];
  evidenciaEm: string | null;
  evidenciaDesatualizada: boolean;
}

const TIPOS: readonly TipoPoABaixar[] = ['po_contado_com_nf', 'nf_pendente'];

/**
 * Negado pelo gate DESTA RPC (42501 + a sentinela dela). Sentinela própria, não a do PoSumidoCard: saber QUAL
 * gate negou separa "esta pessoa não vê compras" de "o GRANT desta RPC quebrou" (que é falha, e aparece).
 */
export function ehAcessoNegadoFila(erro: unknown): boolean {
  if (erro == null || typeof erro !== 'object') return false;
  const e = erro as { code?: unknown; message?: unknown };
  return e.code === '42501' && typeof e.message === 'string' && e.message.includes('reposicao_po_a_baixar: acesso negado');
}

function textoOuNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function numeroOuNull(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function listaDeTexto(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [];
}

/** Linha com tipo desconhecido é DESCARTADA (não adivinhamos a ação de um contrato que não conhecemos). */
export function normalizarFila(linhas: unknown): ItemPoABaixar[] {
  if (!Array.isArray(linhas)) return [];
  const out: ItemPoABaixar[] = [];
  for (const bruta of linhas) {
    if (bruta == null || typeof bruta !== 'object') continue;
    const r = bruta as Record<string, unknown>;
    if (!TIPOS.includes(r.tipo as TipoPoABaixar)) continue;
    out.push({
      tipo: r.tipo as TipoPoABaixar,
      numeroPedido: textoOuNull(r.numero_pedido),
      fornecedorNome: textoOuNull(r.fornecedor_nome),
      unidadesContadas: numeroOuNull(r.unidades_contadas),
      numeroNfe: textoOuNull(r.numero_nfe),
      nidReceb: numeroOuNull(r.nid_receb),
      nfRecebidaEm: textoOuNull(r.nf_recebida_em),
      classe: textoOuNull(r.classe),
      motivos: listaDeTexto(r.motivos),
      pedidosSugeridos: listaDeTexto(r.pedidos_sugeridos),
      evidenciaEm: textoOuNull(r.evidencia_em),
      // só `true` explícito marca; qualquer outra coisa não afirma frescor nem velhice — trata como velha
      // se a evidência nem veio (fail-closed: a tela pede conferência em vez de afirmar estado atual).
      evidenciaDesatualizada: r.evidencia_desatualizada === true || textoOuNull(r.evidencia_em) == null,
    });
  }
  return out;
}

function ts(iso: string | null): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
}

/**
 * Ordem: primeiro o money-path (PO contado com NF já recebida — o motor deixa de comprar), da NF mais
 * antiga para a mais nova; depois as NFs pendentes, evidência fresca antes da velha.
 */
export function ordenarFila(itens: ItemPoABaixar[]): ItemPoABaixar[] {
  return [...itens].sort((a, b) => {
    if (a.tipo !== b.tipo) return a.tipo === 'po_contado_com_nf' ? -1 : 1;
    if (a.tipo === 'po_contado_com_nf') return ts(a.nfRecebidaEm) - ts(b.nfRecebidaEm);
    if (a.evidenciaDesatualizada !== b.evidenciaDesatualizada) return a.evidenciaDesatualizada ? 1 : -1;
    return ts(a.evidenciaEm) - ts(b.evidenciaEm);
  });
}

export function resumirFila(itens: ItemPoABaixar[]): { contados: number; pendentes: number } {
  let contados = 0;
  let pendentes = 0;
  for (const i of itens) {
    if (i.tipo === 'po_contado_com_nf') contados++;
    else pendentes++;
  }
  return { contados, pendentes };
}

const MOTIVO_LEGIVEL: Record<string, string> = {
  quantidade_menor_que_saldo: 'entrega parcial (quantidade menor que o saldo do PO)',
  item_sem_par: 'item da NF sem item correspondente no PO',
  contrato_sem_po: 'protocolo da NF sem PO no Omie',
  produto_ilegivel: 'produto não identificado na NF',
  quantidade_ilegivel: 'quantidade não identificada na NF',
};

export function motivoLegivel(m: string): string {
  return MOTIVO_LEGIVEL[m] ?? m.replace(/_/g, ' ');
}

/** O que a pessoa faz no Omie. A tela nunca diz "encerre" sem a ressalva do parcial: encerrar é irreversível. */
export function passosDaAcao(item: ItemPoABaixar): string {
  if (item.tipo === 'po_contado_com_nf') {
    return `A NF ${item.numeroNfe ?? '(sem número)'} já entrou, mas o motor ainda conta o PO ${item.numeroPedido ?? ''} como "a caminho". ` +
      'Se a entrega foi TOTAL, encerre o PO no Omie. Se foi PARCIAL e o resto ainda vem, não faça nada.';
  }
  const pos = item.pedidosSugeridos.length > 0 ? `aos PO(s) ${item.pedidosSugeridos.join(', ')}` : 'ao PO correspondente';
  if (item.classe === 'orfa') {
    return 'NF pendente sem PO identificado. Ao concluir no Omie, procure o PO do fornecedor e associe; se não houver PO, siga sem associar.';
  }
  return `Ao concluir esta NF no Omie, associe os itens ${pos} na tela de recebimento (Associar Pedido).`;
}
