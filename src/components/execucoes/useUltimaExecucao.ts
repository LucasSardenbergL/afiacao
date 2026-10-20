import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { ULTIMA_EXECUCAO_QUERY_KEY, execucaoDaLinha, type AcaoExecucao } from "./tipos";

/** Última execução registrada entre um ou mais slugs de ação (linha mais recente). */
export function useUltimaExecucao(acao: string | string[]): UseQueryResult<AcaoExecucao | null> {
  const acoes = (Array.isArray(acao) ? acao : [acao]).slice().sort();
  return useQuery({
    queryKey: [ULTIMA_EXECUCAO_QUERY_KEY, ...acoes],
    // Antes da migration aplicada em prod a tabela não existe (42P01) — 1 retry basta;
    // o componente degrada pra "Nunca executada" sem quebrar a página.
    retry: 1,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("acoes_execucoes")
        .select("*")
        .in("acao", acoes)
        .order("iniciado_em", { ascending: false })
        .limit(1);
      if (error) throw new Error(error.message);
      const ultima = data?.[0];
      return ultima ? execucaoDaLinha(ultima) : null;
    },
  });
}
