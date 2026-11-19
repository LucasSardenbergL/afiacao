// Núcleo puro da fila "PO a baixar no Omie" (Fase 1 da baixa automática — spec baixa-pedido-compra §19).
// A RPC `reposicao_po_a_baixar_v2` é a fonte; aqui só normalizamos na FRONTEIRA (a resposta entra por cast)
// e decidimos ordem e texto. Nada aqui escreve no Omie.

type TipoPoABaixar ='po_contado_com_nf' | 'nf_pendente';

/** Par item a item que a sombra já calculou (seq. da NF → item do PO), pronto para copiar no "Associar Pedido". */
export interface ParPoABaixar {
  seqNf: number | null;
  numeroPedido: string | null;
  /** Posição do item na lista do PO no espelho (1 = primeiro). */
  itemPo: number | null;
  codigoProduto: string | null;
  descricao: string | null;
  /** Ausente ≠ zero: quantidade ilegível sai null e a tela mostra "—". */
  quantidade: number | null;
  unidade: string | null;
  cobertura: 'total' | 'parcial' | null;
}

export type DecisaoPoABaixar = 'associei' | 'encerrei' | 'parcial_aguardo_saldo' | 'nao_se_aplica';

export interface ItemPoABaixar {
  tipo: TipoPoABaixar;
  /** Identidade do item na fila: omie_codigo_pedido (PO) ou nid_receb (NF), em texto. */
  chave: string | null;
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
  /** Só para `associavel` com evidência fresca; `null` = sem par a copiar (candidatos + motivos). */
  pares: ParPoABaixar[] | null;
  evidenciaEm: string | null;
  evidenciaDesatualizada: boolean;
  /** Versão do que a tela mostra como proposta — vai junto da decisão (o servidor recusa se mudou). */
  propostaVersao: string | null;
  decisaoVigente: DecisaoPoABaixar | null;
  decisaoVigenteEm: string | null;
}

const TIPOS: readonly TipoPoABaixar[] = ['po_contado_com_nf', 'nf_pendente'];

/**
 * Negado pelo gate DESTA RPC (42501 + a sentinela dela). Sentinela própria, não a do PoSumidoCard: saber QUAL
 * gate negou separa "esta pessoa não vê compras" de "o GRANT desta RPC quebrou" (que é falha, e aparece).
 */
