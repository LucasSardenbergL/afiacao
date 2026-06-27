import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  classificarCanaria,
  type ResultadoCanaria,
  type RespostaCanaria,
} from "@/lib/governanca/canaria-preco";

export interface VerificacaoCanaria extends ResultadoCanaria {
  em: number; // epoch ms da verificação (p/ "última checagem" no card)
}

// Chama a canária comportamental do edge de preço deployado ({canary:true}) com o JWT do
// staff JÁ LOGADO (o client injeta o Bearer; a edge exige role employee/master). Prova que a
// EDGE EM PROD honra "order_items vence o Omie" — detecta reversão silenciosa do deploy do
// Lovable que o invariante do repo (CI) não pega. NÃO lança: qualquer erro vira canária
// vermelha (status 'erro'), nunca exceção (Codex: erro HTTP é falha, não "sem dados").
async function rodarCanaria(): Promise<VerificacaoCanaria> {
  try {
    const { data, error } = await supabase.functions.invoke("analyze-unified-order", {
      body: { canary: true },
    });
    const r = classificarCanaria(data as RespostaCanaria | null, error);
    return { ...r, em: Date.now() };
  } catch (e) {
    const r = classificarCanaria(null, e);
    return { ...r, em: Date.now() };
  }
}

// PULL OPORTUNISTA (Codex): roda no MOUNT via useQuery — toda vez que um staff abre Governança
// → Auditoria a canária verifica sozinha, sem depender do clique. NÃO é monitoramento contínuo
// (descartamos a Opção D: cron exigiria credencial staff persistente no CI = expõe PII), mas
// cobre muito mais que o botão manual a custo zero de segurança. staleTime re-roda ao reabrir o
// admin e faz dedupe de re-renders próximos; retry:false porque erro já é tratado como dado.
export function useCanariaPreco() {
  const query = useQuery({
    queryKey: ["canaria-preco"],
    queryFn: rodarCanaria,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  return {
    verificar: () => {
      void query.refetch();
    },
    verificando: query.isFetching,
    resultado: query.data ?? null,
  };
}
