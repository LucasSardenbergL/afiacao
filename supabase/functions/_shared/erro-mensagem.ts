// Mensagem legível de um erro capturado — incluindo os que NÃO são `Error`.
//
// ESPELHO de src/lib/erro-mensagem.ts (Deno não importa de `src/`). Mudou lá, mude aqui.
// Testes em erro-mensagem_test.ts.
//
// POR QUE EXISTE: `err instanceof Error ? err.message : String(err)` é o idiom do repo, e ele
// falha justamente no erro mais comum desta camada. O supabase-js só constrói um
// `PostgrestError` (que herda de `Error`) quando se usa `.throwOnError()`; no caminho normal
// — `const { error } = await supabase.from(...)` — o `error` é um objeto PLANO
// `{ message, details, hint, code }` parseado do JSON da resposta. Um `throw` desses cai no
// ramo `String(err)` e o que chega ao log/resposta é **"[object Object]"**: ruído com cara de
// diagnóstico, no lugar da mensagem acionável que o servidor mandou.
//
// O gate estrutural `src/__tests__/erro-object-object-gate.test.ts` (classe #1642) vigia a
// reintrodução do idiom. `src/` está em ZERO; as ~93 edges Deno são dívida baselinada POR
// CONTAGEM, e este módulo é o que o comentário daquele gate pedia para que ela possa encolher.
// Sítio NOVO em edge deve usar isto — a baseline só encolhe, nunca cresce.

/**
 * Ordem de preferência: `message` string não-vazia (cobre `Error` e o objeto plano do
 * PostgREST) → `String(err)` como último recurso.
 *
 * NUNCA devolve "[object Object]": sem mensagem utilizável devolve `null`, e o chamador
 * decide o texto de fallback do seu contexto — ausente ≠ mensagem fabricada (money-path).
 */
export function mensagemDeErro(err: unknown): string | null {
  if (typeof err === "string") {
    const t = err.trim();
    return t.length > 0 ? t : null;
  }
  if (err && typeof err === "object") {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string" && m.trim().length > 0) return m.trim();
    // Objeto sem `message` utilizável: `String(err)` daria "[object Object]". Melhor admitir
    // que não há mensagem do que devolver um texto que parece diagnóstico e não é.
    return null;
  }
  if (err == null) return null;
  const s = String(err).trim();
  return s.length > 0 ? s : null;
}
