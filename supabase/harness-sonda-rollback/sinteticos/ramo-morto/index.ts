import { createClient } from "npm:@supabase/supabase-js@2";
const c = createClient("u", "k");
// PASSA: o gate está em ramo morto — de novo, não é ameaça DO OPTIONS.
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null);
  if (false) { return new Response("401", { status: 401 }); }
  await (c as any).from("tabela").select("*");
  return new Response(JSON.stringify({ ok: true }));
});
