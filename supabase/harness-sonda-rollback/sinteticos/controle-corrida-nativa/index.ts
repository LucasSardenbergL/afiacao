// Contraexemplo do challenge Codex (6ª rodada, 2026-10-13): uma operação NATIVA (PBKDF2, ~20 ms)
// disputa com um timeout de 1 s, e só o timeout dispara o alerta. Na produção a derivação vence e
// NENHUM fetch acontece. Um relógio virtual que salta até o próximo timer faria o timeout vencer e
// registraria no controle uma chamada que a execução real não faz. O controle tem de ver ZERO efeito.
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null);
  const chave = await crypto.subtle.importKey("raw", new TextEncoder().encode("senha"), "PBKDF2", false, ["deriveBits"]);
  const derivar = crypto.subtle.deriveBits({ name: "PBKDF2", salt: new Uint8Array(16), iterations: 100_000, hash: "SHA-256" }, chave, 256);
  const venceu = await Promise.race([
    derivar.then(() => "derivou"),
    new Promise((r) => AbortSignal.timeout(1000).addEventListener("abort", () => r("timeout"))),
  ]);
  if (venceu === "timeout") await fetch("https://exemplo.invalid/alerta").catch(() => {});
  return new Response(null);
});
