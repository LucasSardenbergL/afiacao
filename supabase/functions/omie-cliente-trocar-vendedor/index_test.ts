// Teste do HANDLER: gate canônico `authorizeCronOrStaff` (casos padrão do harness, inclusive a sonda por cron) +
// a AÇÃO recusada para employee, e o aplicar sem confirmação recusado ANTES de qualquer chamada ao Omie.
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/omie-cliente-trocar-vendedor/
import { ENV_TESTE, igual, instalarHarness, registrarCasosDeGate } from "../_shared/harness-handler_test.ts";
import { VERSAO } from "./versao.ts";

const h = instalarHarness({ ...ENV_TESTE, OMIE_OBEN_APP_KEY: "k", OMIE_OBEN_APP_SECRET: "s" });
// Import COMPUTADO de propósito (ver fin-period-override/index_test.ts): o type-check do index.ts é do edges:typecheck.
await import(new URL("./index.ts", import.meta.url).href);

registrarCasosDeGate("omie-cliente-trocar-vendedor", h, VERSAO);

const url = `${ENV_TESTE.SUPABASE_URL}/functions/v1/omie-cliente-trocar-vendedor`;
const post = (headers: Record<string, string>, corpo: unknown) =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(corpo) });
const omieChamado = () => h.chamadas.some((r) => r.url.includes("omie.com.br"));

Deno.test("employee passa no gate da sonda mas NÃO troca vendedor (403, sem Omie)", async () => {
  h.limpar();
  h.responderForaDoGate(() => new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));
  const r = await h.handler()(post({ Authorization: "Bearer jwt-employee" }, { modo: "dry_run", lote: "saida_vendedora", conta: "oben" }));
  igual(r.status, 403, "status");
  igual(omieChamado(), false, "Omie não chamado");
});

Deno.test("aplicar sem a frase de confirmação: 400 sem chamar o Omie", async () => {
  h.limpar();
  const r = await h.handler()(post({ "x-cron-secret": ENV_TESTE.CRON_SECRET }, { modo: "aplicar", lote: "saida_vendedora", conta: "oben" }));
  igual(r.status, 400, "status");
  igual(omieChamado(), false, "Omie não chamado");
  igual(h.chamadasForaDoGate().length, 0, "nada fora do gate");
});

Deno.test("conta sem credencial: 503 sem chamar o Omie", async () => {
  h.limpar();
  const r = await h.handler()(post({ "x-cron-secret": ENV_TESTE.CRON_SECRET }, { modo: "dry_run", lote: "saida_vendedora", conta: "colacor_sc" }));
  igual(r.status, 503, "status");
  igual(omieChamado(), false, "Omie não chamado");
});
