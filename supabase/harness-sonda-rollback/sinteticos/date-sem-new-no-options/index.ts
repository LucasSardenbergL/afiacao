import { createClient } from "npm:@supabase/supabase-js@2";
const c = createClient("u", "k");
// PASSA: contraexemplo do challenge Codex (5ª rodada, 2026-10-13). `Date()` sem `new` é JavaScript
// válido e devolve string; o preflight só loga e responde. Substituir `Date` por uma classe faria
// esta chamada lançar e o OPTIONS sair com status -1 — FALHA de um bundle inofensivo.
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    const agora = Date();
    const ok = typeof agora === "string" && new Date() instanceof Date && typeof Date.UTC(2026, 0, 1) === "number";
    return new Response(ok ? null : "relogio-quebrado", { status: ok ? 204 : 500 });
  }
  if (req.headers.get("x-cron-secret") !== "cron-secret-de-teste") return new Response("401", { status: 401 });
  await (c as any).from("tabela").select("*");
  return new Response(JSON.stringify({ ok: true }));
});
