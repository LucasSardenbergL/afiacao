/**
 * sonda-cron-testemunha.ts — a sonda por CRON vira testemunha, e o SILÊNCIO dela vira sinal.
 * ============================================================================================
 *
 * A F1 deu o mecanismo (`OPTIONS` via edge-relé, que todo bundle histórico interrompe antes de
 * qualquer efeito) e a F2 o disparo automático. Falta LER o resultado — e a leitura ingênua
 * ("apareceu linha no ledger nas últimas horas?") fabrica veredito de três jeitos, todos já
 * vistos neste repo:
 *
 *   1. **Atribuição por TEMPO.** Uma resposta atrasada do tick anterior, ou uma sonda humana, cai
 *      na janela e mascara dois ticks silenciosos logo depois de um rollback. Por isso a ligação
 *      aqui é sempre pelo `request_id` que `deploy_sonda_disparos` gravou na MESMA transação do
 *      disparo — nunca por "quem chegou perto da hora".
 *   2. **Silêncio lido como aprovação.** Cron parado, tabela ausente ou allowlist do banco fora de
 *      sincronia com o repo produzem exatamente a mesma tela de "nada pendente". São MECÂNICA
 *      (exit 2), e o CLI as trata assim.
 *   3. **Silêncio lido como incidente.** Edge cujo ledger já diz DIVERGE não deveria mesmo atestar:
 *      o ramo ainda não está no ar. Cobrar sonda dela é ruído que ensina a ignorar o relatório.
 *
 * O sinal que sobra depois de fechar os três é o que motivou o mecanismo inteiro: *o bundle que o
 * ledger jura estar no ar continua lá?*
 */

/** Um disparo do cron: a ponte entre o tick e a resposta que ele vai produzir. */
export interface Disparo {
  /** Só para DIAGNÓSTICO humano desde a janela por edge: não é mais a chave do julgamento. */
  tickId: string;
  edge: string;
  requestId: number;
  /**
   * Minutos desde o enfileiramento, medidos pelo relógio do BANCO.
   *
   * Serve para ORDENAR a janela e aplicar o TETO — nunca para atribuir uma resposta a um disparo.
   * Essa ligação continua sendo o `request_id`, e a diferença é a razão (1) do cabeçalho: uma
   * resposta atrasada do tick anterior tem outro id e não conta, por mais perto da hora que caia.
   */
  idadeMin: number;
}

/** Uma atestação já atribuída: o `request_id` que respondeu e a edge que o CORPO declarou. */
export interface AtestacaoAtribuida {
  requestId: number;
  edgeDoCorpo: string;
}

/**
 * O que o RELÉ respondeu para um disparo, quando isso ainda é legível.
 *
 * Sem isto o achado dizia "rollback, deploy parcial ou bundle recriado" — três hipóteses — mesmo
 * quando o relé tinha escrito a causa exata no corpo (`sem-chave`, `timeout`, `cors-sem-sonda`).
 * Especular na frente de quem tem o dado é como um sensor perde credibilidade: o primeiro alarme
 * que manda investigar a coisa errada ensina a ignorar o próximo.
 */
interface MotivoDoRele {
  requestId: number;
  classe: string;
}

export interface EntradaSondaCron {
  /** Edges ATIVAS na tabela do banco. */
  ativosNoBanco: string[];
  /** Edges na allowlist do REPO — a fonte única, e a única cujo conteúdo foi provado. */
  allowlistDoRepo: string[];
  /**
   * Todos os disparos legíveis das edges. O juiz recorta daqui a janela que julga — os
   * `DISPAROS_QUE_JULGAM` mais recentes de CADA edge, dentro do teto de idade —, então mandar mais
   * do que ele julga é inofensivo e mandar de menos é o que o SQL tem de não fazer.
   */
  disparos: Disparo[];
  atestacoes: AtestacaoAtribuida[];
  /** O estado que a matriz do par já deu por edge. Só `CONFERE` torna o silêncio suspeito. */
  estadoPorEdge: Map<string, string>;
  /** Classe que o relé declarou por `request_id`, quando ainda legível. Ausente = não sei. */
  motivos?: MotivoDoRele[];
}

type ClasseSondaCron = 'SONDA_CRON_SILENCIOSA' | 'IDENTIDADE_INCOERENTE';

interface AchadoSondaCron {
  edge: string;
  classe: ClasseSondaCron;
  detalhe: string;
}

