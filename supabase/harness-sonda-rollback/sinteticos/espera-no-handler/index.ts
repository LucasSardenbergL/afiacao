import { createClient } from "npm:@supabase/supabase-js@2";
const c = createClient("u", "k");
const esperar = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// PASSA: OPTIONS primeiro e gate antes de IO — mas o fluxo real ESPERA um timer DENTRO do handler
// (a trégua entre contas da picking-fila-omie). Sem o relógio andando durante a resposta, o
// controle pendurava o runner e o veredito saía MECANICA; com ele, o contador tem de ver o select.
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null);
  if (req.headers.get("x-cron-secret") !== "cron-secret-de-teste") return new Response("401", { status: 401 });
  await esperar(1_500);
  await (c as any).from("tabela").select("*");
  return new Response(JSON.stringify({ ok: true }));
});
