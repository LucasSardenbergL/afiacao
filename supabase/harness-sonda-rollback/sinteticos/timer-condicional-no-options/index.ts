import { createClient } from "npm:@supabase/supabase-js@2";
const c = createClient("u", "k");
// Uma volta do laço de eventos SEM usar setTimeout (que o runner sequestra): mensagem de
// MessageChannel é entregue como macrotask.
const volta = () =>
  new Promise<void>((r) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      r();
    };
    ch.port2.postMessage(0);
  });
// FALHA: contraexemplo do challenge Codex (2026-10-13). O OPTIONS agenda um IO que só acontece se
// `pronto` já for verdade quando o timer disparar — e `pronto` vira verdade logo antes do return.
// Em produção o IO roda. Um runner que antecipasse o timer DURANTE o handler veria `pronto=false`,
// perderia o efeito e aprovaria. O relógio só anda no controle (c); aqui o efeito tem de ser contado.
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    let pronto = false;
    setTimeout(() => {
      if (pronto) (c as any).from("tabela").insert({ x: 1 });
    }, 50);
    // Trabalho assíncrono REAL que atravessa voltas do laço (o "~10 ms" do contraexemplo) — um
    // `await Promise.resolve()` ou `crypto.subtle` termina antes da 1ª volta e não exercita a antecipação.
    for (let i = 0; i < 5; i++) await volta();
    pronto = true;
    return new Response(null);
  }
  if (req.headers.get("x-cron-secret") !== "cron-secret-de-teste") return new Response("401", { status: 401 });
  await (c as any).from("tabela").select("*");
  return new Response(JSON.stringify({ ok: true }));
});
