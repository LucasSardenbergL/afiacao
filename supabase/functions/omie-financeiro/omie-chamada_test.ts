// Testa o CÓDIGO REAL de omie-chamada.ts no runtime real (Deno), contra um Omie falso que reproduz
// o comportamento medido na oben em 2026-11-03 (ver o cabeçalho do módulo):
//  - depois de uma resposta vazia, o método fica travado por TRAVA_MS (HTTP 500 + Client-1880);
//  - um corpo já recusado volta como "Consumo redundante" (HTTP 500 + Client-6) enquanto durar.
// Roda com: deno test --no-remote supabase/functions/omie-financeiro/omie-chamada_test.ts
import {
  chamarOmieComPolitica,
  type ClasseFaultOmie,
  type DepsChamadaOmie,
  RESFRIAMENTO_POS_VAZIA_MS,
  respostaVazia,
} from "./omie-chamada.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

/** Exige que lance com a MARCA do ramo — "lançou algo" não prova o ramo. */
async function rejeitaCom(p: Promise<unknown>, marca: string) {
  let msg: string | null = null;
  try {
    await p;
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
  }
  if (msg === null) throw new Error(`esperava lançar com "${marca}", mas resolveu`);
  if (!msg.includes(marca)) throw new Error(`lançou com outra marca: "${msg}" (esperava "${marca}")`);
}

const CONCORRENTE = "ERROR: Já existe uma requisição desse método sendo executada e você pode tentar novamente em alguns instantes. (1)";
const REDUNDANTE = "ERROR: Consumo redundante detectado. Aguarde 1 segundos para tentar novamente (REDUNDANT).";
const TRAVA_MS = 6_000;

type Pagina = Record<string, unknown>;

/** Omie falso com relógio próprio: `dormir` avança o tempo, cada envio custa 300 ms. */
function omieFalso(paginas: Record<string, Pagina>, opts: { orcamentoRestanteMs?: () => number } = {}) {
  let agora = 0;
  let travadoAte = -1;
  const recusados = new Set<string>();
  const envios: { em: number; corpo: string; status: number }[] = [];
  const sonos: number[] = [];
  const resposta = (status: number, corpo: unknown) =>
    new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } });
  const deps: DepsChamadaOmie = {
    enviar: (corpo) => {
      agora += 300;
      let r: Response;
      if (recusados.has(corpo)) {
        r = resposta(500, { faultstring: REDUNDANTE, faultcode: "SOAP-ENV:Client-6" });
      } else if (agora < travadoAte) {
        recusados.add(corpo);
        r = resposta(500, { faultstring: CONCORRENTE, faultcode: "SOAP-ENV:Client-1880" });
      } else {
        const p = paginas[corpo];
        if (!p) throw new Error(`corpo sem roteiro no falso: ${corpo}`);
        if (respostaVazia(p)) travadoAte = agora + TRAVA_MS;
        r = resposta(200, p);
      }
      envios.push({ em: agora, corpo, status: r.status });
      return Promise.resolve(r);
    },
    classificar: (fs): ClasseFaultOmie => (fs.includes("REDUNDANT") || fs.includes("Já existe") ? "rate_limit" : "fatal"),
    dormir: (ms) => {
      sonos.push(ms);
      agora += ms;
      return Promise.resolve();
    },
    agora: () => agora,
    orcamentoEsgotado: () => (opts.orcamentoRestanteMs?.() ?? Number.POSITIVE_INFINITY) <= 0,
    orcamentoRestanteMs: opts.orcamentoRestanteMs ?? (() => Number.POSITIVE_INFINITY),
    log: () => {},
    aoChamar: () => {},
    aoRateLimit: () => {},
    ultimaVazia: new Map(),
  };
  return { deps, envios, sonos };
}

const CHAVE = "oben:financas/contareceber/:ListarContasReceber";
const A_CHEIA = JSON.stringify({ pagina: 9, filtro: "aberto" });
const A_VAZIA = JSON.stringify({ pagina: 10, filtro: "aberto" });
const B_P1 = JSON.stringify({ pagina: 1, filtro: "alteracao" });
const ROTEIRO: Record<string, Pagina> = {
  [A_CHEIA]: { pagina: 9, total_de_paginas: 9, registros: 48, total_de_registros: 848, conta_receber_cadastro: [] },
  [A_VAZIA]: { pagina: 0, total_de_paginas: 0, registros: 0, total_de_registros: 0 },
  [B_P1]: { pagina: 1, total_de_paginas: 1, registros: 45, total_de_registros: 45, conta_receber_cadastro: [] },
};

Deno.test("regressão 14:20: A termina vazia e B logo depois PASSA — resfria em vez de bater na trava", async () => {
  const { deps, envios, sonos } = omieFalso(ROTEIRO);
  await chamarOmieComPolitica("oben", CHAVE, A_VAZIA, deps);
  const b = await chamarOmieComPolitica("oben", CHAVE, B_P1, deps);
  assertEquals(b?.total_de_registros, 45);
  assertEquals(envios.map((e) => e.status), [200, 200], "nenhuma recusa: a 2ª chamada esperou a trava passar");
  assertEquals(sonos.length, 1, "um único sono, o do resfriamento");
  assertEquals(envios[1].em - envios[0].em >= RESFRIAMENTO_POS_VAZIA_MS, true, "B saiu só depois do resfriamento");
});

Deno.test("resfriamento supera a trava medida (o número não pode cair abaixo do observado)", () => {
  assertEquals(RESFRIAMENTO_POS_VAZIA_MS > TRAVA_MS, true);
});

