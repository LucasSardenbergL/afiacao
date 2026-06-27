import { useMutation } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  classificarCanaria,
  type ResultadoCanaria,
  type RespostaCanaria,
} from "@/lib/governanca/canaria-preco";

export interface VerificacaoCanaria extends ResultadoCanaria {
  em: number; // epoch ms da verificação (p/ "última checagem" no card)
}

// Chama a canária comportamental do edge de preço deployado ({canary:true}) usando o JWT do
// staff JÁ LOGADO (o client injeta o Bearer; a edge exige role employee/master). Prova que a
// EDGE EM PROD honra "order_items vence o Omie" — detecta reversão silenciosa do deploy do
// Lovable que o invariante do repo (CI) não pega. NÃO lança: qualquer erro vira canária
// vermelha (status 'erro'), nunca exceção (Codex: erro HTTP é falha, não "sem dados").
export function useCanariaPreco() {
  const mutation = useMutation<VerificacaoCanaria, never, void>({
    mutationFn: async () => {
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
    },
  });

  return {
    verificar: () => mutation.mutate(),
    verificando: mutation.isPending,
    resultado: mutation.data ?? null,
  };
}
