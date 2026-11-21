// Teste do HANDLER: gate de credencial (401 e ZERO efeito) + controle da sonda.
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/banco-extrato-importar/
import { instalarHarness, registrarCasosDeGate } from "../_shared/harness-handler_test.ts";
import { VERSAO } from "./versao.ts";

const h = instalarHarness();
// Import COMPUTADO de propósito (ver fin-cashflow-engine/index_test.ts): o type-check do index.ts é
// do gate `edges:typecheck`.
await import(new URL("./index.ts", import.meta.url).href);

registrarCasosDeGate("banco-extrato-importar", h, VERSAO);
