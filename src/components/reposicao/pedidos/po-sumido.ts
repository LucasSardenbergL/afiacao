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
      return 'O código do PO neste pedido não é legível — não foi possível comparar com o Omie. Corrija o cadastro antes de qualquer conclusão.';
    case 'confirmar_com_protocolo':
      return `Confirme com o fornecedor pelo protocolo ${c.portal_protocolo}. Se o pedido existe lá, recrie o PO no Omie — não cancele.`;
    case 'confirmar_sem_protocolo':
      return 'Há sinal de envio ao fornecedor. Confirme com ele antes de agir; se o pedido existe, recrie o PO no Omie.';
    case 'conferir_no_omie':
      return 'Nenhum sinal de envio registrado aqui. Confira no Omie se o PO foi excluído e decida com o histórico do pedido.';
  }
}

/**
 * O gate da RPC barrou. Só conta como "negado" o 42501 que a NOSSA função levanta — identificado pela
 * sentinela da mensagem, como o precedente de `parsePostgresFinanceiroError` (P0001 + 'PERIOD_LOCKED:').
 *
 * Checar só o SQLSTATE seria falha ABERTA ao contrário: um `GRANT EXECUTE` quebrado também devolve
 * 42501 ('permission denied for function ...') e o card sumiria para TODO MUNDO em silêncio — o
 * detector cego parecendo saudável, que é exatamente o bug que este PR existe para expor. Com a
 * sentinela, esse caso cai em "não apurei" (aviso visível). Erra para o lado de gritar demais.
 */
const SENTINELA_GATE = 'reposicao_pos_candidatos: acesso negado';

export function ehAcessoNegado(erro: unknown): boolean {
  if (erro == null || typeof erro !== 'object') return false;
  const e = erro as { code?: unknown; message?: unknown };
  return e.code === '42501' && typeof e.message === 'string' && e.message.includes(SENTINELA_GATE);
}

/**
 * Normaliza o que veio da RPC ANTES de qualquer conta. A resposta chega por um cast (`as never`,
 * porque a função ainda não está no types.ts gerado), então nada garante que `valor_total` seja um
 * número finito. Um `NaN` que passe daqui contamina tudo em silêncio: `NaN != null` é true, então
 * entraria na soma como se fosse valor apurado (total NaN), e no comparador `NaN !== NaN` devolve NaN,
 * que o sort lê como EMPATE — a lista sai fora de ordem sem erro nenhum.
 *
 * Valor não-finito vira null, que é exatamente o que ele significa: não apurado.
 */
export function normalizarCandidatos(cs: readonly PoCandidato[]): PoCandidato[] {
  return cs.map((c) =>
    typeof c.valor_total === 'number' && Number.isFinite(c.valor_total)
      ? c
      : { ...c, valor_total: null },
  );
}

/** Como apresentar a soma dos valores sem inventar número. */
export type ResumoValor =
  | { tipo: 'vazio' }
  | { tipo: 'nao_apurado' }
  | { tipo: 'parcial'; total: number; comValor: number; semValor: number }
  | { tipo: 'completo'; total: number };

/**
 * Money-path: ausente ≠ zero. Se NENHUM pedido tem valor apurado, o resultado é "não apurado" — e não
 * R$ 0,00. `[].reduce(soma, 0)` devolvendo zero é fabricação: zero afirma "não há dinheiro em jogo",
 * quando a verdade é "não sabemos quanto". Caso misto vira SUBTOTAL declarado, nunca "total".
 *
 * `vazio` existe separado de `nao_apurado` porque são perguntas diferentes: "não há pedido nenhum" vs.
 * "há pedidos e nenhum está precificado". Hoje o card só chama com lista não-vazia, mas a função é
 * exportada — colapsar os dois deixaria bomba armada para o próximo consumidor.
 */
export function resumirValores(cs: readonly PoCandidato[]): ResumoValor {
  if (cs.length === 0) return { tipo: 'vazio' };
  const comValor = cs.filter((c) => c.valor_total != null);
  if (comValor.length === 0) return { tipo: 'nao_apurado' };
  const total = comValor.reduce((s, c) => s + Number(c.valor_total), 0);
  if (comValor.length === cs.length) return { tipo: 'completo', total };
  return { tipo: 'parcial', total, comValor: comValor.length, semValor: cs.length - comValor.length };
}

/** Quantas linhas a RPC não conseguiu sequer comparar com o Omie (identidade do PO ilegível). */
export function contarIlegiveis(cs: readonly PoCandidato[]): number {
  return cs.filter((c) => c.visto_status === 'identidade_nao_interpretavel').length;
}

/**
 * Ordena para leitura humana: o que ainda causa dano (janela 7d) primeiro; dentro do grupo, o de maior
 * valor — e o de valor DESCONHECIDO no topo, não no fim.
 *
 * Mandar o desconhecido para o fim (a 1ª versão fazia isso) trata "não sei quanto vale" como "vale
 * pouco". É o mesmo erro de tratar null como zero, só que na ordenação: `valor_total` é NULL quando
 * algum item não tem preço, então esse pedido pode ser o MAIOR da lista — e ainda carrega um segundo
 * problema de cadastro. Incerteza pede atenção, não rodapé.
 */
export function ordenarCandidatos(cs: readonly PoCandidato[]): PoCandidato[] {
  return [...cs].sort((a, b) => {
    if (a.na_janela_7d !== b.na_janela_7d) return a.na_janela_7d ? -1 : 1;
    const va = a.valor_total ?? Infinity;
    const vb = b.valor_total ?? Infinity;
    if (va !== vb) return vb - va; // maior primeiro; Infinity (desconhecido) encabeça o grupo
    return a.pedido_id - b.pedido_id;
  });
}
