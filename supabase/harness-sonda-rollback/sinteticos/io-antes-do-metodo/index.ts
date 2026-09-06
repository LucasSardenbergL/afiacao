import { createClient } from "npm:@supabase/supabase-js@2";
const c = createClient("u", "k");
// FALHA: lê o banco ANTES de olhar o método — o OPTIONS chega depois do efeito.
Deno.serve(async (req: Request) => {
  await (c as any).from("tabela").select("*");
  if (req.method === "OPTIONS") return new Response(null);
  return new Response(JSON.stringify({ ok: true }));
});
