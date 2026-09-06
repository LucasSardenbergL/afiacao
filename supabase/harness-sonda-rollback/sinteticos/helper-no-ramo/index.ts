import { createClient } from "npm:@supabase/supabase-js@2";
const c = createClient("u", "k");
// FALHA: helper com IO chamado DENTRO do bloco OPTIONS (auditar o preflight custa uma escrita).
async function auditar() { await (c as any).from("auditoria").insert({ x: 1 }); }
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") { await auditar(); return new Response(null); }
  return new Response(JSON.stringify({ ok: true }));
});
