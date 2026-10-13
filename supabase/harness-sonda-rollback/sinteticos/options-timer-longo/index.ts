import { createClient } from "npm:@supabase/supabase-js@2";
const c = createClient("u", "k");
// FALHA: o OPTIONS agenda um IO para DAQUI A 60 s e responde. A fila virtual de (a)/(b) drena a
// tarefa independentemente do atraso e conta o efeito. Timers reais em (a) a cancelariam no teto
// de espera pós-resposta (10 s) e o OPTIONS sairia inerte — é por isso que os timers nativos ficam
// restritos ao controle positivo.
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    setTimeout(() => (c as any).from("tabela").insert({ x: 1 }), 60_000);
    return new Response(null);
  }
  if (req.headers.get("x-cron-secret") !== "cron-secret-de-teste") return new Response("401", { status: 401 });
  await (c as any).from("tabela").select("*");
  return new Response(JSON.stringify({ ok: true }));
});
