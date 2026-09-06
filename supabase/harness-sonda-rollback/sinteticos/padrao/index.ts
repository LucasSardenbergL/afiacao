import { createClient } from "npm:@supabase/supabase-js@2";
const c = createClient("u", "k");
// PASSA: a forma canônica — OPTIONS primeiro, gate, depois IO.
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null);
  if (req.headers.get("x-cron-secret") !== "cron-secret-de-teste") return new Response("401", { status: 401 });
  await (c as any).from("tabela").select("*");
  return new Response(JSON.stringify({ ok: true }));
});
