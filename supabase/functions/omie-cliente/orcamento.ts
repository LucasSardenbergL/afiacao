/**
 * Orçamento de tempo do `sync_all_clients` — regra pura, sem I/O.
 *
 * POR QUE EXISTE (2026-11-01): o gateway das edges corta a resposta em 150 s sem bytes
 * (`504 IDLE_TIMEOUT`). O ramo de INSERÇÃO custa ~1,1 s por cliente novo (createUser → profile →
 * register_carteira_member → endereço, em série), então 3 páginas × 50 novos não cabem. Medido na
 * reposição de telefones: a chamada da conta oben inseriu 150 clientes em ~165 s, o front tomou o
 * 504 e parou o cursor — os clientes seguintes ficaram sem importar. A execução de 22/07 morreu do
 * mesmo jeito (`acoes_execucoes` presa em `executando`).
 *
 * A SAÍDA é parar ANTES do corte e devolver o cursor na MESMA página: os já gravados entram em
 * `existingCodes` e a próxima invocação os pula (o import é idempotente por desenho), então
 * reprocessar o começo da página custa só os SKIPs.
 *
 * GARANTIA DE PROGRESSO: interromper só depois de algum avanço DESTA invocação (página concluída
 * ou cliente inserido). Sem isso, um setup lento demais faria toda invocação parar antes do 1º
 * cliente — cursor parado para sempre, o mesmo laço quente que `MAX_TENTATIVAS_PAGINA` fecha.
 */

/** Sem página nova depois disto: uma página de 50 novos custa ~55 s e tem de caber antes do corte. */
export const INICIAR_PAGINA_ATE_MS = 60_000;
/** Corte no meio da página: folga para o cliente em voo (~1–2 s) e a resposta, abaixo dos 150 s. */
export const INTERROMPER_APOS_MS = 110_000;

interface ProgressoInvocacao {
  decorridoMs: number;
  paginasConcluidas: number;
  clientesImportados: number;
}

function houveProgresso(p: ProgressoInvocacao): boolean {
  return p.paginasConcluidas > 0 || p.clientesImportados > 0;
}

/** Antes de pedir a próxima página ao Omie. A 1ª página da invocação sempre começa. */
export function podeIniciarPagina(p: ProgressoInvocacao): boolean {
  return p.paginasConcluidas === 0 || p.decorridoMs < INICIAR_PAGINA_ATE_MS;
}

/** Antes de cada cliente da página: true = parar aqui e devolver a MESMA página no cursor. */
export function deveInterromperPagina(p: ProgressoInvocacao): boolean {
  return p.decorridoMs >= INTERROMPER_APOS_MS && houveProgresso(p);
}
