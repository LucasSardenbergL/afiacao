import { createClient } from "npm:@supabase/supabase-js@2";
const c = createClient("u", "k");
// FALHA: efeito no TOPO do módulo — acontece durante o import, antes de qualquer requisição.
await (c as any).from("tabela").select("*");
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null);
  return new Response(JSON.stringify({ ok: true }));
});
