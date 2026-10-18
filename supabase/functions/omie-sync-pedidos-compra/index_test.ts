// Teste NEGATIVO do HANDLER: sem credencial → 401 e ZERO efeito (nenhum fetch: nem Supabase, nem
// Omie, nem portal). Nasceu ANTES da troca da cópia local de `authorizeCronOrStaff` pela canônica
// (`_shared/auth.ts`): `if (!(await authorizeCronOrStaff(req)))` com `AuthResult` deixa `{ok:false}`
// truthy e ABRE a edge — este teste é quem fica vermelho nesse caso (falsificado no PR do lote H).
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/omie-sync-pedidos-compra/
import { instalarHarness, registrarCasosDeGate } from "../_shared/harness-handler_test.ts";
import { VERSAO } from "./versao.ts";

const h = instalarHarness();
// Import COMPUTADO de propósito: o `deno test` type-checa só o grafo ESTÁTICO, e o type-check do
// `index.ts` é do gate `edges:typecheck` (lock próprio; aqui o npm resolve pelo `node_modules` do
// bun, versão diferente → TS2322 falsos). Em runtime o módulo carrega igual.
await import(new URL("./index.ts", import.meta.url).href);

registrarCasosDeGate("omie-sync-pedidos-compra", h, VERSAO);
