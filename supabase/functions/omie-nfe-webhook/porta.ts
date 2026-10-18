// Adaptador do supabase-js à porta de `importacao.ts`. Cada método DEVOLVE, nunca lança.
//
// Separado do `index.ts` (que importa `npm:` e por isso não entra no `deno test --no-remote`)
// para que a parte que INTERPRETA a resposta do PostgREST — contagem embutida, NULL comprovado,
// SQLSTATE — seja testável com um cliente falso (`porta_test.ts`). O cliente entra pelo contrato
// ESTRUTURAL `ClienteRecebimentos` (padrão da casa: `BancoPostgrest` em `_shared/paginate.ts`), não
// como `SupabaseClient`: o fake do teste o satisfaz sem importar o npm, e o cliente real entra por
// cast no call-site (`index.ts`). `any` aqui o ESLint do CI barra (`no-explicit-any`).
import type { ErroEscrita, LeituraPorChave, PortaRecebimento } from "./importacao.ts";

/** Erro como o PostgREST o devolve: `message` e `code` (SQLSTATE). */
export type ErroPostgrest = { message?: unknown; code?: unknown };
export type RespostaPostgrest = { data?: unknown; error: ErroPostgrest | null };

/** O que esta porta usa do supabase-js — e NADA mais. */
export interface ClienteRecebimentos {
  from(tabela: string): {
    select(colunas: string): { eq(coluna: string, valor: string): { maybeSingle(): Promise<RespostaPostgrest> } };
    insert(linhas: Record<string, unknown> | Record<string, unknown>[]): {
      select(colunas: string): { single(): Promise<RespostaPostgrest> };
      then(ok: (resposta: RespostaPostgrest) => unknown): unknown;
    };
  };
}

/** Colunas cujo NULL comprovado é condição para reparar. */
export const SINAIS_DE_USO = ["conferente_id", "conferido_at", "efetivado_at", "efetivacao_lock_at"] as const;

export const SELECT_CABECALHO = `id, status, ${SINAIS_DE_USO.join(", ")}, nfe_recebimento_itens(count)`;

/** Contagem comprovada: inteiro ≥ 0. Qualquer outra coisa (ausente, string, NaN, negativo, fração) é ilegível. */
export function contagemComprovada(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

/** true se algum sinal está preenchido OU ausente da resposta (ausente não é NULL comprovado). */
export function emUso(linha: Record<string, unknown>): boolean {
  return SINAIS_DE_USO.some((c) => !(c in linha) || linha[c] !== null);
}

/** Interpreta a linha do `SELECT_CABECALHO` (sem o transporte) — o que `porta_test.ts` exercita. */
export function interpretarCabecalho(data: unknown): LeituraPorChave {
  if (data === null || data === undefined) return { tipo: "nenhuma" };
  if (typeof data !== "object" || Array.isArray(data)) return { tipo: "erro", mensagem: "cabeçalho em formato inesperado" };
  const linha = data as Record<string, unknown>;
  if (typeof linha.id !== "string" || typeof linha.status !== "string") {
    return { tipo: "erro", mensagem: "cabeçalho sem id/status legíveis" };
  }
  const embutido = linha.nfe_recebimento_itens;
  const bruto = Array.isArray(embutido) && embutido.length === 1 && embutido[0] && typeof embutido[0] === "object"
    ? (embutido[0] as Record<string, unknown>).count
    : undefined;
  const itens = contagemComprovada(bruto);
  // Contagem ilegível é ERRO, não zero: "já importada" sobre contagem não lida esconderia o defeito.
  if (itens === null) return { tipo: "erro", mensagem: "contagem de itens da NF-e indisponível" };
  return { tipo: "existe", id: linha.id, status: linha.status, itens, emUso: emUso(linha) };
}

function erroDe(error: ErroPostgrest): ErroEscrita {
  return {
    erro: typeof error.message === "string" ? error.message : "erro sem mensagem",
    code: typeof error.code === "string" ? error.code : null,
  };
}

export function portaSupabase(supabase: ClienteRecebimentos): PortaRecebimento {
  return {
    async buscarPorChave(chave) {
      const { data, error } = await supabase
        .from("nfe_recebimentos")
        .select(SELECT_CABECALHO)
        .eq("chave_acesso", chave)
        .maybeSingle();
      if (error) return { tipo: "erro", mensagem: `ler nfe_recebimentos: ${erroDe(error).erro}` };
      return interpretarCabecalho(data);
    },
    async inserirCabecalho(row) {
      const { data, error } = await supabase.from("nfe_recebimentos").insert(row).select("id").single();
      if (error) return erroDe(error);
      const id = (data as { id?: unknown } | null)?.id;
      if (typeof id !== "string") return { erro: "o insert do cabeçalho não devolveu o id", code: null };
      return { id };
    },
    async inserirItens(linhas) {
      const { error } = await supabase.from("nfe_recebimento_itens").insert(linhas);
      return error ? erroDe(error) : null;
    },
  };
}
