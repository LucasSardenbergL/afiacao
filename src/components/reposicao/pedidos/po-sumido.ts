// Decisões PURAS do card "pedido sem PO no Omie" (PR4 da reconciliação de PO excluído).
// A RPC `reposicao_pos_candidatos` LISTA e EVIDENCIA — não decide. Aqui traduzimos a evidência em uma
// SUGESTÃO de próximo passo para o humano, e o invariante é: NUNCA sugerir cancelamento automático.
//
// Por quê (a lição que custou 16 rodadas de review no PR2): "PO sumiu do Omie" NÃO prova "a compra não
// existe". O `disparar-pedidos-aprovados` aciona o PORTAL DO FORNECEDOR **antes** de criar o PO no Omie —
// em prod, 59/59 dos pedidos disparados têm canal de portal. Os 2 casos reais (281/286, Sayerlack,
// protocolos 2097501/2097910, ~R$3.060) têm o pedido VIVO no fornecedor e o PO ausente no Omie.
// Cancelar → o motor re-sugere → compra duplicada. Por isso a sugestão nunca é "cancelar".

/** Uma linha de `reposicao_pos_candidatos` (só os campos que o card usa). */
export interface PoCandidato {
  pedido_id: number;
  omie_codigo_pedido: string | null;
  data_ciclo: string;
  idade_dias: number;
  na_janela_7d: boolean;
  valor_total: number | null;
  visto_status: string;
  fornecedor_nome: string | null;
  canal_usado: string | null;
  portal_protocolo: string | null;
  status_envio_portal: string | null;
  algum_sinal_de_canal: boolean;
}

/**
 * A CLASSE da situação, derivada só da evidência que a RPC apurou. Separada do texto de propósito:
 * a lição que custou 4 rodadas no PR2 é que asserção sobre texto livre (regex semântica) é frágil e
 * mente. Aqui a LÓGICA é um discriminante binário — testável de verdade — e a copy é só a borda.
 * Reescrever a frase não quebra o teste de lógica; mudar a decisão, sim.
 *
 * Ordem importa: identidade ilegível vem primeiro porque, nesse caso, a RPC não conseguiu nem comparar
 * o PO — nada do resto da linha é conclusão segura.
 */
export type ClasseAcao =
  | 'identidade_ilegivel'
  | 'confirmar_com_protocolo'
  | 'confirmar_sem_protocolo'
  | 'conferir_no_omie';

export function classificarAcao(c: PoCandidato): ClasseAcao {
  if (c.visto_status === 'identidade_nao_interpretavel') return 'identidade_ilegivel';
  // Há indício de que o fornecedor foi acionado: a hipótese provável é que o PO foi excluído no Omie
  // por engano, e o pedido segue vivo lá fora. Recriar o PO alinha o sistema à realidade.
  if (c.algum_sinal_de_canal) {
    return c.portal_protocolo ? 'confirmar_com_protocolo' : 'confirmar_sem_protocolo';
  }
  return 'conferir_no_omie';
}

/** O texto mostrado ao humano. NUNCA instrui cancelar — ver o cabeçalho deste arquivo. */
export function acaoSugerida(c: PoCandidato): string {
  switch (classificarAcao(c)) {
    case 'identidade_ilegivel':
      return 'O código do PO neste pedido não é legível — corrija o cadastro antes de qualquer conclusão.';
    case 'confirmar_com_protocolo':
      return `Confirme com o fornecedor pelo protocolo ${c.portal_protocolo}. Se o pedido existe lá, recrie o PO no Omie — não cancele.`;
    case 'confirmar_sem_protocolo':
      return 'Há sinal de envio ao fornecedor. Confirme com ele antes de agir; se o pedido existe, recrie o PO no Omie.';
    case 'conferir_no_omie':
      return 'Sem sinal de envio ao fornecedor. Confira no Omie se o PO foi excluído e decida com o histórico do pedido.';
  }
}

/**
 * O gate da RPC barrou (SQLSTATE 42501). Isso NÃO é falha de apuração: é ausência de permissão —
 * quem não pode ver a carteira completa simplesmente não vê o card, sem aviso de erro.
 * Qualquer OUTRO erro é falha de apuração e PRECISA aparecer: senão "não consegui apurar" se
 * disfarça de "não há nada", que é exatamente o bug fantasma que este PR existe para expor.
 */
export function ehAcessoNegado(erro: unknown): boolean {
  if (erro == null || typeof erro !== 'object') return false;
  return (erro as { code?: unknown }).code === '42501';
}

/** Ordena para leitura humana: o que ainda causa dano (janela 7d) primeiro, depois o mais caro. */
export function ordenarCandidatos(cs: readonly PoCandidato[]): PoCandidato[] {
  return [...cs].sort((a, b) => {
    if (a.na_janela_7d !== b.na_janela_7d) return a.na_janela_7d ? -1 : 1;
    // valor desconhecido (null) vai por último — não é "zero", é ausência (money-path: ausente ≠ zero).
    const va = a.valor_total ?? -Infinity;
    const vb = b.valor_total ?? -Infinity;
    if (va !== vb) return vb - va;
    return a.pedido_id - b.pedido_id;
  });
}
