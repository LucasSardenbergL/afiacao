// Contraexemplo do challenge Codex (2ª rodada, 2026-10-13): com timers reais, o de 1 ms libera o
// handler antes do de 50 ms, `pronto` já é verdade e NENHUM fetch acontece. Um relógio virtual FIFO
// roda o de 50 ms primeiro e FABRICA o fetch — o controle sairia "sem-gate" e calibraria a prova
// com um efeito que a produção nunca teria. O controle tem de ver ZERO efeito aqui.
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null);
  let pronto = false;
  setTimeout(() => {
    if (!pronto) fetch("https://exemplo.invalid/").catch(() => {});
  }, 50);
  await new Promise((r) => setTimeout(r, 1));
  pronto = true;
  return new Response(null);
});
