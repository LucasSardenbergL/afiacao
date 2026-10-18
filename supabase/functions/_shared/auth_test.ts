// auth_test.ts — o gate canônico `authorizeCronOrStaff` (e os irmãos `authorizeCron`/`authorizeMaster`)
// EXECUTADO, não lido: cron secret, service role, JWT staff, anon, role errada, fail-closed.
// Não existia (lote H do plano de melhoria v2, 2026-10-18): 13 edges carregavam cópia local do gate
// e nada provava o comportamento do canônico por execução.
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/_shared/auth_test.ts
import { ENV_TESTE, igual, instalarHarness } from "./harness-handler.ts";

const env = { ...ENV_TESTE };
const h = instalarHarness(env);
// Importa DEPOIS dos stubs: o módulo lê SUPABASE_URL/SERVICE_ROLE no topo.
const { authorizeCron, authorizeCronOrStaff, authorizeMaster } = await import("./auth.ts");

const URL_EDGE = `${ENV_TESTE.SUPABASE_URL}/functions/v1/qualquer`;
const req = (headers: Record<string, string>) => new Request(URL_EDGE, { method: "POST", headers });

async function corpoDe(res: Response): Promise<unknown> {
  return await res.json();
}

Deno.test("authorizeCronOrStaff: x-cron-secret válido → ok via cron, ZERO fetch", async () => {
  h.limpar();
  const r = await authorizeCronOrStaff(req({ "x-cron-secret": ENV_TESTE.CRON_SECRET }));
  igual(r, { ok: true, via: "cron" }, "resultado");
  igual(h.chamadas.length, 0, "o cron-secret decide sem rede");
});

Deno.test("authorizeCronOrStaff: sem header nenhum → {ok:false} com 401, ZERO fetch", async () => {
  h.limpar();
  const r = await authorizeCronOrStaff(req({}));
  igual(r.ok, false, "ok");
  if (r.ok) throw new Error("inalcançável");
  igual(r.response.status, 401, "status");
  igual(await corpoDe(r.response), { error: "Unauthorized" }, "corpo");
  igual(h.chamadas.length, 0, "anon não gera rede");
});

Deno.test("authorizeCronOrStaff: x-cron-secret ERRADO e sem Bearer → 401, ZERO fetch", async () => {
  h.limpar();
  const r = await authorizeCronOrStaff(req({ "x-cron-secret": "errado" }));
  igual(r.ok, false, "ok");
  if (r.ok) throw new Error("inalcançável");
  igual(r.response.status, 401, "status");
  await r.response.body?.cancel();
  igual(h.chamadas.length, 0, "zero fetch");
});

Deno.test("authorizeCronOrStaff: CRON_SECRET AUSENTE no env → header nenhum abre (fail-closed)", async () => {
  h.limpar();
  env.CRON_SECRET = "";
  const r = await authorizeCronOrStaff(req({ "x-cron-secret": "" }));
  env.CRON_SECRET = ENV_TESTE.CRON_SECRET;
  igual(r.ok, false, "cron-secret vazio dos dois lados NÃO é igualdade válida");
  if (r.ok) throw new Error("inalcançável");
  await r.response.body?.cancel();
  igual(h.chamadas.length, 0, "zero fetch");
});

Deno.test("authorizeCronOrStaff: Bearer SERVICE_ROLE → ok via service_role, ZERO fetch", async () => {
  h.limpar();
  const r = await authorizeCronOrStaff(req({ Authorization: `Bearer ${ENV_TESTE.SUPABASE_SERVICE_ROLE_KEY}` }));
  igual(r, { ok: true, via: "service_role" }, "resultado");
  igual(h.chamadas.length, 0, "service role decide sem rede");
});

Deno.test("authorizeCronOrStaff: JWT employee → ok via staff com userId", async () => {
  h.limpar();
  const r = await authorizeCronOrStaff(req({ Authorization: "Bearer jwt-employee" }));
  igual(r, { ok: true, via: "staff", userId: "u-employee" }, "resultado");
  igual(
    h.chamadas.map((c) => new URL(c.url).pathname),
    ["/auth/v1/user", "/rest/v1/user_roles"],
    "exatamente user + user_roles",
  );
});

