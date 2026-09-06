import { createClient } from "npm:@supabase/supabase-js@2";
const c = createClient("u", "k");
// FALHA: o bloco OPTIONS não RETORNA — o fluxo real roda para o preflight também.
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") { /* esqueceu o return */ }
  await (c as any).from("tabela").select("*");
  return new Response(JSON.stringify({ ok: true }));
});
