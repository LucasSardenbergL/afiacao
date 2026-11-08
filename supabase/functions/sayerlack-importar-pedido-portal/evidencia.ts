// 7.2 do plano Sayerlack (revisão 2): o que vai para `sayerlack_portal_evidencia` além do envelope cru.
/** Teto do trace na evidência (7.2): a tabela recusa linha acima de 512 KB; o trace é o único campo que cresce. */
export const TETO_TRACE_BYTES = 100_000;

/**
 * Mantém os passos MAIS RECENTES do trace que cabem no teto (o fim é onde a leitura falhou) e marca o corte.
 * Ausente fica null — nunca lista vazia fabricada.
 */
export function cortarTrace(trace: unknown): unknown[] | null {
  if (!Array.isArray(trace)) return null;
  const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v) ?? "null").length;
  if (bytes(trace) <= TETO_TRACE_BYTES) return trace;
  const fica: unknown[] = [];
  let soma = 2;
  for (let i = trace.length - 1; i >= 0; i--) {
    const b = bytes(trace[i]) + 1;
    if (soma + b > TETO_TRACE_BYTES - 200) break;
    fica.unshift(trace[i]);
    soma += b;
  }
  return [{ step: "trace_cortado", passos_omitidos: trace.length - fica.length, teto_bytes: TETO_TRACE_BYTES }, ...fica];
}

/** Prazo do INSERT da evidência (7.2, Codex P1): passou disso, a importação segue sem esperar. */
export const PRAZO_EVIDENCIA_MS = 3_000;

/** Resolve com o resultado, ou com "prazo" se não vier em `ms` (o timer é limpo nos dois casos). */
export async function comPrazo<T>(p: PromiseLike<T>, ms: number): Promise<T | "prazo"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(p),
      new Promise<"prazo">((resolve) => { timer = setTimeout(() => resolve("prazo"), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
