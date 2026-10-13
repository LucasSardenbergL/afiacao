// Contraexemplo do challenge Codex (3ª rodada, 2026-10-13): com timer real, a espera de 1 s
// ultrapassa 500 ms e NENHUM fetch acontece. Se o relógio virtual avançar os timers mas
// `performance.now()`/`Date.now()` seguirem no tempo real, a espera "dura" ~1 ms no controle e o
// fetch é FABRICADO. O controle tem de ver ZERO efeito aqui, pelos dois relógios.
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null);
  const inicioPerf = performance.now();
  const inicioDate = Date.now();
  const inicioNew = new Date().getTime();
  await new Promise((r) => setTimeout(r, 1000));
  if (performance.now() - inicioPerf < 500) await fetch("https://exemplo.invalid/perf").catch(() => {});
  if (Date.now() - inicioDate < 500) await fetch("https://exemplo.invalid/date").catch(() => {});
  if (new Date().getTime() - inicioNew < 500) await fetch("https://exemplo.invalid/new-date").catch(() => {});
  return new Response(null);
});
