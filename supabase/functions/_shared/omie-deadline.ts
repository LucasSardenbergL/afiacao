// Política PURA de TEMPO das chamadas ao Omie: quanto CADA request pode gastar e se ainda cabe
// uma retentativa antes do kill do chamador. Sem I/O, sem dependência de runtime — testes em
// omie-deadline_test.ts (Deno, `--no-remote`).
//
// ── Por que existe ───────────────────────────────────────────────────────────────────────────
// `omieCall` sem `AbortSignal.timeout` não tem teto de RELÓGIO. O guard que essas edges têm é de
// CONTAGEM (`MAX_CHAMADAS_LISTAGEM`), e contagem não limita tempo. Medido em prod 2026-08-25
// (#2017): o cron `omie-nfe-reconcile-1h` (jobid 162) estourou `timeout_milliseconds:=150000`
// gastando 149.905ms num ÚNICO request pendurado — DNS 14ms, handshake 81ms, todo o resto
// esperando a resposta — enquanto as 4 rodadas anteriores fizeram trabalho IDÊNTICO
// (`chamadas_listagem: 7` de 12, `truncada:false`) em ~20s. Não foi volume: foi um socket
// travado sem coleira, com o Omie saudável no minuto. Subir o teto do cron só faria esperar mais
// no mesmo socket — veredito em docs/historico/cron-teto-volume-vs-latencia.md §"Veredito 2".
//
// ── Por que o teto POR REQUEST não basta sozinho ─────────────────────────────────────────────
// `AbortSignal.timeout(25s)` isolado ainda deixa o run cruzar o kill: 3 tentativas de 25s mais os
// backoffs passam de 75s, e a última pode COMEÇAR faltando 1s para o kill. Quando o kill chega no
// meio de um request o isolate morre SEM passar pelo catch, e sobra linha órfã `running` no
// `fin_sync_log` (docs/agent/sync.md §Enumeração pesada). Por isso o teto de cada request E o
// sleep de cada retry saem de um DEADLINE COMPARTILHADO do run — um relógio só para o laço de
// páginas, a trégua entre janelas e o backoff.
//
// ── O lado seguro do arredondamento ──────────────────────────────────────────────────────────
// Quando o tempo restante não dá para um request com chance real de responder, a resposta é NÃO
// CHAMAR (0) — não "chamar com o que sobrou". Um request condenado a abortar gasta o mesmo
// socket, produz um erro genérico e ainda assim não traz dado; recusar deixa a cobertura parcial
// EXPLÍCITA para o chamador reportar (money-path: parcial reportado > completo fabricado).

/**
 * Piso de viabilidade de um request ao Omie. Abaixo disso a chamada nasce condenada: o handshake
 * de TLS sozinho já consumiu ~95ms nas medições do #2017, e uma listagem que responde rápido
 * ainda leva ~1,5-3s. Não é margem de segurança do kill — é o mínimo para a chamada VALER a pena.
 */
export const MIN_REQUEST_MS = 2_000;

/** Milissegundos até o deadline. Nunca negativo; entrada não-finita vira 0 (lado seguro). */
export function tempoRestanteMs(agora: number, deadline: number): number {
  if (!Number.isFinite(agora) || !Number.isFinite(deadline)) return 0;
  return Math.max(0, deadline - agora);
}

/**
 * Teto de UM request: o menor entre o teto por request e o que sobra do deadline do run — para
 * que nenhuma chamada individual possa cruzar o kill do chamador.
 *
 * Devolve **0 quando não se deve chamar** (deadline vencido, sobra abaixo de `minimoMs`, ou teto
 * inválido). O chamador DEVE tratar 0 como "sem tempo" e abortar honesto: passar 0 para
 * `AbortSignal.timeout` aborta no tick seguinte e transforma a recusa num erro de rede genérico.
 */
export function timeoutRequestMs(
  agora: number,
  deadline: number,
  tetoPorRequestMs: number,
  minimoMs: number = MIN_REQUEST_MS,
): number {
  if (!Number.isFinite(tetoPorRequestMs) || tetoPorRequestMs <= 0) return 0;
  const restante = tempoRestanteMs(agora, deadline);
  if (restante < minimoMs) return 0;
  return Math.min(Math.floor(tetoPorRequestMs), restante);
}

/**
 * Se ainda cabe dormir `esperaMs` (backoff, trégua, cooldown de 429) **e depois** fazer um request
 * com chance real de responder.
 *
 * O `+ minimoMs` é o ponto todo: um sleep que cabe no deadline mas não deixa tempo para a chamada
 * seguinte apenas adia o kill dentro do socket. É o furo que sobra quando se testa só
 * `agora + espera >= deadline`.
 */
export function cabeEspera(
  agora: number,
  deadline: number,
  esperaMs: number,
  minimoMs: number = MIN_REQUEST_MS,
): boolean {
  if (!Number.isFinite(esperaMs) || esperaMs < 0) return false;
  return tempoRestanteMs(agora, deadline) >= esperaMs + minimoMs;
}
