// Testa o CÓDIGO REAL de leaseIndisponivel (não uma cópia) no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/_shared/lease_test.ts
//
// O que está em jogo: este predicado decide entre "seguir SEM lease" (fail-open, correto SÓ na
// janela entre as publicações manuais de edge e migration no Lovable) e "lançar" (fail-closed,
// correto em todo o resto). Um FALSO POSITIVO silencia um lease quebrado e reabre a corrida
// last-writer-wins sem ninguém saber — por isso os negativos abaixo pesam mais que os positivos, e
// por isso o predicado olha SÓ o código do erro, sem nenhuma heurística de mensagem.
import { leaseIndisponivel } from "./lease.ts";

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