export interface ResultadoSondaCron {
  /** Pendências — o CLI sai 1. */
  achados: AchadoSondaCron[];
  /** Avisos que NÃO reprovam: 1 tick só de silêncio, edge do repo ainda não habilitada no banco. */
  avisos: string[];
  /**
   * Edges ATIVAS que NENHUM dos ticks que julgam perguntou. Não é achado nem aviso — ausência de
   * PERGUNTA não é silêncio —, mas também não é atestação: sai aqui porque quem RESUME precisa saber
   * quem ficou fora do exame. Medido em 2026-09-10, logo após a onda 5 da allowlist: 16 ativas, 15
   * perguntadas (`omie-desconto-backfill` entrou depois do último tick) e a tela afirmando "toda edge
   * ativa foi atestada" — cobertura afirmada sobre uma população com membro não examinado.
   */
  semPergunta: string[];
  /**
   * Edges perguntadas que não responderam e cujo ledger NÃO diz CONFERE: o silêncio é a consequência
   * esperada do deploy pendente, então não acusa — e, pela mesma razão, não é atestação.
   */
  silencioEsperado: string[];
  /**
   * O tamanho do EXAME: quantos disparos entraram na janela que julgou, e quantos responderam.
   *
   * Sai daqui, e não da contagem crua do input, porque quem resume não pode recontar o recorte: o
   * cabeçalho dizia "N tick(s) recente(s)" derivando N dos `tick_id` que apareceram na leitura, e com
   * a janela por edge esse número não mede mais a população examinada (lição de
   * docs/historico/resumo-universal-herda-o-pulo-do-juiz.md).
   */
  exame: { disparos: number; atestados: number };
}

/**
 * Quantos disparos DE CADA EDGE formam o julgamento. Dois, e a razão está em `julgarSondaCron`.
 *
 * Era "quantos TICKS recentes", e os ticks eram escolhidos GLOBALMENTE — o que fazia um tick PARCIAL
 * legítimo (o one-liner `deploy_sonda_disparar(ARRAY['<edge>'])` que o `sonda:sql` oferece) consumir
 * uma das duas vagas de TODAS as outras edges. Medido em prod em 2026-09-10 23:14:15Z: 1 edge com 2
 * disparos na janela e **14 com 1** — por ~2 h o silêncio das 14 só podia virar AVISO, nunca a
 * acusação de rollback que é a pergunta do mecanismo. Com a janela por edge, 15 com 2 e nenhuma com 1.
 */
export const DISPAROS_QUE_JULGAM = 2;

/**
 * O silêncio só acusa quando as três condições valem JUNTAS, e cada uma existe para não fabricar:
 *
 *   (a) a edge está ATIVA no banco — se o operador a desligou pelo kill switch, silêncio é obediência;
 *   (b) os DOIS últimos ticks dispararam para ela e NENHUM produziu atestação. Um tick só é ruído:
 *       timeout e 429 acontecem, e aqui precisão vale mais que recall — um alarme falso semanal
 *       ensina a ignorar o relatório, que é como um sensor morre;
 *   (c) o ledger diz `CONFERE` para ela. Ou seja: o bundle que prod deveria servir é o da main, que
 *       TEM o ramo e portanto honraria a credencial. Se o ledger já diz DIVERGE, o ramo não está no
 *       ar e o silêncio é a consequência ESPERADA do deploy pendente.
 *
 * Com (c), este sinal responde a pergunta que nenhum outro responde — *o bundle que o ledger jura
 * estar no ar continua lá?* — e é a detecção de rollback que justificou a entrega.
 */
