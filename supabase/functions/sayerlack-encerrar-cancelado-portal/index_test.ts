// Teste do HANDLER: o gate é `authorizeMaster` (não o cron/staff do harness padrão) — sem credencial, cron,
// customer ou employee → 401 e ZERO efeito; service_role só sonda (o encerramento é ato HUMANO → 403 sem efeito).
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/sayerlack-encerrar-cancelado-portal/
import { ENV_TESTE, igual, instalarHarness } from "../_shared/harness-handler_test.ts";
import { VERSAO } from "./versao.ts";

const h = instalarHarness();
// Import COMPUTADO de propósito (ver fin-period-override/index_test.ts): o type-check do index.ts é do edges:typecheck.
await import(new URL("./index.ts", import.meta.url).href);

const url = `${ENV_TESTE.SUPABASE_URL}/functions/v1/sayerlack-encerrar-cancelado-portal`;
const post = (headers: Record<string, string>, corpo: unknown) =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(corpo) });
const PEDIDO = { pedido_id: 123, justificativa: "Fornecedor confirmou o cancelamento por telefone" };

Deno.test("encerrar: carregar o módulo NÃO faz fetch", () => {
  igual(h.chamadas.map((c) => c.url), [], "efeito no topo do módulo é efeito sem gate");
});

Deno.test("encerrar: sem credencial, com cron-secret e com {probe} sem credencial → 401 e ZERO fetch", async () => {
  for (const [headers, corpo] of [[{}, PEDIDO], [{ "x-cron-secret": ENV_TESTE.CRON_SECRET }, PEDIDO], [{}, { probe: true }]] as const) {
    h.limpar();
    const r = await h.handler()(post(headers, corpo));
    igual(r.status, 401, "status");
    await r.body?.cancel();
    igual(h.chamadas.map((c) => c.url), [], "nada sai sem credencial de master");
  }
});

Deno.test("encerrar: employee e customer → 401 e só o gate saiu", async () => {
  for (const jwt of ["jwt-employee", "jwt-customer"]) {
    h.limpar();
    const r = await h.handler()(post({ Authorization: `Bearer ${jwt}` }, PEDIDO));
    igual(r.status, 401, `status (${jwt})`);
    await r.body?.cancel();
    igual(h.chamadasForaDoGate().length, 0, `zero efeito fora do gate (${jwt})`);
  }
});

Deno.test("encerrar: service_role sonda (200 + VERSAO, zero fetch) mas NÃO encerra (403, zero fetch)", async () => {
  h.limpar();
  const sonda = await h.handler()(post({ Authorization: `Bearer ${ENV_TESTE.SUPABASE_SERVICE_ROLE_KEY}` }, { probe: true }));
  igual(sonda.status, 200, "status da sonda");
  igual((await sonda.json()).versao, VERSAO, "VERSAO");
  igual(h.chamadas.length, 0, "sonda: zero fetch");
  h.limpar();
  const r = await h.handler()(post({ Authorization: `Bearer ${ENV_TESTE.SUPABASE_SERVICE_ROLE_KEY}` }, PEDIDO));
  igual(r.status, 403, "service_role não encerra");
  await r.body?.cancel();
  igual(h.chamadas.length, 0, "403 sem nenhum efeito");
});

Deno.test("encerrar: master com {probe} → 200 e nada fora do gate", async () => {
  h.limpar();
  const r = await h.handler()(post({ Authorization: "Bearer jwt-master" }, { probe: true }));
  igual(r.status, 200, "status");
  igual((await r.json()).versao, VERSAO, "VERSAO");
  igual(h.chamadasForaDoGate().length, 0, "sonda do master: zero efeito fora do gate");
});
