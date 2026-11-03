// Integra o CÓDIGO REAL de cr-incremental.ts (executarIncrementalCR) com o de omie-chamada.ts
// (chamarOmieComPolitica) sob UM relógio e UM budget, contra um Omie falso com a trava pós-vazia
// medida na oben em 2026-11-03. Pedido do Codex (resfriamento, P1): os testes de cada módulo, isolados,
// não provam que provas vazias em série cabem no budget — cada uma resfria 10 s.
// Roda com: deno test --no-remote supabase/functions/omie-financeiro/cr-incremental-relogio_test.ts
import { type DepsIncrementalCR, executarIncrementalCR, RESERVA_FECHAMENTO_MS } from "./cr-incremental.ts";
import { chamarOmieComPolitica, type DepsChamadaOmie, respostaVazia } from "./omie-chamada.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

const BUDGET_MS = 100_000; // TIME_BUDGET_MS do index.ts
const TRAVA_MS = 6_000;
const VAZIA = { pagina: 0, total_de_paginas: 0, registros: 0, total_de_registros: 0 };
const JANELA = { de: "01/11/2026", ate: "02/11/2026", marca: "2026-11-02T08:20:00.000Z" };
const CHAVE = "oben:financas/contareceber/:ListarContasReceber";

/** Run inteiro: A e B vazias, `n` candidatos de clientes distintos, TODAS as provas vazias. */
function cenario(n: number, opts: { inicioMs?: number } = {}) {
  let agora = opts.inicioMs ?? 0;
  let travadoAte = -1;
  let recusas = 0;
  const log: string[] = [];
  const dc: DepsChamadaOmie = {
    enviar: () => {
      agora += 300;
      if (agora < travadoAte) {
        recusas++;
        return Promise.resolve(new Response(JSON.stringify({ faultstring: "ERROR: Já existe uma requisição desse método sendo executada" }), { status: 500 }));
      }
      travadoAte = agora + TRAVA_MS; // toda resposta deste cenário é vazia
      return Promise.resolve(new Response(JSON.stringify(VAZIA), { status: 200 }));
    },
    classificar: () => "fatal",
    dormir: (ms) => {
      agora += ms;
      return Promise.resolve();
    },
    agora: () => agora,
    orcamentoEsgotado: () => agora >= BUDGET_MS,
    orcamentoRestanteMs: () => BUDGET_MS - agora,
    log: () => {},
    aoChamar: () => {},
    aoRateLimit: () => {},
    ultimaVazia: new Map(),
  };
  // Mesma regra do laço estrito: null (pausa) não é fim — o retrato fica incompleto e LANÇA.
  const listar = async (rotulo: string, params: Record<string, unknown>) => {
    const r = await chamarOmieComPolitica("oben", CHAVE, JSON.stringify(params), dc);
    if (r === null) throw new Error(`${rotulo}: sem_fim_real`);
    if (!respostaVazia(r)) throw new Error(`${rotulo}: o falso só devolve vazia`);
    return r;
  };
  const deps: DepsIncrementalCR = {
    listarEstrito: async (filtros) => {
      await listar("estrito", { pagina: 1, ...filtros });
      return { paginas: 1, totalSynced: 0 };
    },
    marcarAusentes: () =>
      Promise.resolve({
        data: {
          marcados: n,
          limpos: 0,
          candidatos: Array.from({ length: n }, (_, i) => ({ codigo: 100 + i, cliente: 500 + i, emissao: "2026-10-01" })),
        },
        error: null,
      }),
    listarProva: async (cliente, jan) => {
      const r = await listar(`prova ${cliente}`, { pagina: 1, filtrar_cliente: cliente, de: jan.de, ate: jan.ate });
      return { totalDePaginas: r.total_de_paginas, totalDeRegistros: r.total_de_registros, titulos: [] };
    },
    excluirConfirmados: (cs) => {
      log.push(`C3:${cs.length}`);
      return Promise.resolve({ data: { excluidos: cs.length }, error: null });
    },
    gravarMarca: () => {
      log.push("MARCA");
      return Promise.resolve();
    },
    orcamentoRestanteMs: () => BUDGET_MS - agora,
    agoraIso: () => "2026-11-02T08:21:00.000Z",
    embaralhar: (xs) => xs,
  };
  return { deps, log, agora: () => agora, recusas: () => recusas };
}

Deno.test("10 provas vazias em série: o run FECHA dentro do budget — adia o resto, exclui, grava a marca", async () => {
  const c = cenario(10);
  const r = await executarIncrementalCR(JANELA, c.deps);
  if (r.reconciliacao !== "ok") throw new Error(`esperava ok, veio ${r.reconciliacao}`);
  assertEquals(c.log.at(-1), "MARCA", "a marca tem de ser gravada");
  assertEquals(r.adiados > 0, true, "com 10 resfriamentos o budget não comporta todas — o resto é adiado");
  assertEquals(r.excluidos + r.adiados, 10);
  assertEquals(c.recusas(), 0, "nenhuma chamada bateu na trava");
  assertEquals(c.agora() <= BUDGET_MS, true, `passou do budget: ${c.agora()} ms`);
});

Deno.test("run que começa tarde (restante < reserva): zero provas, mas fecha e grava a marca", async () => {
  // A sai em ~5 s do teto da reserva; B ainda resfria ~10 s atrás de A — depois de B, restante < reserva.
  const c = cenario(3, { inicioMs: BUDGET_MS - RESERVA_FECHAMENTO_MS - 5_000 });
  const r = await executarIncrementalCR(JANELA, c.deps);
  if (r.reconciliacao !== "ok") throw new Error(`esperava ok, veio ${r.reconciliacao}`);
  assertEquals(r.adiados, 3);
  assertEquals(c.log, ["MARCA"]);
});
