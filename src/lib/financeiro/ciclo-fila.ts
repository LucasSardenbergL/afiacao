// Fila de leituras da aba "Ciclo" (master-only). Ao abrir a aba, ~9 leituras pesadas (RPCs fin_ciclo_* + a edge
// fin-cashflow-engine por empresa) saíam JUNTAS: a disputa por CPU empurrava cada uma acima do statement_timeout de
// 8 s do papel authenticated e todas voltavam 500 — e o retry do react-query refazia tudo em paralelo, estourando igual.
// Sozinhas, cada uma leva de 1 a 3,4 s. Esta fila põe um TETO de leituras simultâneas (FIFO): a que espera continua
// "carregando" (a promise do queryFn só resolve quando roda), nunca vira vazio nem zero.

//
// DUAS FAIXAS (2026-10-19, após #3182): na fila única, a edge fin-cashflow-engine (1 chamada por empresa) entrava
// primeiro — os cards são FILHOS, e o efeito do filho roda antes do do pai — e a v1.5 levava 18,5 s / 35 s / 3,9 s
// (paginava v_titulo_baixas ~29× na colacor; corrigido na v1.6, #3184). Ela segurava as 2 vagas e as RPCs do topo só
// começavam em t≈23 s. Agora a edge tem faixa PRÓPRIA de 1 e as RPCs a delas de 2: pico de 3 leituras pesadas, e a
// edge lenta não bloqueia mais o topo. Prova: CicloTab.carga.test.tsx.

const LIMITE_LEITURAS_CICLO = 2;
const LIMITE_EDGE_CICLO = 1;

export type Fila = <T>(fn: () => Promise<T>) => Promise<T>;

export function criarFila(limite: number): Fila {
  if (!Number.isInteger(limite) || limite < 1) throw new Error(`criarFila: limite inválido (${limite})`);
  let ativas = 0;
  const espera: Array<() => void> = [];
  const liberar = () => {
    ativas -= 1;
    const proxima = espera.shift();
    if (proxima) proxima();
  };
  return <T>(fn: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      const rodar = () => {
        ativas += 1;
        // fn() pode lançar SÍNCRONO: Promise.resolve().then(fn) converte em rejeição e a vaga é devolvida igual.
        Promise.resolve().then(fn).then(resolve, reject).finally(liberar);
      };
      if (ativas < limite) rodar();
      else espera.push(rodar);
    });
}

/** Faixa das RPCs/tabelas pesadas da aba (fin_ciclo_*, receita diária) — inclusive os retries. */
export const filaCiclo: Fila = criarFila(LIMITE_LEITURAS_CICLO);

/** Faixa da edge fin-cashflow-engine (uma chamada por empresa): separada, para a edge lenta não ocupar as vagas das RPCs. */
export const filaCicloEdge: Fila = criarFila(LIMITE_EDGE_CICLO);

/** Retry espaçado: 4 s, 8 s, … (teto 30 s). Somado à fila, o retry nunca refaz tudo em paralelo. */
export const retryDelayCiclo = (tentativa: number) => Math.min(4000 * 2 ** tentativa, 30_000);