export function ehAcessoNegadoFila(erro: unknown): boolean {
  if (erro == null || typeof erro !== 'object') return false;
  const e = erro as { code?: unknown; message?: unknown; cause?: unknown };
  if (e.code === '42501' && typeof e.message === 'string' && e.message.includes('reposicao_po_a_baixar: acesso negado')) {
    return true;
  }
  // a leitura é paginada: o fetchAllPages embrulha o erro do PostgREST como `cause` (1 nível, sem recursão)
  if (e.cause != null && typeof e.cause === 'object') {
    const c = e.cause as { code?: unknown; message?: unknown };
    return c.code === '42501' && typeof c.message === 'string' && c.message.includes('reposicao_po_a_baixar: acesso negado');
  }
  return false;
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

const DECISOES: readonly DecisaoPoABaixar[] = ['associei', 'encerrei', 'parcial_aguardo_saldo', 'nao_se_aplica'];

function decisaoOuNull(v: unknown): DecisaoPoABaixar | null {
  return DECISOES.includes(v as DecisaoPoABaixar) ? (v as DecisaoPoABaixar) : null;
}

/** `null` (não veio par) é diferente de `[]` (veio lista vazia); par malformado é descartado, não adivinhado. */
function normalizarPares(v: unknown): ParPoABaixar[] | null {
  if (!Array.isArray(v)) return null;
  const out: ParPoABaixar[] = [];
  for (const bruto of v) {
    if (bruto == null || typeof bruto !== 'object') continue;
    const p = bruto as Record<string, unknown>;
    const cobertura = p.cobertura === 'total' || p.cobertura === 'parcial' ? p.cobertura : null;
    out.push({
      seqNf: numeroOuNull(p.seq_nf),
      numeroPedido: textoOuNull(p.numero_pedido),
      itemPo: numeroOuNull(p.item_po),
      codigoProduto: textoOuNull(p.codigo_produto),
      descricao: textoOuNull(p.descricao),
      quantidade: numeroOuNull(p.quantidade),
      unidade: textoOuNull(p.unidade),
      cobertura,
    });
  }
  return out;
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
      chave: textoOuNull(r.chave),
      numeroPedido: textoOuNull(r.numero_pedido),
      fornecedorNome: textoOuNull(r.fornecedor_nome),
      unidadesContadas: numeroOuNull(r.unidades_contadas),
      numeroNfe: textoOuNull(r.numero_nfe),
      nidReceb: numeroOuNull(r.nid_receb),
      nfRecebidaEm: textoOuNull(r.nf_recebida_em),
      classe: textoOuNull(r.classe),
      motivos: listaDeTexto(r.motivos),
      pedidosSugeridos: listaDeTexto(r.pedidos_sugeridos),
      pares: normalizarPares(r.pares),
      evidenciaEm: textoOuNull(r.evidencia_em),
      // só `true` explícito marca; qualquer outra coisa não afirma frescor nem velhice — trata como velha
      // se a evidência nem veio (fail-closed: a tela pede conferência em vez de afirmar estado atual).
      evidenciaDesatualizada: r.evidencia_desatualizada === true || textoOuNull(r.evidencia_em) == null,
      propostaVersao: textoOuNull(r.proposta_versao),
      decisaoVigente: decisaoOuNull(r.decisao_vigente),
      decisaoVigenteEm: textoOuNull(r.decisao_vigente_em),
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

// Todos os motivos que o classificador da sombra emite (supabase/functions/omie-sync-nfes-recebidas/associacao.ts).
// Motivo novo sem tradução cai no fallback (sublinhado → espaço): legível, nunca escondido.
const MOTIVO_LEGIVEL: Record<string, string> = {
  quantidade_menor_que_saldo: 'entrega parcial (quantidade menor que o saldo do PO)',
  excesso_sobre_saldo: 'quantidade da NF maior que o saldo do PO',
  item_sem_par: 'item da NF sem item correspondente no PO',
  nenhum_par: 'nenhum item da NF casou com o PO',
  item_sem_contrato: 'item da NF sem número de pedido (protocolo) do fornecedor',
  contrato_sem_po: 'protocolo da NF sem PO no Omie',
  contrato_em_varios_pos: 'o mesmo protocolo aparece em mais de um PO',
  contrato_composto: 'protocolo com mais de um pedido no mesmo campo (ex.: "123/456")',
  sku_com_equivalencia_de_embalagem: 'produto com conversão de embalagem (confira a quantidade na unidade do PO)',
  equivalencia_nao_lida: 'não foi possível ler as conversões de embalagem',
  unidade_divergente: 'unidade da NF diferente da unidade do PO',
  unidade_ilegivel: 'unidade não identificada',
  item_nao_movimenta_estoque: 'item marcado para não movimentar estoque',
  mov_estoque_ilegivel: 'não foi possível ler se o item movimenta estoque',
  produto_ilegivel: 'produto não identificado na NF',
  produto_repetido_no_po: 'o mesmo produto aparece mais de uma vez no PO',
  quantidade_ilegivel: 'quantidade não identificada na NF',
  po_fora_da_etapa_aberta: 'PO não está mais em aberto no Omie',
  po_sem_itens: 'PO sem itens no espelho',
  po_ilegivel: 'PO ilegível no espelho',
  po_recebido_acima_do_pedido: 'PO já recebido acima do pedido',
  pedidos_nao_consultados: 'os POs do fornecedor ainda não foram lidos',
  fornecedor_ilegivel: 'fornecedor não identificado na NF',
  nf_sem_itens: 'NF sem itens',
  nf_sem_itens_ativos: 'todos os itens da NF estão ignorados',
  nf_devolvida: 'NF devolvida',
  item_devolvido: 'item devolvido',
  devolucao_ilegivel: 'não foi possível ler a devolução',
  item_ignorar_ilegivel: 'não foi possível ler se o item é ignorado',
  vinculo_ilegivel: 'não foi possível ler o vínculo do item com o PO',
  sequencia_ilegivel: 'sequência do item ilegível na NF',
  sequencia_duplicada: 'sequência de item repetida na NF',
};

export function motivoLegivel(m: string): string {
  return MOTIVO_LEGIVEL[m] ?? m.replace(/_/g, ' ');
}

/** O que a equipe pode declarar, por tipo: `encerrei` só faz sentido para PO, `associei` só para NF (o banco recusa o resto). */
export function decisoesDoTipo(tipo: TipoPoABaixar): DecisaoPoABaixar[] {
  return tipo === 'po_contado_com_nf'
    ? ['encerrei', 'parcial_aguardo_saldo', 'nao_se_aplica']
    : ['associei', 'parcial_aguardo_saldo', 'nao_se_aplica'];
}

const DECISAO_LEGIVEL: Record<DecisaoPoABaixar, string> = {
  associei: 'Associei no Omie',
  encerrei: 'Encerrei no Omie',
  parcial_aguardo_saldo: 'Parcial — aguardo saldo',
  nao_se_aplica: 'Não se aplica',
};

export function decisaoLegivel(d: DecisaoPoABaixar): string {
  return DECISAO_LEGIVEL[d];
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

/**
 * Recusa ESPERADA do registro de decisão → frase para a equipe. `null` = não é recusa de domínio (é falha: o caller
 * mostra a mensagem crua). As SQLSTATEs vêm da RPC `reposicao_po_a_baixar_registrar_decisao`.
 */
export function recusaDaDecisao(erro: unknown): string | null {
  if (erro == null || typeof erro !== 'object') return null;
  const code = (erro as { code?: unknown }).code;
  if (code === 'PB001') return 'Este item já saiu da fila (o Omie foi relido). A lista foi atualizada.';
  if (code === 'PB002') return 'A proposta mudou desde que você abriu a lista. Confira os pares de novo antes de marcar.';
  if (code === '42501') return 'Você não tem permissão para registrar decisões de compras.';
  return null;
}
