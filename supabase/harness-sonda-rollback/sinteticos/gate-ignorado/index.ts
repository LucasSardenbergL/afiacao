import { createClient } from "npm:@supabase/supabase-js@2";
const c = createClient("u", "k");
// PASSA: o gate é chamado e o resultado IGNORADO — inseguro para POST, irrelevante para OPTIONS.
function autorizar(req: Request) { return req.headers.get("x-cron-secret") === "cron-secret-de-teste"; }
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null);
  autorizar(req);
  await (c as any).from("tabela").select("*");
  return new Response(JSON.stringify({ ok: true }));
});
