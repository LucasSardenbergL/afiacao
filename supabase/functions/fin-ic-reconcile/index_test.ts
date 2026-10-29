// Teste NEGATIVO do HANDLER: sem credencial → 401 e ZERO efeito (nenhum fetch: nem Supabase, nem
// Omie, nem portal). Nasceu ANTES da troca da cópia local de `authorizeCronOrStaff` pela canônica
// (`_shared/auth.ts`): `if (!(await authorizeCronOrStaff(req)))` com `AuthResult` deixa `{ok:false}`
// truthy e ABRE a edge — este teste é quem fica vermelho nesse caso (falsificado no PR do lote H).
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/fin-ic-reconcile/
import { ENV_TESTE, igual, instalarHarness, registrarCasosDeGate } from "../_shared/harness-handler_test.ts";
import { VERSAO } from "./versao.ts";

const h = instalarHarness();
// Import COMPUTADO de propósito: o `deno test` type-checa só o grafo ESTÁTICO, e o type-check do
// `index.ts` é do gate `edges:typecheck` (lock próprio; aqui o npm resolve pelo `node_modules` do
// bun, versão diferente → TS2322 falsos). Em runtime o módulo carrega igual.
await import(new URL("./index.ts", import.meta.url).href);

registrarCasosDeGate("fin-ic-reconcile", h, VERSAO);

// Corpo que não é JSON (ex.: `{"simular":true,}`) não pode virar EXECUÇÃO real por ter falhado o
// parse (Codex adversarial #3294, P2): 400 e nenhum request além do gate de auth.
const URL_EDGE = `${ENV_TESTE.SUPABASE_URL}/functions/v1/fin-ic-reconcile`;
const postCru = (corpo: string) =>
  new Request(URL_EDGE, {
    method: "POST",
    headers: { "content-type": "application/json", "x-cron-secret": ENV_TESTE.CRON_SECRET },
    body: corpo,
  });

Deno.test("fin-ic-reconcile: corpo JSON INVÁLIDO → 400 e ZERO efeito (não vira disparo)", async () => {
  h.limpar();
  const r = await h.handler()(postCru('{"simular":true,}'));
  igual(r.status, 400, "status");
  await r.body?.cancel();
  igual(h.chamadasForaDoGate().length, 0, "nada além do gate");
});

Deno.test("fin-ic-reconcile: CONTROLE — {simular:true} válido segue adiante (lê o banco)", async () => {
  h.limpar();
  const r = await h.handler()(postCru('{"simular":true}'));
  await r.body?.cancel();
  igual(h.chamadasForaDoGate().length > 0, true, "o caminho válido sai do gate");
});
