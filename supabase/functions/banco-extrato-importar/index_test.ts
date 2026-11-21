// Teste do HANDLER: gate de credencial (401 e ZERO efeito) + controle da sonda + FRONTEIRA DE
// AUTORIZAÇÃO do fluxo real (403 cron/service_role, 403 sem acesso à empresa, 404 conta inexistente).
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/banco-extrato-importar/
import { ENV_TESTE, igual, instalarHarness, registrarCasosDeGate } from "../_shared/harness-handler_test.ts";
import { VERSAO } from "./versao.ts";

// O fluxo real lê SUPABASE_ANON_KEY (client do usuário); o ENV_TESTE padrão não a tem.
const h = instalarHarness({ ...ENV_TESTE, SUPABASE_ANON_KEY: "anon-de-teste" });
// Import COMPUTADO de propósito (ver fin-cashflow-engine/index_test.ts): o type-check do index.ts é
// do gate `edges:typecheck`.
await import(new URL("./index.ts", import.meta.url).href);

registrarCasosDeGate("banco-extrato-importar", h, VERSAO);

// ── Fronteira de autorização do fluxo real ───────────────────────────────────────────────────────
const CONTA = "11111111-1111-4111-8111-111111111111";
const CORPO_REAL = { storage_path: `${CONTA}/abc.ofx`, banco_conta_id: CONTA };
const URL_EDGE = `${ENV_TESTE.SUPABASE_URL}/functions/v1/banco-extrato-importar`;

const post = (headers: Record<string, string>, corpo: unknown = CORPO_REAL) =>
  new Request(URL_EDGE, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(corpo),
  });
const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { "content-type": "application/json" } });

type Rotas = { conta: "existe" | "inexistente"; podeAcessar: boolean };
/** Fetch falso das rotas PostgREST/Storage que o fluxo real toca; devolve quem foi chamado. */
function rotas({ conta, podeAcessar }: Rotas) {
  h.responderForaDoGate((r) => {
    const p = new URL(r.url).pathname;
    if (p === "/rest/v1/banco_conta") {
      // `.maybeSingle()` num GET: o PostgREST devolve ARRAY (200) e o supabase-js reduz 0 linhas a null.
      return json(conta === "existe" ? [{ company: "oben", estrategia_chave: null }] : []);
    }
    if (p === "/rest/v1/rpc/fin_user_can_access") return json(podeAcessar);
    if (p.startsWith("/storage/v1/object/")) return json({ message: "Object not found" }, 404);
    if (p === "/rest/v1/rpc/banco_extrato_registrar") return json({ resultado: "aceito" });
    return json({}, 500);
  });
  return {
    caminhos: () => h.chamadasForaDoGate().map((c) => new URL(c.url).pathname),
  };
}
const tocouDownload = (c: string[]) => c.some((p) => p.startsWith("/storage/v1/object/"));
const tocouRpc = (c: string[]) => c.includes("/rest/v1/rpc/banco_extrato_registrar");

Deno.test("fluxo real: x-cron-secret VÁLIDO + body real -> 403 e ZERO efeito (sem leitura, download nem RPC)", async () => {
  h.limpar();
  const r = rotas({ conta: "existe", podeAcessar: true });
  const res = await h.handler()(post({ "x-cron-secret": ENV_TESTE.CRON_SECRET }));
  igual(res.status, 403, "status");
  await res.body?.cancel();
  igual(r.caminhos(), [], "cron não pode tocar banco_conta/Storage/RPC");
});

Deno.test("fluxo real: Bearer SERVICE_ROLE + body real -> 403 e ZERO efeito", async () => {
  h.limpar();
  const r = rotas({ conta: "existe", podeAcessar: true });
  const res = await h.handler()(post({ Authorization: `Bearer ${ENV_TESTE.SUPABASE_SERVICE_ROLE_KEY}` }));
  igual(res.status, 403, "status");
  await res.body?.cancel();
  igual(r.caminhos(), [], "service_role não pode tocar banco_conta/Storage/RPC");
});

Deno.test("fluxo real: staff SEM acesso à empresa (fin_user_can_access=false) -> 403, sem download nem RPC", async () => {
  h.limpar();
  const r = rotas({ conta: "existe", podeAcessar: false });
  const res = await h.handler()(post({ Authorization: "Bearer jwt-employee" }));
  igual(res.status, 403, "status");
  await res.body?.cancel();
  const c = r.caminhos();
  igual(c.includes("/rest/v1/rpc/fin_user_can_access"), true, "o gate de acesso foi consultado");
  igual(tocouDownload(c), false, "não pode baixar sem acesso");
  igual(tocouRpc(c), false, "não pode registrar sem acesso");
});

Deno.test("fluxo real: conta inexistente -> 404, sem gate de acesso, download nem RPC", async () => {
  h.limpar();
  const r = rotas({ conta: "inexistente", podeAcessar: true });
  const res = await h.handler()(post({ Authorization: "Bearer jwt-employee" }));
  igual(res.status, 404, "status");
  await res.body?.cancel();
  const c = r.caminhos();
  igual(c.includes("/rest/v1/rpc/fin_user_can_access"), false, "sem company não há gate a consultar");
  igual(tocouDownload(c), false, "não baixa");
  igual(tocouRpc(c), false, "não registra");
});

Deno.test("CONTROLE: staff COM acesso alcança o download (prova que os 403/404 acima não são por rota errada do mock)", async () => {
  h.limpar();
  const r = rotas({ conta: "existe", podeAcessar: true });
  const res = await h.handler()(post({ Authorization: "Bearer jwt-employee" }));
  igual(res.status, 502, "download 404 do mock -> falha_ao_baixar_arquivo");
  await res.body?.cancel();
  const c = r.caminhos();
  igual(tocouDownload(c), true, "chegou ao download");
  igual(tocouRpc(c), false, "download falhou: RPC não chamada");
});