export function julgarSondaCron(e: EntradaSondaCron): ResultadoSondaCron {
  const achados: AchadoSondaCron[] = [];
  const avisos: string[] = [];
  const semPergunta: string[] = [];
  const silencioEsperado: string[] = [];

  const ativos = new Set(e.ativosNoBanco);
  const respondidos = new Set(e.atestacoes.map((a) => a.requestId));
  const porRequest = new Map(e.disparos.map((d) => [d.requestId, d]));

  // — identidade: a resposta se diz outra edge —
  // O relé já recusa isso (classe `identidade-divergente`), então uma linha aqui significa que a
  // atestação entrou no ledger por OUTRO caminho: sonda humana antiga, ou um relé adulterado.
  // Atestação de `request_id` desconhecido é ignorada — não saiu deste cron, e julgar o que não se
  // pediu é como o veredito por tempo volta pela porta dos fundos.
  for (const a of e.atestacoes) {
    const d = porRequest.get(a.requestId);
    if (!d || a.edgeDoCorpo === d.edge) continue;
    achados.push({
      edge: d.edge,
      classe: 'IDENTIDADE_INCOERENTE',
      detalhe:
        `o disparo pediu ${d.edge} e a resposta (request ${a.requestId}) se identificou como ${a.edgeDoCorpo} — ` +
        `o relé recusa esse corpo, então esta linha veio por outro caminho`,
    });
  }

  // — silêncio —
  // A janela é POR EDGE: os `DISPAROS_QUE_JULGAM` mais recentes DELA, dentro do teto de idade. O
  // teto é o que o `LIMIT 2` por tick global dava de graça — sem ele, dois disparos ANTIGOS (edge
  // desligada pelo kill switch e religada) formariam acusação de rollback. A régua é a MESMA
  // tolerância de `cronSondaParado` e do teto da espera: uma definição só, em `toleranciaDoCronMin`.
  // O `!(idade <= teto)` — e não `idade > teto` — é o que mantém idade ILEGÍVEL fora do exame:
  // `NaN > teto` é false e deixaria o disparo entrar, que é a forma `ausente ≠ zero` nesta camada.
  const teto = toleranciaDoCronMin();
  const janelaPorEdge = new Map<string, Disparo[]>();
  for (const d of e.disparos) {
    if (!(d.idadeMin <= teto)) continue;
    const lista = janelaPorEdge.get(d.edge);
    if (lista === undefined) janelaPorEdge.set(d.edge, [d]);
    else lista.push(d);
  }
  for (const lista of janelaPorEdge.values()) {
    // Desempate por `request_id` DESC: dois disparos do MESMO instante (o tick manual que repete a
    // edge do cron) precisam de ordem total, senão o recorte depende da ordem de chegada das linhas.
    lista.sort((a, b) => a.idadeMin - b.idadeMin || b.requestId - a.requestId);
    lista.splice(DISPAROS_QUE_JULGAM);
  }

  // O exame conta DENTRO do laço das ATIVAS, nunca sobre `janelaPorEdge` inteira: uma edge desligada
  // pelo kill switch continua tendo disparos recentes no ledger, e contá-los faria o cabeçalho
  // afirmar um exame maior do que a população que o juiz de fato examina.
  let examinados = 0;
  let examinadosAtestados = 0;

  for (const edge of [...ativos].sort()) {
    const disparosDaEdge = janelaPorEdge.get(edge) ?? [];
    examinados += disparosDaEdge.length;
    examinadosAtestados += disparosDaEdge.filter((d) => respondidos.has(d.requestId)).length;
    if (disparosDaEdge.length === 0) {
      semPergunta.push(edge); // nenhum tick pediu: ausência de PERGUNTA, não silêncio — e fora do exame
      continue;
    }

    const mudos = disparosDaEdge.filter((d) => !respondidos.has(d.requestId));
    if (mudos.length === 0) continue;

    if (e.estadoPorEdge.get(edge) !== 'CONFERE') {
      silencioEsperado.push(edge); // silêncio esperado: o ramo não está no ar — e não é atestação
      continue;
    }

    if (mudos.length < DISPAROS_QUE_JULGAM || disparosDaEdge.length < DISPAROS_QUE_JULGAM) {
      avisos.push(
        `${edge}: ${mudos.length} de ${disparosDaEdge.length} tick(s) recentes sem resposta — ` +
          `abaixo de ${DISPAROS_QUE_JULGAM} não acusa (timeout e 429 acontecem)`,
      );
      continue;
    }

    // Quando o relé declarou a causa, ela SUBSTITUI a especulação. Uma causa conhecida e um
    // diagnóstico genérico levam o leitor a lugares diferentes, e o genérico custa uma investigação
    // inteira quando a resposta estava escrita no corpo.
    const porRequestMotivo = new Map((e.motivos ?? []).map((m) => [m.requestId, m.classe]));
    const classesVistas = [...new Set(mudos.map((d) => porRequestMotivo.get(d.requestId)).filter((c): c is string => !!c))];
    const causa = classesVistas.length > 0
      ? `O relé respondeu: ${classesVistas.join(', ')}${classesVistas.includes('sem-chave') ? ' — provisione SONDA_HMAC_KEY nos secrets das edges' : ''}.`
      : 'Rollback, deploy parcial ou bundle recriado.';
    achados.push({
      edge,
      classe: 'SONDA_CRON_SILENCIOSA',
      detalhe:
        `os ${disparosDaEdge.length} últimos disparos PARA ELA não foram atestados, mas o ledger diz CONFERE — ` +
        `o bundle que deveria estar no ar tem o ramo e honraria a credencial. ${causa} ` +
        `Requests sem resposta: ${mudos.map((d) => d.requestId).join(', ')}`,
    });
  }

  // — a allowlist do repo que ainda não foi habilitada no banco —
  for (const edge of e.allowlistDoRepo) {
    if (!ativos.has(edge)) {
      avisos.push(`${edge}: na allowlist do repo, ainda não ativa no banco — falta o INSERT em deploy_sonda_alvos`);
    }
  }

  return {
    achados,
    avisos,
    semPergunta,
    silencioEsperado,
    exame: { disparos: examinados, atestados: examinadosAtestados },
  };
}

