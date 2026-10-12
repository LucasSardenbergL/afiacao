// Relógio da CHAMADA ao Omie para edges que também ESCREVEM no ERP (M-33 parte 3) — sem I/O
// além do `fazer` injetado, sem import remoto. Testes em omie-chamada-relogio_test.ts (Deno,
// `--no-remote`). Usado por `omie-vendas-sync` (`callOmieVendasApi`) e `omie-sync` (`callOmieApi`).
//
// ── Por que existe ───────────────────────────────────────────────────────────────────────────
// O `fetch` dessas duas edges não tinha teto (só o `ListarPedidos` tinha os 80s da trava de
// `omie-cota.ts`): um socket pendurado segurava a invocação até o kill da plataforma, e o isolate
// morria SEM passar pelo catch — a classe do #2017 (`omie-deadline.ts`). O número e o escopo vêm
// do #3001 (`omie-analytics-sync/politica-retry.ts`), decididos em 3 rodadas de Codex: sem latência
// medida por método, o único teto que não piora caso legítimo é o do PRÓPRIO worker menos a margem
// do catch, aplicado à CHAMADA LÓGICA (tentativas + backoffs), não ao run.
//
// ── O que muda por serem ESCRITAS ────────────────────────────────────────────────────────────
// Abortar o fetch não desfaz nada no Omie: se o pedido saiu, ele pode ter sido gravado e só a
// resposta se perdeu. Por isso a falha de uma escrita NÃO pode sair como "transitório" (que
// convida a repetir) nem como erro genérico (que o operador lê como "não aconteceu"): sai como
// `OmieEscritaIndeterminada`, cuja mensagem manda conferir no Omie antes de repetir. Isso não
// cria estado novo — hoje o mesmo socket pendurado termina no kill, com o MESMO desfecho
// desconhecido no ERP —; só torna o estado legível a tempo de o catch responder.
//
// A idempotência de cada escrita continua sendo de quem a chama (chave determinística como
// `PV_<id>` no IncluirPedido, lookup por documento antes do IncluirCliente, re-edição que relê o
// pedido). Este módulo garante a outra metade: que nenhuma camada leia a falha como "não gravou".
import { timeoutRequestMs } from "./omie-deadline.ts";

/** Teto de UM request e da chamada lógica inteira: o orçamento do worker (~150s) menos a margem do catch (#3001). */
export const TETO_CHAMADA_OMIE_MS = 140_000;

// Só estes prefixos são LEITURA. Qualquer outro método — inclusive um que este módulo nunca viu —
// é tratado como escrita (fail-closed): errar para "escrita" custa só uma mensagem mais cautelosa;
// errar para "leitura" faria uma escrita perdida no transporte sair como transitório repetível.
const PREFIXOS_LEITURA = ["Listar", "Consultar", "Pesquisar", "Obter"];

export function ehEscritaOmie(metodo: string): boolean {
  return !PREFIXOS_LEITURA.some((p) => metodo.length > p.length && metodo.startsWith(p) && /[A-Z]/.test(metodo[p.length]));
}

/** Prazo da chamada lógica que começa em `agora`. */
export function prazoDaChamadaOmie(agora: number): number {
  return agora + TETO_CHAMADA_OMIE_MS;
}

/**
 * Escrita cujo desfecho no Omie é DESCONHECIDO: o request pode ter chegado e sido aplicado.
 *
 * ⚠️ A mensagem tem vocabulário FIXO, de propósito — nunca ecoa o erro cru (fica em `cause`). Ela é
 * lida por predicados vizinhos que decidem efeito, e cada palavra a mais é uma porta: com
 * `cadastrad`/`integra` o `isOmieDuplicatePedido` do vendas reconciliaria um pedido que talvez não
 * exista; com `nao existe`/`nao encontrad` o `osAusenteNoOmie` do omie-sync apagaria o pedido de 6
 * tabelas; com `timeout`/`connection` o `classificarFaultstring` a chamaria de transitória — e
 * transitório é o que se repete. O teste pina os três.
 */
