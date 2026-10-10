// Testa o CÓDIGO REAL de leaseIndisponivel (não uma cópia) no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/_shared/lease_test.ts
//
// O que está em jogo: este predicado decide entre "seguir SEM lease" (fail-open, correto SÓ na
// janela entre as publicações manuais de edge e migration no Lovable) e "lançar" (fail-closed,
// correto em todo o resto). Um FALSO POSITIVO silencia um lease quebrado e reabre a corrida
// last-writer-wins sem ninguém saber — por isso os negativos abaixo pesam mais que os positivos, e
// por isso o predicado olha SÓ o código do erro, sem nenhuma heurística de mensagem.
import {
  aplicarChunkCercado,
  classificarErroApply,
  decidirClaim,
  erroTransitorio,
  esperaClaimMs,
  leaseIndisponivel,
  type RespostaRpc,
} from "./lease.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

// ── POSITIVOS: só os dois códigos canônicos de "RPC ausente" ──

Deno.test("42883 (undefined_function do Postgres) = migration ainda nao aplicada", () => {
  assertEquals(leaseIndisponivel({ code: "42883", message: 'function public.claim_calculate_scores(text) does not exist' }), true);
});

Deno.test("PGRST202 (PostgREST nao achou a funcao) = migration ainda nao aplicada", () => {
  assertEquals(leaseIndisponivel({ code: "PGRST202", message: "Could not find the function public.claim_calculate_scores(p_run_id)" }), true);
});

Deno.test("o codigo basta: 42883 com mensagem generica segue reconhecido", () => {
  assertEquals(leaseIndisponivel({ code: "42883", message: "algo generico" }), true);
});

// ── NEGATIVOS: tudo que NAO e "funcao ausente" tem de ser fail-closed ──

Deno.test("timeout (57014) NAO e lease ausente -> fail-closed", () => {
  assertEquals(leaseIndisponivel({ code: "57014", message: "canceling statement due to statement timeout" }), false);
});

Deno.test("permissao negada (42501) NAO e lease ausente -> fail-closed", () => {
  assertEquals(leaseIndisponivel({ code: "42501", message: "permission denied for function claim_calculate_scores" }), false);
});

Deno.test("deadlock (40P01) NAO e lease ausente -> fail-closed", () => {
  assertEquals(leaseIndisponivel({ code: "40P01", message: "deadlock detected" }), false);
});

Deno.test("overload ambiguo (PGRST203) NAO e lease ausente -> fail-closed", () => {
  assertEquals(leaseIndisponivel({ code: "PGRST203", message: "Could not choose the best candidate function" }), false);
});

Deno.test("erro de rede sem code -> fail-closed", () => {
  assertEquals(leaseIndisponivel({ message: "network error" }), false);
});

Deno.test("erro vazio / null / undefined -> fail-closed (nunca presumir ausencia)", () => {
  assertEquals(leaseIndisponivel({}), false);
  assertEquals(leaseIndisponivel(null), false);
  assertEquals(leaseIndisponivel(undefined), false);
});

// ── O motivo de NAO haver ramo de mensagem (challenge /codex + auto-challenge) ──
// `does not exist` aparece em erros de OUTROS objetos. Se a TABELA do lease sumisse, ou uma coluna,
// um predicado que casasse a frase leria isso como "migration ainda nao aplicada" e a edge seguiria
// fail-open sobre um banco quebrado — reintroduzindo exatamente a corrupcao que o lease fecha.

Deno.test("42P01 relation nao existe (tabela do lease sumida) -> fail-closed, NAO fail-open", () => {
  assertEquals(leaseIndisponivel({ code: "42P01", message: 'relation "sync_state" does not exist' }), false);
});

Deno.test("42703 column nao existe -> fail-closed", () => {
  assertEquals(leaseIndisponivel({ code: "42703", message: 'column "metadata" does not exist' }), false);
});

Deno.test("SEM code, a frase 'does not exist' sozinha NAO basta -> fail-closed", () => {
  assertEquals(leaseIndisponivel({ message: 'relation "sync_state" does not exist' }), false);
  assertEquals(leaseIndisponivel({ message: 'function claim_calculate_scores does not exist' }), false);
});

Deno.test("'schema cache' de COLUNA desconhecida -> fail-closed", () => {
  assertEquals(leaseIndisponivel({ code: "PGRST204", message: "Could not find the 'foo' column of 'sync_state' in the schema cache" }), false);
});

