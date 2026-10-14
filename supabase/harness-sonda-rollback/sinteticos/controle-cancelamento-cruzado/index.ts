// Contraexemplo do challenge Codex (8ª rodada, 2026-10-13): rotina de limpeza genérica cancela um
// INTERVALO com `clearTimeout`. No nativo isso funciona e nenhuma chamada sai; wrappers que exigem o
// par certo deixariam o intervalo disparando e o controle registraria chamadas que não existem.
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null);
  const id = setInterval(() => {
    void fetch("https://exemplo.invalid/status").catch(() => {});
  }, 10);
  clearTimeout(id);
  const t = setTimeout(() => {
    void fetch("https://exemplo.invalid/timeout").catch(() => {});
  }, 10);
  clearInterval(t);
  await new Promise((r) => setTimeout(r, 60));
  return new Response("ok");
});
