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

/**
 * As operações que o card pode sugerir. O universo é FECHADO e não inclui nenhuma forma de desfazer o
 * pedido — o invariante "nunca instruir cancelamento" passa a valer por CONSTRUÇÃO, não por inspeção de
 * texto. (A versão anterior fixava as 4 frases por igualdade exata; isso é golden test de copy, que
 * alguém atualiza mecanicamente junto com a implementação — sentinela útil, garantia nenhuma.)
 */
export type Operacao =
  | 'corrigir_cadastro'
  | 'confirmar_fornecedor'
  | 'confirmar_ausencia_de_qualquer_po'
  | 'recriar_po'
  | 'conferir_no_omie';

/** Precondições de cada operação: nenhuma delas pode ser executada sem as anteriores. */
const PRECONDICOES: Record<Operacao, readonly Operacao[]> = {
  corrigir_cadastro: [],
  confirmar_fornecedor: [],
  confirmar_ausencia_de_qualquer_po: [],
  conferir_no_omie: [],
  recriar_po: ['confirmar_fornecedor', 'confirmar_ausencia_de_qualquer_po'],
};
export const precondicoesDe = (op: Operacao): readonly Operacao[] => PRECONDICOES[op];

/**
 * O universo fechado de operações, em runtime. Derivado do `Record<Operacao, …>` acima — que o TS
 * obriga a ter TODAS as chaves — em vez de uma segunda lista escrita à mão: lista duplicada envelhece
 * (renomear uma operação e esquecer a cópia foi exatamente o que quebrou o teste na primeira tentativa).
 */
export const OPERACOES = Object.keys(PRECONDICOES) as Operacao[];

/**
 * O plano de operações, em ordem. `recriar_po` NUNCA aparece sozinho — exige `confirmar_fornecedor` E
 * `confirmar_ausencia_de_qualquer_po` ANTES (a tabela `PRECONDICOES` é a fonte, e o teste a verifica).
 *
 * Por que a 2ª precondição fala em QUALQUER PO, e não "o PO": a linha mostra o `omie_codigo_pedido`
 * ANTIGO. Se outro comprador já recriou a compra, ela existe sob um número NOVO — conferir só o número
 * antigo confirma "continua ausente" (verdade!) e leva a criar um segundo PO. A pergunta certa é sobre
 * a COMPRA (fornecedor + protocolo), não sobre o identificador que sumiu.
 */
export function planoDeAcao(c: PoCandidato): Operacao[] {
  switch (classificarAcao(c)) {
    case 'identidade_ilegivel':
      return ['corrigir_cadastro'];
    case 'confirmar_com_protocolo':
    case 'confirmar_sem_protocolo':
      // Sem NENHUM identificador de busca (nem protocolo, nem fornecedor), o passo "confirme que não
      // há outro PO ativo para esta compra" é inexequível — e mandar recriar sem poder executá-lo é
      // pior que não sugerir nada: o comprador improvisa uma busca só por fornecedor (que não tem) ou
      // pula a trava. Sem como verificar, o plano PARA na conferência manual.
      return temComoBuscar(c)
        ? ['confirmar_fornecedor', 'confirmar_ausencia_de_qualquer_po', 'recriar_po']
        : ['conferir_no_omie'];
    case 'conferir_no_omie':
      return ['conferir_no_omie'];
  }
}

/** Há algum identificador com que procurar a compra no Omie? Sem isso, não há trava executável. */
export function temComoBuscar(c: PoCandidato): boolean {
  return Boolean(c.portal_protocolo?.trim() || c.fornecedor_nome?.trim());
}

/** Por onde procurar a compra no Omie — só o que a linha REALMENTE tem. */
function chavesDeBusca(c: PoCandidato): string {
  const partes: string[] = [];
  if (c.portal_protocolo?.trim()) partes.push(`protocolo ${c.portal_protocolo.trim()}`);
  if (c.fornecedor_nome?.trim()) partes.push(`fornecedor ${c.fornecedor_nome.trim()}`);
  return partes.join(' e ');
}

/**
 * A frase de cada operação. Uma só fonte para plano e texto — ver `acaoSugerida`.
 *
 * Cada passo que é uma TRAVA carrega sua condição de parada explícita. Sem ela, a instrução registra
 * a consulta e não o resultado: "confirme com o fornecedor" seguido de "3) recrie o PO" manda recriar
 * mesmo quando o fornecedor responde "não existe" ou "foi cancelado" — e são justamente os 2 casos
 * reais de produção que têm protocolo.
 */
function textoDaOperacao(op: Operacao, c: PoCandidato): string {
  switch (op) {
    case 'corrigir_cadastro':
      return 'corrija o cadastro do PO neste pedido — sem ele não foi possível comparar com o Omie';
    case 'confirmar_fornecedor':
      return c.portal_protocolo?.trim()
        ? `confirme com o fornecedor, pelo protocolo ${c.portal_protocolo.trim()}, que o pedido CONTINUA ativo. Se ele disser que não existe, foi cancelado ou já foi atendido, PARE — não recrie`
        : 'confirme com o fornecedor que o pedido CONTINUA ativo. Se ele disser que não existe, foi cancelado ou já foi atendido, PARE — não recrie';
    case 'confirmar_ausencia_de_qualquer_po':
      return `confirme no Omie que NÃO existe nenhum outro pedido de compra ativo para esta compra: busque por ${chavesDeBusca(c)} — não pelo número antigo, que alguém pode já ter substituído. Achou algum? PARE`;
    case 'recriar_po':
      // A corrida entre dois compradores NÃO é fechável aqui: este card não muta nada, a ação acontece
      // no Omie. Sem claim/idempotência (escopo do PR3), o melhor honesto é avisar em vez de fingir.
      return 'recrie o PO — e avise a equipe, porque outra pessoa pode estar olhando esta mesma lista agora';
    case 'conferir_no_omie':
      return 'confira no Omie se o PO foi excluído e decida com o histórico do pedido';
  }
}

/**
 * O texto mostrado ao humano, MONTADO a partir do plano — não um switch paralelo.
 * A versão anterior derivava plano e frase por caminhos independentes, então o plano podia exigir uma
 * confirmação que a frase não mencionava: o plano viraria enfeite, e o comprador age pela FRASE.
 * Aqui divergir é impossível: cada passo do plano vira um passo do texto, na ordem.
 */
export function passosDaAcao(c: PoCandidato): string[] {
  const plano = planoDeAcao(c);
  const passos = plano.map((op) => {
    const t = textoDaOperacao(op, c);
    return t.charAt(0).toUpperCase() + t.slice(1) + '.';
  });
  // O lembrete só faz sentido onde recriar é uma opção — é ali que a tentação de "resolver cancelando"
  // aparece, e onde cancelar custaria a recompra do que o fornecedor já tem.
  return plano.includes('recriar_po') ? [...passos, 'Não cancele o pedido.'] : passos;
}

/**
 * Os passos como texto corrido. Usado onde uma lista não cabe; o card renderiza `passosDaAcao` como
 * <ol> porque três passos com travas e ressalvas num único nó de texto quebram onde couber, e quem
 * escaneia acha "recrie o PO" antes de achar o "PARE" que o precede.
 */
export function acaoSugerida(c: PoCandidato): string {
  return passosDaAcao(c).join(' ');
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
