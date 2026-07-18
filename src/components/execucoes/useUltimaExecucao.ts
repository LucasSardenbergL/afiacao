import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { ULTIMA_EXECUCAO_QUERY_KEY, type AcaoExecucao } from "./tipos";

// acoes_execucoes ainda não está no types.ts gerado (regen é do Lovable) →
// cast estrutural mínimo, mesmo idioma do useCarteiraSaude.
interface SelectExecucoes {
  from(tabela: "acoes_execucoes"): {
    select(colunas: "*"): {
      in(coluna: "acao", valores: string[]): {
        order(
          coluna: "iniciado_em",
          opcoes: { ascending: boolean },
        ): {
          limit(n: number): PromiseLike<{ data: AcaoExecucao[] | null; error: { message: string } | null }>;
        };
      };
    };
  };
}

/** Última execução registrada entre um ou mais slugs de ação (linha mais recente). */
export function useUltimaExecucao(acao: string | string[]): UseQueryResult<AcaoExecucao | null> {
  const acoes = (Array.isArray(acao) ? acao : [acao]).slice().sort();
  return useQuery({
    queryKey: [ULTIMA_EXECUCAO_QUERY_KEY, ...acoes],
    // Antes da migration aplicada em prod a tabela não existe (42P01) — 1 retry basta;
    // o componente degrada pra "Nunca executada" sem quebrar a página.
    retry: 1,
    queryFn: async () => {
      const cliente = supabase as unknown as SelectExecucoes;
      const { data, error } = await cliente
        .from("acoes_execucoes")
        .select("*")
        .in("acao", acoes)
        .order("iniciado_em", { ascending: false })
        .limit(1);
      if (error) throw new Error(error.message);
      return data?.[0] ?? null;
    },
  });
}
