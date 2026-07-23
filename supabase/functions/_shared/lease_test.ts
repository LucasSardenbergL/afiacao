// Testa o CÓDIGO REAL de leaseIndisponivel (não uma cópia) no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/_shared/lease_test.ts
//
// O que está em jogo: este predicado decide entre "seguir SEM lease" (fail-open declarado, correto só
// na janela entre as publicações manuais de edge e migration no Lovable) e "lançar" (fail-closed,
// correto em todo o resto). Um FALSO POSITIVO silencia um lease quebrado e reabre a corrida
// last-writer-wins sem ninguém saber — por isso os negativos abaixo pesam mais que os positivos.
import { leaseIndisponivel } from "./lease.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

Deno.test("42883 (undefined_function do Postgres) = migration ainda nao aplicada", () => {
  assertEquals(leaseIndisponivel({ code: "42883", message: 'function public.claim_calculate_scores(text) does not exist' }), true);
});

Deno.test("PGRST202 (PostgREST nao achou a funcao) = migration ainda nao aplicada", () => {
  assertEquals(leaseIndisponivel({ code: "PGRST202", message: "Could not find the function public.claim_calculate_scores(p_run_id)" }), true);
});

Deno.test("sem code, mas a mensagem diz 'does not exist' -> ausente", () => {
  assertEquals(leaseIndisponivel({ message: 'function public.claim_calculate_scores(text) does not exist' }), true);
});

// ── NEGATIVOS: tudo que NAO e "funcao ausente" tem de ser fail-closed ──

Deno.test("timeout (57014) NAO e lease ausente -> fail-closed", () => {
  assertEquals(leaseIndisponivel({ code: "57014", message: "canceling statement due to statement timeout" }), false);
});

Deno.test("permissao negada (42501) NAO e lease ausente -> fail-closed", () => {
  assertEquals(leaseIndisponivel({ code: "42501", message: "permission denied for function claim_calculate_scores" }), false);
});

Deno.test("deadlock/erro generico NAO e lease ausente -> fail-closed", () => {
  assertEquals(leaseIndisponivel({ code: "40P01", message: "deadlock detected" }), false);
});

Deno.test("erro de rede sem code nem mensagem reconhecivel -> fail-closed", () => {
  assertEquals(leaseIndisponivel({ message: "network error" }), false);
});

Deno.test("erro vazio / null / undefined -> fail-closed (nunca presumir ausencia)", () => {
  assertEquals(leaseIndisponivel({}), false);
  assertEquals(leaseIndisponivel(null), false);
  assertEquals(leaseIndisponivel(undefined), false);
});

// A armadilha que motivou a ancora estreita: 'schema cache' aparece em erros do PostgREST que NAO
// sao "funcao ausente" (coluna/relacao desconhecida). Casar a expressao solta faria um erro de
// contrato virar fail-open — exatamente o modo de falha que este predicado existe para evitar.
Deno.test("'schema cache' de COLUNA desconhecida NAO e lease ausente -> fail-closed", () => {
  assertEquals(leaseIndisponivel({ code: "PGRST204", message: "Could not find the 'foo' column of 'sync_state' in the schema cache" }), false);
});

// code nao-string (o supabase-js tipa como string, mas a resposta e JSON cru) nao pode quebrar nem
// virar true por coercao.
Deno.test("code nao-string nao coage para true", () => {
  assertEquals(leaseIndisponivel({ code: 42883 as unknown as string, message: "boom" }), false);
});

// ── APERTO do ramo SEM code (auto-challenge): 'does not exist' tambem aparece em erros de OUTROS
// objetos. Se a TABELA do lease sumisse, ler isso como "migration ainda nao aplicada" faria a edge
// seguir fail-open sobre um banco quebrado — falso positivo que troca um problema grave por um
// aviso benigno. Com o nome da funcao informado, a mensagem tem de citar A FUNCAO.

Deno.test("SEM code: 'relation sync_state does not exist' NAO e lease ausente quando o nome e exigido", () => {
  const erro = { message: 'relation "sync_state" does not exist' };
  assertEquals(leaseIndisponivel(erro, "claim_calculate_scores"), false);
});

Deno.test("SEM code: a mensagem que cita A FUNCAO segue reconhecida", () => {
  const erro = { message: 'function public.claim_calculate_scores(text) does not exist' };
  assertEquals(leaseIndisponivel(erro, "claim_calculate_scores"), true);
});

Deno.test("SEM code e sem nome exigido, mantem o comportamento permissivo (retrocompat do helper)", () => {
  assertEquals(leaseIndisponivel({ message: 'relation "sync_state" does not exist' }), true);
});

// O aperto vale SO para o ramo sem code: um 42883 legitimo continua reconhecido mesmo que a
// mensagem nao cite a funcao (o codigo do Postgres ja e prova suficiente).
Deno.test("COM code 42883, o nome exigido nao estreita demais", () => {
  assertEquals(leaseIndisponivel({ code: "42883", message: "algo generico" }, "claim_calculate_scores"), true);
});
