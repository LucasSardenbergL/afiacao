import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export const REPOSICAO_EMPRESA = "OBEN";

/**
 * Contador de oportunidades econômicas ativas (OBEN) do badge global (`AppShell`).
 * Hook único: quem mais precisar do count usa a MESMA queryKey e o react-query
 * DEDUPLICA (antes: 2 pollers independentes batendo na MESMA view cara).
 *
 * Degradação honesta (money-path: ausente ≠ zero): a view é cara (RLS + EOQ) e
 * pode dar 500 sob cache frio. Em erro retorna `null` (indeterminado), NUNCA `0`
 * nem `throw` — o consumidor mostra "—"/oculta o badge, não fabrica "0
 * oportunidades". `retry: 1` evita martelar a view a cada falha.
 */
export function useOportunidadesAtivasCount(options?: { enabled?: boolean }) {
  return useQuery<number | null>({
    queryKey: ["oportunidades-ativas-count", REPOSICAO_EMPRESA],
    queryFn: async () => {
      // Fase 2: lê o count materializado (MV em private, refresh por cron 2h) através da
      // view-gate, em vez do count(*) caro (880ms estrutural) da view tempo-real. A tela de
      // Oportunidades segue tempo-real. Degradação honesta preservada (erro → null, ≠ 0).
      const { data, error } = await supabase
        .from("v_oportunidade_economica_hoje_badge_cached")
        .select("oportunidade_count")
        .eq("empresa", REPOSICAO_EMPRESA)
        .maybeSingle();
      if (error) return null; // indeterminado (≠ 0)
      return data?.oportunidade_count ?? 0; // sem linha = empresa sem oportunidade = 0 legítimo
    },
    enabled: options?.enabled ?? true,
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    retry: 1,
  });
}

