// Contraexemplo do challenge Codex (7ª rodada, 2026-10-13): um watchdog PERIÓDICO aborta na 2ª
// verificação; o handler espera 50 ms e só chama se não abortou. Com intervalo nativo (10 ms) o
// abort acontece e NENHUM fetch sai. Um intervalo convertido em disparo único nunca chega à 2ª
// verificação e o controle registraria uma chamada que a execução real não faz.
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null);
  const ctl = new AbortController();
  let verificacoes = 0;
  const iv = setInterval(() => {
    if (++verificacoes >= 2) ctl.abort();
  }, 10);
  await new Promise((r) => setTimeout(r, 50));
  clearInterval(iv);
  if (!ctl.signal.aborted) await fetch("https://exemplo.invalid/watchdog").catch(() => {});
  return new Response(null);
});
