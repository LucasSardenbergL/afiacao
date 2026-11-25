import { createClient } from "@supabase/supabase-js";
import { defineTool, type ToolContext } from "@lovable.dev/mcp-js";
import { z } from "zod";

function supabaseForUser(ctx: ToolContext) {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    global: { headers: { Authorization: `Bearer ${ctx.getToken()}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// MIRROR-START postgrest-or — manter IDÊNTICO ao bloco de src/lib/postgrest.ts. Inlined porque este
// módulo é bundlado para a edge MCP em Deno (supabase/functions/mcp, gerado pelo @lovable.dev/mcp-js),
// que não resolve o alias `@/`. Sanitiza o termo para o parser do `.or()` — tira vírgula (separador de
// cláusula), parênteses, aspas, barra e os curingas `% _ *`; sem isto, um `query` como `x,id.gt.0`
// injeta um predicado extra dentro do que a RLS libera. A paridade é vigiada pelo CI
// (edge-money-path-invariants) — a deriva de uma cópia foi o B1.
function sanitizeForPostgrestOr(input: string): string {
  return input.replace(/[%_,()\\"*]/g, '');
}
function isSearchablePostgrestTerm(term: string): boolean {
  return sanitizeForPostgrestOr(term) !== '';
}
// MIRROR-END postgrest-or

export default defineTool({
  name: "search_customers",
  title: "Search customers",
  description:
    "Search customer profiles by name, document (CPF/CNPJ), email or phone. Returns up to 20 matches. Requires authentication; results are filtered by the caller's row-level permissions.",
  inputSchema: {
    query: z.string().trim().min(2).describe("Search term: name, document, email, or phone."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ query }, ctx) => {
    if (!ctx.isAuthenticated()) {
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    }
    // Termo degenerado (vazio ou só-metacaracteres) colapsaria para `col.ilike.%%` = match-all —
    // não deve enumerar toda a tabela; devolve vazio.
    if (!isSearchablePostgrestTerm(query)) {
      return { content: [{ type: "text", text: "[]" }], structuredContent: { results: [] } };
    }
    const safe = sanitizeForPostgrestOr(query);
    const sb = supabaseForUser(ctx);
    // Onda D: nome casa em qualquer cliente; documento/e-mail/telefone só casam (e só voltam) onde o
    // contato é visível — o filtro corre na view MASCARADA v_perfil_contato.
    const predicado = (cols: string[]) => cols.map((c) => `${c}.ilike.%${safe}%`).join(",");
    const predicadoContato = predicado(["document", "email", "phone"]);
    const [porNome, porContato] = await Promise.all([
      sb.from("profiles").select("user_id").or(predicado(["name"])).limit(20),
      sb.from("v_perfil_contato").select("user_id").or(predicadoContato).limit(20),
    ]);
    const erro = porNome.error ?? porContato.error;
    if (erro) {
      return { content: [{ type: "text", text: erro.message }], isError: true };
    }
    const ids = [...new Set([...(porNome.data ?? []), ...(porContato.data ?? [])].map((r) => r.user_id as string))].slice(0, 20);
    let data: Array<Record<string, unknown>> = [];
    if (ids.length > 0) {
      const [ident, contato] = await Promise.all([
        sb.from("profiles").select("user_id, name, customer_type").in("user_id", ids),
        sb.from("v_perfil_contato").select("user_id, document, phone, email, contato_visivel").in("user_id", ids),
      ]);
      const erro2 = ident.error ?? contato.error;
      if (erro2) {
        return { content: [{ type: "text", text: erro2.message }], isError: true };
      }
      const porId = new Map((contato.data ?? []).map((c) => [c.user_id as string, c]));
      data = (ident.data ?? []).map((p) => {
        const c = porId.get(p.user_id as string);
        return { ...p, document: c?.document ?? null, phone: c?.phone ?? null, email: c?.email ?? null,
          contato_visivel: c?.contato_visivel === true };
      });
    }
    return {
      content: [{ type: "text", text: JSON.stringify(data) }],
      structuredContent: { results: data },
    };
  },
});
