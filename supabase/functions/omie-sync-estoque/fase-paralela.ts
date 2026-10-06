// Fase de varredura disparada EM PARALELO com outra, com a rejeição capturada na criação.
//
// Por que existe (incidente 2026-10-05 17:40Z, net._http_response 104687): o run lia o ListarPosEstoque
// inteiro (~45s, 75 páginas) e SÓ DEPOIS a fase do PO (PesquisarPedCompra, ~3-4s). Com o Omie ~1,6× mais
// lento, a fase do PO esbarrou no deadline do run, e o throw — fatal por desenho (Codex P1 2026-06-20) —
// descartou o físico que já tinha sido lido. Disparada no início, a fase do PO sai da cauda do run.
//
// Contrato:
//  - `dispararFase(fn)` chama `fn` AGORA. A promise interna NUNCA rejeita: o desfecho é capturado na
//    criação. No Deno, rejeição sem handler encerra o isolate — e o caller só olha a fase DEPOIS do laço
//    do físico, que pode lançar antes (deadline, fault) e nunca chegar a aguardá-la.
//  - `falhaJaConhecida()` é síncrona: `{ erro }` se a fase JÁ terminou falhando, senão null. É o gancho do
//    aborto cedo — com a semântica fatal, seguir lendo o físico depois disso só queima chamadas ao Omie.
//  - `resultado()` aguarda e devolve o valor; se a fase falhou, RELANÇA o erro original (mesma referência).
//    Converter falha em "não confiável" seria decisão do caller — este helper não decide nada.
//  - `duracaoMs()` mede do disparo ao desfecho no relógio injetado (null enquanto a fase roda).

export interface FaseParalela<T> {
  falhaJaConhecida(): { erro: unknown } | null;
  resultado(): Promise<T>;
  duracaoMs(): number | null;
}

type Desfecho<T> = { ok: true; valor: T } | { ok: false; erro: unknown };

export function dispararFase<T>(fn: () => Promise<T>, relogio: () => number = Date.now): FaseParalela<T> {
  const inicio = relogio();
  let fim: number | null = null;
  let falha: { erro: unknown } | null = null;
  // A IIFE async roda `fn` de forma síncrona até o 1º await: a fase começa já, e um throw síncrono dentro
  // de `fn` vira rejeição (capturada logo abaixo) em vez de explodir no disparo.
  const desfecho: Promise<Desfecho<T>> = (async () => await fn())().then(
    (valor): Desfecho<T> => {
      fim = relogio();
      return { ok: true, valor };
    },
    (erro: unknown): Desfecho<T> => {
      fim = relogio();
      falha = { erro };
      return { ok: false, erro };
    },
  );
  return {
    falhaJaConhecida: () => falha,
    duracaoMs: () => (fim === null ? null : fim - inicio),
    resultado: async () => {
      const d = await desfecho;
      if (!d.ok) throw d.erro;
      return d.valor;
    },
  };
}
