// FIDELIDADE (challenge Codex, 7ª rodada, 2026-10-13): a fila virtual de (a)/(b) sempre chamou o
// callback SEM os argumentos extras do `setTimeout(fn, ms, ...args)`. Aqui o `fetch` recebe
// `undefined`, o stub lança antes de contar, e o veredito antigo era ZERO. A mudança do controle não
// pode alterar isto — o teste prende o comportamento anterior, não o "corrige".
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    setTimeout((url: string) => fetch(url).catch(() => {}), 0, "https://api.exemplo.invalid/log");
    return new Response(null);
  }
  return new Response("401", { status: 401 });
});
