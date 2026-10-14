// Contraexemplo do challenge Codex (4ª rodada, 2026-10-13): referências aos relógios CAPTURADAS no
// import, antes de o controle rodar — padrão comum em helpers de timeout. Trocar `globalThis.Date`
// na hora do controle não alcança `now`; se ela continuar no tempo real, a espera de 1 s "dura"
// ~1 ms e o fetch é FABRICADO. O controle tem de ver ZERO efeito aqui.
const now = Date.now;
const perf = performance.now.bind(performance);
const DataCapturada = Date;
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null);
  const t0 = now();
  const p0 = perf();
  const d0 = new DataCapturada().getTime();
  await new Promise((r) => setTimeout(r, 1000));
  if (now() - t0 < 500) await fetch("https://exemplo.invalid/now").catch(() => {});
  if (perf() - p0 < 500) await fetch("https://exemplo.invalid/perf").catch(() => {});
  if (new DataCapturada().getTime() - d0 < 500) await fetch("https://exemplo.invalid/date").catch(() => {});
  // Espera por timer FORA da fila (AbortSignal.timeout) e mede com o relógio capturado.
  const t1 = now();
  await new Promise((r) => AbortSignal.timeout(1000).addEventListener("abort", r));
  if (now() - t1 < 500) await fetch("https://exemplo.invalid/abort").catch(() => {});
  return new Response(null);
});
