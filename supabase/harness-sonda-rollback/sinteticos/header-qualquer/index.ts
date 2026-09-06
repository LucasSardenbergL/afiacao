import { createClient } from "npm:@supabase/supabase-js@2";
const c = createClient("u", "k");
// FALHA: responde a sonda para QUALQUER valor do header — credencial que não é verificada.
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    if (req.headers.get("x-sonda-credencial")) {
      return new Response(JSON.stringify({ ok: true, probe: true, versao: "v1.0-x", edge: "header-qualquer", fonte: "nao-mapeada" }), { headers: { "Content-Type": "application/json" } });
    }
    return new Response(null);
  }
  return new Response(JSON.stringify({ ok: true }));
});
