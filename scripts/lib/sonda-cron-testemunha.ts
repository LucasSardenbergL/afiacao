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
  tickId: string;
  edge: string;
  requestId: number;
}

/** Uma atestação já atribuída: o `request_id` que respondeu e a edge que o CORPO declarou. */
export interface AtestacaoAtribuida {
  requestId: number;
  edgeDoCorpo: string;
}

export interface EntradaSondaCron {
  /** Edges ATIVAS na tabela do banco. */
  ativosNoBanco: string[];
  /** Edges na allowlist do REPO — a fonte única, e a única cujo conteúdo foi provado. */
  allowlistDoRepo: string[];
  /** Os `tick_id` recentes, MAIS RECENTE PRIMEIRO. Só os 2 primeiros julgam. */
  ticksRecentes: string[];
  disparos: Disparo[];
  atestacoes: AtestacaoAtribuida[];
  /** O estado que a matriz do par já deu por edge. Só `CONFERE` torna o silêncio suspeito. */
  estadoPorEdge: Map<string, string>;
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
}

/** Quantos ticks recentes formam o julgamento. Dois, e a razão está em `julgarSondaCron`. */
const TICKS_QUE_JULGAM = 2;

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
  const ticks = e.ticksRecentes.slice(0, TICKS_QUE_JULGAM);
  for (const edge of [...ativos].sort()) {
    const disparosDaEdge = ticks
      .map((t) => e.disparos.find((d) => d.tickId === t && d.edge === edge))
      .filter((d): d is Disparo => d !== undefined);
    if (disparosDaEdge.length === 0) continue; // nenhum tick pediu: ausência de PERGUNTA, não silêncio

    const mudos = disparosDaEdge.filter((d) => !respondidos.has(d.requestId));
    if (mudos.length === 0) continue;

    if (e.estadoPorEdge.get(edge) !== 'CONFERE') continue; // silêncio esperado: o ramo não está no ar

    if (mudos.length < TICKS_QUE_JULGAM || disparosDaEdge.length < TICKS_QUE_JULGAM) {
      avisos.push(
        `${edge}: ${mudos.length} de ${disparosDaEdge.length} tick(s) recentes sem resposta — ` +
          `abaixo de ${TICKS_QUE_JULGAM} não acusa (timeout e 429 acontecem)`,
      );
      continue;
    }

    achados.push({
      edge,
      classe: 'SONDA_CRON_SILENCIOSA',
      detalhe:
        `os ${disparosDaEdge.length} últimos ticks dispararam e NENHUM foi atestado, mas o ledger diz CONFERE — ` +
        `o bundle que deveria estar no ar tem o ramo e honraria a credencial. Rollback, deploy parcial ou bundle ` +
        `recriado. Requests sem resposta: ${mudos.map((d) => d.requestId).join(', ')}`,
    });
  }

  // — a allowlist do repo que ainda não foi habilitada no banco —
  for (const edge of e.allowlistDoRepo) {
    if (!ativos.has(edge)) {
      avisos.push(`${edge}: na allowlist do repo, ainda não ativa no banco — falta o INSERT em deploy_sonda_alvos`);
    }
  }

  return { achados, avisos };
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
  return minutosDesdeSucesso > periodoHoras * 60 * TICKS_QUE_JULGAM + 15;
}
