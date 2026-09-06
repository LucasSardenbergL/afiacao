import { createClient } from "npm:@supabase/supabase-js@2";
const c = createClient("u", "k");
// FALHA: agenda o efeito e responde — o contador só vê depois de drenar o relógio virtual.
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    setTimeout(() => { void (c as any).from("tabela").insert({ x: 1 }); }, 50);
    return new Response(null);
  }
  return new Response(JSON.stringify({ ok: true }));
});