/**
 * O banco NÃO pode sondar edge que o repo não aprovou.
 *
 * É MECÂNICA (exit 2), não pendência: a allowlist do repo é a única cujo conteúdo foi provado por
 * `sonda:cron-prova` (todo closure histórico executado, zero efeito). Uma linha a mais no banco
 * significa que alguém sonda uma edge SEM prova — o oposto exato do default-deny que o mecanismo
 * inteiro compra.
 */
export function alvosForaDoRepo(ativosNoBanco: string[], allowlistDoRepo: string[]): string[] {
  const repo = new Set(allowlistDoRepo);
  return ativosNoBanco.filter((e) => !repo.has(e)).sort();
}

/**
 * Saúde do cron de sonda: minutos desde o último sucesso, contra 2 períodos + 15 min de folga.
 *
 * `null` = nunca rodou, e isso NÃO é falha — é o estado de um cron recém-aplicado, e tratá-lo como
 * parado faria a primeira execução do CLI reprovar por construção.
 */
export function cronSondaParado(minutosDesdeSucesso: number | null, periodoHoras = 2): boolean {
  if (minutosDesdeSucesso === null) return false;
  return minutosDesdeSucesso > toleranciaDoCronMin(periodoHoras);
}

/**
 * A tolerância de uma espera pelo cron de sonda: 2 períodos + 15 min de folga.
 *
 * Uma definição só para as duas perguntas que a usam — *o cron parou?* e *o dispatcher deixou de
 * perguntar por esta edge?* —, porque as duas se medem pelo MESMO relógio: com o cron vivo (é o que
 * `cronSondaParado` garante antes), uma edge que espera há mais de 2 períodos esteve ativa durante
 * ao menos um tick bem-sucedido, e um tick pergunta TODA ativa (`deploy_sonda_disparar` sem `p_alvos`).
 */
export function toleranciaDoCronMin(periodoHoras = 2): number {
  return periodoHoras * 60 * DISPAROS_QUE_JULGAM + 15;
}

/** Uma edge ATIVA que ficou fora do exame, e há quantos minutos ela espera. `null` = não medido. */
interface EsperaDaEdge {
  edge: string;
  minutos: number | null;
}

interface SemPerguntaClassificada {
  /** Dentro da tolerância, ou sem medida: é a vez dela, e nada está provado contra o dispatcher. */
  aguardando: EsperaDaEdge[];
  /** Acima da tolerância: um tick que pergunta toda ativa já passou sem perguntar por ela. */
  atrasadas: Array<{ edge: string; minutos: number }>;
}

/**
 * Esperar por uma pergunta tem TETO — laço de espera sem desistência é fail-OPEN
 * (docs/historico/espera-sem-desistencia.md). Sem ele, a linha "sem pergunta" descreveria para
 * sempre, com cara de normalidade, uma edge que o dispatcher parou de perguntar: o sensor de
 * rollback dela estaria morto e a tela não diria nada.
 *
 * Sem medida NÃO vira atraso nem zero — é o ramo "não consegui medir", que o chamador IMPRIME.
 */
export function classificarSemPergunta(
  semPergunta: string[],
  esperaPorEdge: Map<string, number>,
  periodoHoras = 2,
): SemPerguntaClassificada {
  const teto = toleranciaDoCronMin(periodoHoras);
  const aguardando: EsperaDaEdge[] = [];
  const atrasadas: Array<{ edge: string; minutos: number }> = [];
  for (const edge of semPergunta) {
    const minutos = esperaPorEdge.get(edge);
    if (minutos === undefined) aguardando.push({ edge, minutos: null });
    else if (minutos > teto) atrasadas.push({ edge, minutos });
    else aguardando.push({ edge, minutos });
  }
  return { aguardando, atrasadas };
}
