/**
 * Mensagem legível de um erro capturado — **incluindo os que não são `Error`**.
 *
 * POR QUE EXISTE: `err instanceof Error ? err.message : String(err)` é o idiom do repo, e
 * ele **falha justamente no erro mais comum desta camada**. O supabase-js só constrói um
 * `PostgrestError` (que herda de `Error`) quando se usa `.throwOnError()`; no caminho
 * normal — `const { error } = await supabase.rpc(...)` — o `error` é um **objeto plano**
 * `{ message, details, hint, code }` parseado do JSON da resposta
 * (`node_modules/@supabase/postgrest-js/src/PostgrestBuilder.ts`). Um `throw error` desses
 * cai no ramo `String(err)` e a pessoa lê **"[object Object]"** no toast.
 *
 * É a mesma classe do "Edge Function returned a non-2xx status code" que
 * `@/lib/invoke-function` resolve do outro lado: a mensagem acionável existe, o servidor a
 * mandou, e ela morre na fronteira — a vendedora fica sem saber se tenta de novo ou avisa
 * a equipe.
 *
 * Ordem de preferência: `message` string não-vazia (cobre `Error` e o objeto plano do
 * PostgREST) → `String(err)` como último recurso. Nunca devolve "[object Object]": sem
 * mensagem utilizável, devolve `null` e o chamador decide o texto de fallback — ausente ≠
 * mensagem fabricada.
 */
export function mensagemDeErro(err: unknown): string | null {
  if (typeof err === 'string') {
    const t = err.trim();
    return t.length > 0 ? t : null;
  }
  if (err && typeof err === 'object') {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string' && m.trim().length > 0) return m.trim();
    // Objeto sem `message` utilizável: `String(err)` daria "[object Object]", que é ruído
    // com cara de diagnóstico. Melhor admitir que não há mensagem.
    return null;
  }
  if (err == null) return null;
  const s = String(err).trim();
  return s.length > 0 ? s : null;
}

/**
 * `Error` com a CAUSA presa — `new Error(msg, { cause })` é ES2022 e o projeto compila com
 * `lib: ES2020`, então a propriedade é atribuída à mão (mesmo padrão de `fetchAllPages`).
 *
 * POR QUE EXISTE: quando um caller traduz uma falha técnica em mensagem de domínio ("não
 * consegui confirmar quais SKUs são rentáveis"), o erro ORIGINAL — com `code`, `details` e a
 * stack — some se o novo `Error` não o carregar. O usuário precisa da mensagem de domínio; o
 * plantão precisa do original. `cause` entrega os dois sem escolher entre eles.
 */
export function erroComCausa(mensagem: string, causa: unknown): Error {
  const erro = new Error(mensagem) as Error & { cause?: unknown };
  erro.cause = causa;
  return erro;
}
