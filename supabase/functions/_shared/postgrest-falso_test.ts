// postgrest-falso_test.ts — helper SÓ PARA `*_test.ts` (sufixo `_test` deliberado: fica fora da superfície das
// edges, como o `harness-handler_test.ts`). Simula, por ROTA, o que o `createClient` real manda ao PostgREST e às
// outras URLs de uma edge, para rodar o `index.ts` de verdade (item 8.1 do plano Sayerlack, revisão 2).
//
// Contrato com o supabase-js (postgrest-js 2.x do `node_modules`):
//   · `.from(t).select()...maybeSingle()` → GET com Accept JSON; a resposta é ARRAY e o cliente pega o [0] (ou null).
//   · `.single()` → Accept `application/vnd.pgrst.object+json`; a resposta é UM objeto (0 linhas = 406).
//   · `.rpc(f, args)` → POST `/rest/v1/rpc/<f>` com os args no corpo.
//   · erro do banco → status ≥ 400 com `{code, message}`: é o `error.code` (sqlstate) que a edge lê.
//   · `throw` dentro de um handler = falha de REDE: o postgrest-js devolve `error` com `code` vazio.
// Rota sem handler LANÇA ("rota não prevista"): teste que bate numa URL inesperada falha alto, nunca passa mudo.

export interface Chamada {
  metodo: string;
  /** `rest:<tabela>`, `rpc:<funcao>` ou a URL sem query para o que não é PostgREST. */
  rota: string;
  params: URLSearchParams;
  corpo: unknown;
}

export type Resposta = { status?: number; corpo?: unknown } | "rede";
export type Rota = (c: Chamada) => Resposta | Promise<Resposta>;

export interface PostgrestFalso {
  responder(r: Request): Promise<Response>;
  chamadas: Chamada[];
  /** Chamadas a uma rota (`rest:x`, `rpc:y` ou prefixo de URL externa). */
  de(rota: string, metodo?: string): Chamada[];
}

export function erroBanco(code: string, message: string, status = 400): Resposta {
  return { status, corpo: { code, message, details: null, hint: null } };
}

export function criarPostgrestFalso(baseSupabase: string, rotas: Record<string, Rota>): PostgrestFalso {
  const chamadas: Chamada[] = [];
  return {
    chamadas,
    de: (rota, metodo) => chamadas.filter((c) => c.rota.startsWith(rota) && (!metodo || c.metodo === metodo)),
    async responder(r: Request): Promise<Response> {
      const url = new URL(r.url);
      let rota: string;
      if (url.href.startsWith(`${baseSupabase}/rest/v1/rpc/`)) rota = `rpc:${url.pathname.replace("/rest/v1/rpc/", "")}`;
      else if (url.href.startsWith(`${baseSupabase}/rest/v1/`)) rota = `rest:${url.pathname.replace("/rest/v1/", "")}`;
      else rota = `${url.origin}${url.pathname}`;
      const txt = await r.text();
      let corpo: unknown = null;
      try {
        corpo = txt ? JSON.parse(txt) : null;
      } catch {
        corpo = txt;
      }
      const c: Chamada = { metodo: r.method, rota, params: url.searchParams, corpo };
      chamadas.push(c);
      const chave = Object.keys(rotas).find((k) => k === `${r.method} ${rota}`) ??
        Object.keys(rotas).find((k) => k === rota);
      if (!chave) throw new Error(`postgrest-falso: rota não prevista ${r.method} ${rota}`);
      const resp = await rotas[chave](c);
      if (resp === "rede") throw new TypeError("falha de rede simulada");
      const status = resp.status ?? 200;
      let saida = resp.corpo ?? null;
      const querObjeto = (r.headers.get("Accept") ?? "").includes("vnd.pgrst.object");
      if (querObjeto && Array.isArray(saida)) {
        if (saida.length !== 1) {
          return new Response(JSON.stringify({ code: "PGRST116", message: `${saida.length} linhas` }), { status: 406 });
        }
        saida = saida[0];
      }
      return new Response(JSON.stringify(saida), { status, headers: { "content-type": "application/json" } });
    },
  };
}
