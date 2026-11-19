// Asserts locais em vez de std/assert remoto: `test:edges` roda com `--no-remote`.
import { decidirCredencial, obterSenhaPortal } from "./sayerlack-credencial.ts";

function assertEquals(atual: unknown, esperado: unknown) {
  const a = JSON.stringify(atual);
  const e = JSON.stringify(esperado);
  if (a !== e) throw new Error(`esperado ${e}, veio ${a}`);
}

Deno.test("credencial: Vault com ativa → usa a do Vault, mesmo havendo env", () => {
  assertEquals(decidirCredencial({ senha: "Vault123abc", origem: "vault", bloqueio: null }, null, "EnvVelha99"),
    { ok: true, senha: "Vault123abc", origem: "vault" });
});

Deno.test("credencial: bootstrap só quando a RPC disse env_bootstrap", () => {
  assertEquals(decidirCredencial({ senha: null, origem: "env_bootstrap", bloqueio: null }, null, "EnvAtual99"),
    { ok: true, senha: "EnvAtual99", origem: "env_bootstrap" });
});

Deno.test("credencial: erro na RPC NÃO cai no env (fail-closed)", () => {
  const r = decidirCredencial(null, "connection refused", "EnvAtual99");
  assertEquals(r.ok ? "ok" : r.erroTipo, "CREDENCIAL_INDISPONIVEL");
});

Deno.test("credencial: rotação em curso bloqueia mesmo com senha no Vault", () => {
  const r = decidirCredencial({ senha: "Vault123abc", origem: "vault", bloqueio: "rotacao_em_andamento" }, null, "x");
  assertEquals(r.ok ? "ok" : r.erroTipo, "CREDENCIAL_BLOQUEADA");
});

Deno.test("credencial: origem desconhecida recusa", () => {
  const r = decidirCredencial({ senha: "a", origem: "outra", bloqueio: null }, null, "x");
  assertEquals(r.ok ? "ok" : r.erroTipo, "CREDENCIAL_INDISPONIVEL");
});

Deno.test("obterSenhaPortal: rpc que LANÇA vira indisponível, não env", async () => {
  const db = { rpc: () => { throw new Error("rede caiu"); } };
  const r = await obterSenhaPortal(db, "EnvAtual99");
  assertEquals(r.ok ? "ok" : r.erroTipo, "CREDENCIAL_INDISPONIVEL");
});

Deno.test("obterSenhaPortal: lê a 1ª linha do array da RPC", async () => {
  const db = { rpc: () => Promise.resolve({ data: [{ senha: "Vault123abc", origem: "vault", bloqueio: null }], error: null }) };
  assertEquals(await obterSenhaPortal(db, null), { ok: true, senha: "Vault123abc", origem: "vault" });
});
