// Teste do HANDLER: gate canônico `authorizeCronOrStaff` (os casos padrão do harness, inclusive a sonda por cron) +
// a AÇÃO só para JWT de master: cron, service_role e employee recebem 403 sem efeito fora do gate.
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/sayerlack-encerrar-cancelado-portal/
import { ENV_TESTE, igual, instalarHarness, registrarCasosDeGate } from "../_shared/harness-handler_test.ts";
import { VERSAO } from "./versao.ts";

const h = instalarHarness();
// Import COMPUTADO de propósito (ver fin-period-override/index_test.ts): o type-check do index.ts é do edges:typecheck.
await import(new URL("./index.ts", import.meta.url).href);

registrarCasosDeGate("sayerlack-encerrar-cancelado-portal", h, VERSAO);

const url = `${ENV_TESTE.SUPABASE_URL}/functions/v1/sayerlack-encerrar-cancelado-portal`;
const post = (headers: Record<string, string>, corpo: unknown) =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(corpo) });
const PEDIDO = { pedido_id: 123, justificativa: "Fornecedor confirmou o cancelamento por telefone" };

Deno.test("encerrar: cron, service_role e employee passam no gate mas NÃO encerram (403, nada fora do gate)", async () => {
  const casos: Record<string, string>[] = [
    { "x-cron-secret": ENV_TESTE.CRON_SECRET },
    { Authorization: `Bearer ${ENV_TESTE.SUPABASE_SERVICE_ROLE_KEY}` },
    { Authorization: "Bearer jwt-employee" },
  ];
  for (const headers of casos) {
    h.limpar();
    const r = await h.handler()(post(headers, PEDIDO));
    igual(r.status, 403, `status (${Object.keys(headers)[0]} ${headers.Authorization ?? ""})`);
    await r.body?.cancel();
    igual(h.chamadasForaDoGate().length, 0, "403 sem nenhum efeito fora do gate");
  }
});

Deno.test("encerrar: master com {probe} → 200 e nada fora do gate", async () => {
  h.limpar();
  const r = await h.handler()(post({ Authorization: "Bearer jwt-master" }, { probe: true }));
  igual(r.status, 200, "status");
  igual((await r.json()).versao, VERSAO, "VERSAO");
  igual(h.chamadasForaDoGate().length, 0, "sonda do master: zero efeito fora do gate");
});