// code nao-string (o supabase-js tipa como string, mas a resposta e JSON cru) nao pode coagir.
Deno.test("code nao-string nao coage para true", () => {
  assertEquals(leaseIndisponivel({ code: 42883 as unknown as string, message: "boom" }), false);
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// erroTransitorio — sem esta classificacao, erro PERMANENTE vira retry storm (achado /codex)
// ══════════════════════════════════════════════════════════════════════════════════════════════

Deno.test("sem code = rejeicao de fetch/rede -> transitorio (e O caso do transporte perdido)", () => {
  assertEquals(erroTransitorio({ message: "network error" }), true);
  assertEquals(erroTransitorio({}), true);
});

Deno.test("classe 08 (connection_exception) -> transitorio", () => {
  assertEquals(erroTransitorio({ code: "08006", message: "connection failure" }), true);
  assertEquals(erroTransitorio({ code: "08003" }), true);
  assertEquals(erroTransitorio({ code: "08P01" }), true);
});

Deno.test("timeout, deadlock, serializacao e conexoes esgotadas -> transitorios", () => {
  assertEquals(erroTransitorio({ code: "57014" }), true);  // query_canceled
  assertEquals(erroTransitorio({ code: "40P01" }), true);  // deadlock_detected
  assertEquals(erroTransitorio({ code: "40001" }), true);  // serialization_failure
  assertEquals(erroTransitorio({ code: "53300" }), true);  // too_many_connections
});

// Os PERMANENTES: retentar da exatamente o mesmo erro, so queimando wall-clock.
Deno.test("permissao, argumento, sintaxe e relacao ausente -> PERMANENTES (nao retenta)", () => {
  assertEquals(erroTransitorio({ code: "42501", message: "permission denied" }), false);
  assertEquals(erroTransitorio({ code: "22004", message: "p_run_id vazio" }), false);
  assertEquals(erroTransitorio({ code: "22023" }), false);
  assertEquals(erroTransitorio({ code: "42601" }), false);
  assertEquals(erroTransitorio({ code: "42P01", message: 'relation "sync_state" does not exist' }), false);
});

Deno.test("erroTransitorio: null/undefined -> false", () => {
  assertEquals(erroTransitorio(null), false);
  assertEquals(erroTransitorio(undefined), false);
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// decidirClaim — retry SO de transporte incerto
// ══════════════════════════════════════════════════════════════════════════════════════════════

Deno.test("claim bem-sucedido -> adquirido", () => {
  assertEquals(decidirClaim({ claimed: true }, 1, 2), "adquirido");
  assertEquals(decidirClaim({ claimed: true }, 2, 2), "adquirido");
});

// Lease ocupado NAO retenta: a versao anterior esperava para fechar a perda de frescor, e a
// calibragem nao fechava nada (tentativas em t=0/5/15s contra um run de ~29s medido em prod).
// Esperar sem fechar e pior que nao esperar — paga latencia e ainda mente sobre o furo.
Deno.test("lease ocupado (claimed=false) -> pular JA na 1a resposta", () => {
  assertEquals(decidirClaim({ claimed: false }, 1, 2), "pular");
  assertEquals(decidirClaim({ claimed: false }, 2, 2), "pular");
});

// null/undefined NAO e "ocupado": e resposta INVALIDA de uma RPC que devolve boolean. Trata-la como
// ocupado devolveria 200 "ja em andamento" sobre estado desconhecido — a troca de "nao consegui
// ler" por "nao existe" que o money-path proibe.
Deno.test("claimed null/ausente -> LANCA (resposta invalida nao vira 200 skipped)", () => {
  assertEquals(decidirClaim({ claimed: null }, 1, 2), "lancar");
  assertEquals(decidirClaim({}, 1, 2), "lancar");
  assertEquals(decidirClaim({ claimed: undefined }, 2, 2), "lancar");
});

// TRANSPORTE PERDIDO: retenta com o MESMO run_id — se o banco commitou e so a resposta se perdeu,
// o re-claim reconhece o dono; senao e um claim normal. Esgotado, fail-closed.
Deno.test("transporte incerto -> retenta e depois LANCA", () => {
  const erro = { code: "08006", message: "connection failure" };
  assertEquals(decidirClaim({ erro }, 1, 2), "esperar_e_retentar");
  assertEquals(decidirClaim({ erro }, 2, 2), "lancar");
});

Deno.test("erro de rede sem code tambem retenta (e o caso canonico)", () => {
  assertEquals(decidirClaim({ erro: { message: "fetch failed" } }, 1, 2), "esperar_e_retentar");
});

// Erro PERMANENTE lanca na 1a: retry storm so atrasa o inevitavel.
Deno.test("erro permanente -> LANCA na 1a tentativa (sem retry storm)", () => {
  assertEquals(decidirClaim({ erro: { code: "42501", message: "permission denied" } }, 1, 2), "lancar");
  assertEquals(decidirClaim({ erro: { code: "22004" } }, 1, 2), "lancar");
});

// A funcao ausente e decidida ANTES de qualquer retry.
Deno.test("funcao ausente -> seguir_sem_lease JA na 1a tentativa (nao gasta retry)", () => {
  assertEquals(decidirClaim({ erro: { code: "42883" } }, 1, 2), "seguir_sem_lease");
  assertEquals(decidirClaim({ erro: { code: "PGRST202" } }, 1, 2), "seguir_sem_lease");
});

// `erro` e avaliado ANTES de `claimed`: com erro presente, o claimed nao e confiavel.
Deno.test("erro tem precedencia sobre claimed", () => {
  assertEquals(decidirClaim({ claimed: true, erro: { code: "42501" } }, 1, 2), "lancar");
  assertEquals(decidirClaim({ claimed: true, erro: { code: "42883" } }, 1, 2), "seguir_sem_lease");
});

// Espera curta de proposito: cobre oscilacao de rede, nao run alheio. Nao pode ser 0 (busy-loop).
Deno.test("esperaClaimMs e curta, positiva e cresce", () => {
  assertEquals(esperaClaimMs(1), 2000);
  if (esperaClaimMs(1) <= 0) throw new Error("espera zero viraria busy-loop contra o banco");
  if (esperaClaimMs(2) <= esperaClaimMs(1)) throw new Error("a espera precisa crescer");
  // Com 2 tentativas a espera total e 2s — nao move a agulha do wall-clock do edge (150s Free).
  if (esperaClaimMs(1) > 5000) throw new Error("espera longa demais para cobrir so transporte");
});

// ── classificarErroApply: o FENCING do apply (migration 20261010120000) ──
// O que pesa aqui: confundir "perdi o lease" com qualquer outra coisa. Ler 55000 como `falha` só
// troca a mensagem; ler um erro qualquer como `fencing_indisponivel` faria a edge REFAZER o chunk
// SEM token — contornando a cerca num banco que a tem. Por isso os negativos do atalho pesam mais.

Deno.test("apply sem erro = ok (com e sem token)", () => {
  assertEquals(classificarErroApply(null, true), "ok");
  assertEquals(classificarErroApply(undefined, false), "ok");
});

Deno.test("55000 com token = lease_perdido (o banco recusou: outro run e dono)", () => {
  assertEquals(classificarErroApply({ code: "55000", message: "x" }, true), "lease_perdido");
});

Deno.test("55000 SEM token NAO e lease_perdido (a RPC nem consultou o lease)", () => {
  assertEquals(classificarErroApply({ code: "55000" }, false), "falha");
});

Deno.test("PGRST202/42883 com token = fencing_indisponivel (edge nova antes da migration)", () => {
  assertEquals(classificarErroApply({ code: "PGRST202" }, true), "fencing_indisponivel");
  assertEquals(classificarErroApply({ code: "42883" }, true), "fencing_indisponivel");
});

Deno.test("PGRST202 SEM token = falha (a RPC inteira sumiu — nao ha para onde cair)", () => {
  assertEquals(classificarErroApply({ code: "PGRST202" }, false), "falha");
});

Deno.test("o atalho sem token NAO dispara por erro qualquer (so codigo, zero heuristica de texto)", () => {
  // cada um destes, lido como fencing_indisponivel, faria a edge reescrever SEM a cerca
  for (const code of ["22004", "23514", "42501", "57014", "08006", "42P01", ""]) {
    assertEquals(classificarErroApply({ code, message: "function does not exist" }, true), "falha",
      `codigo [${code}] nao pode virar fencing_indisponivel`);
  }
});

Deno.test("22004 (p_run_id vazio) e falha, nao lease_perdido", () => {
  assertEquals(classificarErroApply({ code: "22004" }, true), "falha");
});

// ── aplicarChunkCercado: o fallback sem token NUNCA desliga a cerca do run (challenge Codex P1) ──
// RPC simulada: registra cada chamada (com ou sem token) e responde por roteiro.
function rpcRoteiro(respostas: RespostaRpc[]) {
  const chamadas: string[] = [];
  const rpc = (args: Record<string, unknown>) => {
    chamadas.push("p_run_id" in args ? `token:${String(args.p_run_id)}` : "sem_token");
    const r = respostas.shift();
    if (!r) throw new Error("roteiro esgotado — chamada a mais");
    return Promise.resolve(r);
  };
  return { rpc, chamadas };
}
const OK = (n: number): RespostaRpc => ({ data: n, error: null });
const E = (code: string): RespostaRpc => ({ data: null, error: { code, message: "x" } });
const semDormir = () => Promise.resolve();

Deno.test("chunk: cache velho num banco COM a cerca — espera, re-tenta COM token e escreve cercado", async () => {
  const { rpc, chamadas } = rpcRoteiro([E("PGRST202"), OK(500)]);
  const esperas: number[] = [];
  const r = await aplicarChunkCercado(rpc, [1], "run-A", { esperouCache: false }, 2000, (ms) => {
    esperas.push(ms);
    return Promise.resolve();
  });
  assertEquals([r.desfecho, r.semFencing, chamadas, esperas], ["ok", false, ["token:run-A", "token:run-A"], [2000]]);
});

Deno.test("chunk: cache velho + o run PERDEU o lease — a re-tentativa com token recebe 55000, nunca grava sem token", async () => {
  const { rpc, chamadas } = rpcRoteiro([E("PGRST202"), E("55000")]);
  const r = await aplicarChunkCercado(rpc, [1], "run-A", { esperouCache: false }, 0, semDormir);
  assertEquals([r.desfecho, r.semFencing, chamadas], ["lease_perdido", false, ["token:run-A", "token:run-A"]]);
});

Deno.test("run: banco SEM a cerca — 1o chunk espera 1x e cai; o 2o tenta COM token de novo, sem esperar", async () => {
  const estado = { esperouCache: false };
  const esperas: number[] = [];
  const dormir = (ms: number) => { esperas.push(ms); return Promise.resolve(); };
  const c1 = rpcRoteiro([E("PGRST202"), E("PGRST202"), OK(500)]);
  const r1 = await aplicarChunkCercado(c1.rpc, [1], "run-A", estado, 2000, dormir);
  assertEquals([r1.desfecho, r1.semFencing, c1.chamadas], ["ok", true, ["token:run-A", "token:run-A", "sem_token"]]);
  const c2 = rpcRoteiro([E("PGRST202"), OK(500)]);
  const r2 = await aplicarChunkCercado(c2.rpc, [1], "run-A", estado, 2000, dormir);
  assertEquals([r2.desfecho, r2.semFencing, c2.chamadas, esperas], ["ok", true, ["token:run-A", "sem_token"], [2000]]);
});

Deno.test("run: o cache recarrega no meio do run — o chunk seguinte VOLTA a ser cercado (token nao foi desligado)", async () => {
  const estado = { esperouCache: true }; // o run já caiu sem token num chunk anterior
  const c = rpcRoteiro([E("55000")]);
  const r = await aplicarChunkCercado(c.rpc, [1], "run-A", estado, 0, semDormir);
  assertEquals([r.desfecho, r.semFencing, c.chamadas], ["lease_perdido", false, ["token:run-A"]]);
});

Deno.test("chunk: sem lease (token null) — uma chamada SEM a chave, sem espera, sem p_run_id:null", async () => {
  const c = rpcRoteiro([OK(7)]);
  const r = await aplicarChunkCercado(c.rpc, [1], null, { esperouCache: false }, 2000, () => {
    throw new Error("nao devia esperar");
  });
  assertEquals([r.desfecho, r.semFencing, c.chamadas], ["ok", false, ["sem_token"]]);
});

Deno.test("chunk: falha comum com token NAO dispara o fallback sem token", async () => {
  const c = rpcRoteiro([E("57014")]);
  const r = await aplicarChunkCercado(c.rpc, [1], "run-A", { esperouCache: false }, 0, semDormir);
  assertEquals([r.desfecho, r.semFencing, c.chamadas], ["falha", false, ["token:run-A"]]);
});