export class OmieEscritaIndeterminada extends Error {
  readonly marca = "omie_escrita_indeterminada" as const;
  constructor(readonly metodo: string, readonly conta: string, motivo: string, causa: unknown) {
    super(
      `OMIE_ESCRITA_INDETERMINADA (${conta}): ${metodo} ${motivo} — o Omie PODE ter gravado; ` +
        `confira no Omie antes de repetir`,
      { cause: causa },
    );
    this.name = "OmieEscritaIndeterminada";
  }
}

export function ehEscritaIndeterminada(e: unknown): e is OmieEscritaIndeterminada {
  return e instanceof Error && (e as Partial<OmieEscritaIndeterminada>).marca === "omie_escrita_indeterminada";
}

/**
 * Leitura que estourou o teto. Prefixo `OMIE_TRANSIENT` = a mesma forma que o laço paginado do
 * vendas já trata como PAUSA (não marca completo), e "timeout" a faz transitória para o
 * `classificarFaultstring`. Lança SEMPRE — devolver `null` seria fim de página fabricado.
 */
export function erroLeituraSemResposta(metodo: string, conta: string, causa: unknown): Error {
  return new Error(
    `OMIE_TRANSIENT (${conta}): timeout — ${metodo} sem resposta dentro do teto da chamada — não dá pra afirmar ausência`,
    { cause: causa },
  );
}

/** A chamada NÃO foi feita: não sobrou tempo viável no relógio da chamada. Afirmação segura, até para escrita. */
export function erroSemTempo(metodo: string, conta: string): Error {
  return new Error(
    `OMIE_TRANSIENT (${conta}): sem tempo para chamar ${metodo} dentro do teto da chamada — a chamada NÃO foi feita`,
  );
}

export interface OpcoesRelogio {
  metodo: string;
  conta: string;
  /** Fim da chamada lógica (`prazoDaChamadaOmie(início)`), compartilhado entre as tentativas. */
  deadline: number;
  /** Sinal que já existia (o timeout da trava do `ListarPedidos`); o primeiro a disparar vence. */
  sinalExtra?: AbortSignal;
  agora?: () => number;
  /** Só para teste: teto e piso em ms pequenos, com abort REAL. */
  tetoMs?: number;
  minimoMs?: number;
}

/**
 * Roda UM request ao Omie com teto de relógio e traduz a falha pelo tipo do método.
 *
 * - teto 0 (não sobrou tempo viável) → `erroSemTempo`, sem chamar `fazer`;
 * - ESCRITA: QUALQUER exceção dentro de `fazer` (abort, reset de conexão, corpo ilegível) vira
 *   `OmieEscritaIndeterminada` — do lado de cá não há como separar "não saiu" de "saiu e a
 *   resposta se perdeu", e só o segundo importa;
 * - LEITURA: o abort vira `erroLeituraSemResposta`; as demais exceções passam como estão.
 *
 * `fazer` tem de usar o `signal` recebido no fetch E na leitura do corpo — o teto cobre os dois.
 */
export async function chamarComRelogio<T>(fazer: (signal: AbortSignal) => Promise<T>, o: OpcoesRelogio): Promise<T> {
  const agora = (o.agora ?? Date.now)();
  const teto = timeoutRequestMs(agora, o.deadline, o.tetoMs ?? TETO_CHAMADA_OMIE_MS, o.minimoMs);
  if (teto === 0) throw erroSemTempo(o.metodo, o.conta);
  const sinalTeto = AbortSignal.timeout(teto);
  const signal = o.sinalExtra ? AbortSignal.any([o.sinalExtra, sinalTeto]) : sinalTeto;
  try {
    return await fazer(signal);
  } catch (e) {
    if (ehEscritaOmie(o.metodo)) {
      const motivo = signal.aborted ? "sem resposta dentro do teto da chamada" : "falhou no transporte ou na leitura da resposta";
      throw new OmieEscritaIndeterminada(o.metodo, o.conta, motivo, e);
    }
    if (signal.aborted) throw erroLeituraSemResposta(o.metodo, o.conta, e);
    throw e;
  }
}