Deno.test("authorizeCronOrStaff: JWT master → ok via staff", async () => {
  h.limpar();
  const r = await authorizeCronOrStaff(req({ Authorization: "Bearer jwt-master" }));
  igual(r, { ok: true, via: "staff", userId: "u-master" }, "resultado");
});

Deno.test("authorizeCronOrStaff: JWT customer (role errada) → 401 Forbidden", async () => {
  h.limpar();
  const r = await authorizeCronOrStaff(req({ Authorization: "Bearer jwt-customer" }));
  igual(r.ok, false, "ok");
  if (r.ok) throw new Error("inalcançável");
  igual(r.response.status, 401, "status");
  igual(await corpoDe(r.response), { error: "Forbidden" }, "corpo discrimina role errada");
});

Deno.test("authorizeCronOrStaff: JWT válido SEM papel nenhum → 401 Forbidden", async () => {
  h.limpar();
  const r = await authorizeCronOrStaff(req({ Authorization: "Bearer jwt-sem-papel" }));
  igual(r.ok, false, "ok");
  if (r.ok) throw new Error("inalcançável");
  igual(await corpoDe(r.response), { error: "Forbidden" }, "corpo");
});

Deno.test("authorizeCronOrStaff: JWT inválido (auth 401) → 401 e NÃO consulta user_roles", async () => {
  h.limpar();
  const r = await authorizeCronOrStaff(req({ Authorization: "Bearer jwt-invalido" }));
  igual(r.ok, false, "ok");
  if (r.ok) throw new Error("inalcançável");
  await r.response.body?.cancel();
  igual(h.chamadas.map((c) => new URL(c.url).pathname), ["/auth/v1/user"], "para no primeiro não-ok");
});

Deno.test("authorizeCronOrStaff: header sem prefixo Bearer → 401, ZERO fetch", async () => {
  h.limpar();
  const r = await authorizeCronOrStaff(req({ Authorization: "Basic abc" }));
  igual(r.ok, false, "ok");
  if (r.ok) throw new Error("inalcançável");
  await r.response.body?.cancel();
  igual(h.chamadas.length, 0, "zero fetch");
});

Deno.test("authorizeCronOrStaff: fetch LANÇA (rede caída) → fail-closed 401", async () => {
  h.limpar();
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new Error("rede caída"))) as typeof fetch;
  try {
    const r = await authorizeCronOrStaff(req({ Authorization: "Bearer jwt-employee" }));
    igual(r.ok, false, "erro de rede nunca abre");
    if (r.ok) throw new Error("inalcançável");
    igual(r.response.status, 401, "status");
    await r.response.body?.cancel();
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});

Deno.test("authorizeCron: só o cron-secret abre; Bearer SERVICE_ROLE NÃO", () => {
  igual(authorizeCron(req({ "x-cron-secret": ENV_TESTE.CRON_SECRET })), { ok: true, via: "cron" }, "cron");
  const r = authorizeCron(req({ Authorization: `Bearer ${ENV_TESTE.SUPABASE_SERVICE_ROLE_KEY}` }));
  igual(r.ok, false, "service role não é cron");
  if (!r.ok) r.response.body?.cancel();
});

Deno.test("authorizeMaster: master abre; employee e cron-secret NÃO", async () => {
  h.limpar();
  igual(await authorizeMaster(req({ Authorization: "Bearer jwt-master" })), { ok: true, via: "staff", userId: "u-master" }, "master");
  const emp = await authorizeMaster(req({ Authorization: "Bearer jwt-employee" }));
  igual(emp.ok, false, "employee não é master");
  if (!emp.ok) igual(await corpoDe(emp.response), { error: "Forbidden" }, "corpo");
  h.limpar();
  const cron = await authorizeMaster(req({ "x-cron-secret": ENV_TESTE.CRON_SECRET }));
  igual(cron.ok, false, "cron não abre master");
  if (!cron.ok) await cron.response.body?.cancel();
  igual(h.chamadas.length, 0, "cron-secret sem Bearer: zero fetch");
});
