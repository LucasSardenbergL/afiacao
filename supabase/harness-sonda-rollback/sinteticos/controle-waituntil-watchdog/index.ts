// Contraexemplo do challenge Codex (9ª rodada, 2026-10-13): tarefa de FUNDO (`EdgeRuntime.waitUntil`)
// com alerta de demora. Depois de uma operação nativa ela arma o alerta, conclui outra operação e o
// cancela no `finally`. No nativo, nenhum alerta sai. Se o runner desligasse os timers reais antes de
// esperar a tarefa, o alerta cairia na fila virtual, o cancelamento não o alcançaria e o controle
// registraria uma chamada que a execução real não faz.
declare const EdgeRuntime: { waitUntil: (p: Promise<unknown>) => void };
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null);
  EdgeRuntime.waitUntil((async () => {
    await crypto.subtle.digest("SHA-256", new Uint8Array(1024));
    const alerta = setTimeout(() => void fetch("https://exemplo.invalid/demorou").catch(() => {}), 5_000);
    try {
      await crypto.subtle.digest("SHA-256", new Uint8Array(1024));
    } finally {
      clearTimeout(alerta);
    }
  })());
  return new Response("aceito", { status: 202 });
});
