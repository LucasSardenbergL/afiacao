import { createClient } from "@supabase/supabase-js";
import { defineTool, type ToolContext } from "@lovable.dev/mcp-js";
import { z } from "zod";

function supabaseForUser(ctx: ToolContext) {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    global: { headers: { Authorization: `Bearer ${ctx.getToken()}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Sanitiza input para o parser do `.or()` do PostgREST — remove vírgula (separador de cláusula),
// parênteses (agrupamento), aspas, barra e os wildcards `% _ *`. Sem isto, um `query` como
// `x,id.gt.0` injeta um predicado extra e alarga o resultado dentro do que a RLS libera.
// Inlined (espelha @/lib/postgrest.sanitizeForPostgrestOr) porque este módulo é bundlado para a
// edge MCP em Deno, que não resolve o alias `@/`.
function sanitizeOrTerm(input: string): string {
  return input.replace(/[%_,()\\"*]/g, "");
}

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
    const safe = sanitizeOrTerm(query);
    // Termo degenerado (vazio ou só-metacaracteres) colapsaria para `col.ilike.%%` = match-all —
    // não deve enumerar toda a tabela; devolve vazio.
    if (!safe) {
      return { content: [{ type: "text", text: "[]" }], structuredContent: { results: [] } };
    }
    const sb = supabaseForUser(ctx);
    const predicado = ["name", "document", "email", "phone"]
      .map((c) => `${c}.ilike.%${safe}%`)
      .join(",");
    const { data, error } = await sb
      .from("profiles")
      .select("user_id, name, document, phone, email, customer_type")
      .or(predicado)
      .limit(20);
    if (error) {
      return { content: [{ type: "text", text: error.message }], isError: true };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(data ?? []) }],
      structuredContent: { results: data ?? [] },
    };
  },
});