Deno.test("resposta CHEIA não resfria: páginas de A seguidas não ganham sono", async () => {
  const { deps, sonos } = omieFalso(ROTEIRO);
  await chamarOmieComPolitica("oben", CHAVE, A_CHEIA, deps);
  await chamarOmieComPolitica("oben", CHAVE, B_P1, deps);
  assertEquals(sonos, []);
});

Deno.test("o resfriamento é por empresa+método: outra chave não espera", async () => {
  const { deps, sonos } = omieFalso(ROTEIRO);
  deps.ultimaVazia.set(CHAVE, deps.agora()); // a oben acabou de receber uma vazia
  deps.enviar = () => Promise.resolve(new Response(JSON.stringify(ROTEIRO[B_P1]), { status: 200 }));
  const r = await chamarOmieComPolitica("colacor", "colacor:financas/contareceber/:ListarContasReceber", B_P1, deps);
  assertEquals(r?.total_de_registros, 45);
  assertEquals(sonos, [], "a colacor dormiu o resfriamento da oben");
  const r2 = await chamarOmieComPolitica("oben", CHAVE, B_P1, deps);
  assertEquals(r2?.total_de_registros, 45);
  assertEquals(sonos.length, 1, "controle: a PRÓPRIA chave resfria");
});

Deno.test("o resfriamento não cabe no budget: devolve null (pausa), NÃO dorme e NÃO envia (Codex P2)", async () => {
  let restante = Number.POSITIVE_INFINITY;
  const { deps, envios, sonos } = omieFalso(ROTEIRO, { orcamentoRestanteMs: () => restante });
  await chamarOmieComPolitica("oben", CHAVE, A_VAZIA, deps);
  restante = 5_000; // ainda há budget, mas menos que os ~10 s de resfriamento
  const r = await chamarOmieComPolitica("oben", CHAVE, B_P1, deps);
  assertEquals(r, null);
  assertEquals(envios.length, 1, "não pode ter enviado B");
  assertEquals(sonos, [], "não pode dormir além do budget");
});

Deno.test("concorrência sem budget para a espera: lança na hora com o fault, sem dormir", async () => {
  const { deps, envios, sonos } = omieFalso(ROTEIRO, { orcamentoRestanteMs: () => 6_000 });
  await chamarOmieComPolitica("oben", CHAVE, A_VAZIA, deps);
  deps.ultimaVazia.clear();
  await rejeitaCom(chamarOmieComPolitica("oben", CHAVE, B_P1, deps), "HTTP 500 — ERROR: Já existe uma requisição");
  assertEquals(envios.length, 2);
  assertEquals(sonos, []);
});

Deno.test("500 de concorrência: espera como rate-limit; o reenvio idêntico (REDUNDANT) lança NA HORA com o fault", async () => {
  // Sem resfriamento (mapa limpo após a vazia) para forçar a trava — o caminho de defesa em profundidade.
  const { deps, envios, sonos } = omieFalso(ROTEIRO);
  await chamarOmieComPolitica("oben", CHAVE, A_VAZIA, deps);
  deps.ultimaVazia.clear();
  await rejeitaCom(chamarOmieComPolitica("oben", CHAVE, B_P1, deps), "HTTP 500 — ERROR: Consumo redundante");
  assertEquals(envios.map((e) => e.status), [200, 500, 500], "concorrente → 1 espera → REDUNDANT → para (repetir renova a trava)");
  assertEquals(sonos, [7_000], "a espera da concorrência é a do rate-limit (7 s), não o backoff de 1 s");
});

Deno.test("500 com REDUNDANT logo de cara: 1 envio só, lança com o fault", async () => {
  const { deps, envios } = omieFalso(ROTEIRO);
  await chamarOmieComPolitica("oben", CHAVE, A_VAZIA, deps);
  deps.ultimaVazia.clear();
  await chamarOmieComPolitica("oben", CHAVE, B_P1, deps).catch(() => {});
  const antes = envios.length;
  await rejeitaCom(chamarOmieComPolitica("oben", CHAVE, B_P1, deps), "REDUNDANT");
  assertEquals(envios.length - antes, 1);
});

Deno.test("5xx SEM fault de cota mantém o comportamento anterior: 4 tentativas e lança com o status", async () => {
  let n = 0;
  const { deps } = omieFalso(ROTEIRO);
  deps.enviar = () => {
    n++;
    return Promise.resolve(new Response("<html>bad gateway</html>", { status: 502 }));
  };
  await rejeitaCom(chamarOmieComPolitica("oben", CHAVE, B_P1, deps), "Omie (oben): HTTP 502");
  assertEquals(n, 4);
});

Deno.test("5xx com fault NÃO de cota: retenta como antes e lança com o fault na mensagem", async () => {
  let n = 0;
  const { deps } = omieFalso(ROTEIRO);
  deps.enviar = () => {
    n++;
    return Promise.resolve(new Response(JSON.stringify({ faultstring: "ERROR: Broken response" }), { status: 500 }));
  };
  await rejeitaCom(chamarOmieComPolitica("oben", CHAVE, B_P1, deps), "HTTP 500 — ERROR: Broken response");
  assertEquals(n, 4);
});

Deno.test("respostaVazia: só zero EXPLÍCITO é vazio — ausente não é zero", () => {
  assertEquals(respostaVazia({ total_de_registros: 0 }), true);
  assertEquals(respostaVazia({ registros: "0" }), true);
  assertEquals(respostaVazia({}), false);
  assertEquals(respostaVazia({ total_de_registros: null, registros: undefined }), false);
  assertEquals(respostaVazia({ total_de_registros: 45, registros: 45 }), false);
});
