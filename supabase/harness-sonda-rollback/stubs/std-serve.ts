// Stub de `https://deno.land/std@*/http/server.ts` — os bundles antigos servem por `serve()`,
// não por `Deno.serve`. Sem este stub eles seriam INVERIFICÁVEIS (o handler nunca apareceria).
export function serve(a: unknown, b?: unknown): unknown {
  (globalThis as Record<string, unknown>).__handler = typeof a === "function" ? a : b;
  return {};
}
export default serve;
