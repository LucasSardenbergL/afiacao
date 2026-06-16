// Dados do simulador DES (prazos, posição atual, faixas) + derivações.
// Extraído verbatim de src/components/des/SimuladorTab.tsx (god-component split).
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { PrazoOption } from "./types";

export function useSimuladorData(empresa: string, ano: number, trimestre: number) {
  // Prazos disponíveis
  const prazosQuery = useQuery({
    queryKey: ["des-prazos", empresa],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("fornecedor_prazo_pagamento_config")
        .select("id, codigo, nome, desconto_ou_encargo_perc, padrao, ativo")
        .eq("empresa", empresa)
        .eq("ativo", true)
        .order("padrao", { ascending: false })
        .order("id");
      if (error) throw error;
      return (data ?? []) as PrazoOption[];
    },
  });

  // Posição atual (para faltam_proxima_faixa)
  const posQuery = useQuery({
    queryKey: ["des-posicao-sim", empresa, ano, trimestre],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("v_des_posicao_trimestre_ao_vivo" as never)
        .select("posicao_ao_vivo_conservadora, faixa_conservadora")
        .eq("empresa" as never, empresa as never)
        .eq("ano" as never, ano as never)
        .eq("trimestre" as never, trimestre as never)
        .maybeSingle();
      if (error) throw error;
      return data as unknown as {
        posicao_ao_vivo_conservadora: number | null;
        faixa_conservadora: { faixa_numero?: number; estrelas?: number; volume_max?: number } | null;
      } | null;
    },
  });

  // Faixas para descobrir o volume_min da próxima faixa
  const faixasQuery = useQuery({
    queryKey: ["des-faixas-all"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("des_faixa_quantitativa")
        .select("faixa_numero, estrelas, volume_min, volume_max")
        .order("faixa_numero", { ascending: true });
      if (error) throw error;
      return (data ?? []) as Array<{
        faixa_numero: number;
        estrelas: number;
        volume_min: number;
        volume_max: number | null;
      }>;
    },
  });

  const faltamProximaFaixa = useMemo(() => {
    const conserv = Number(posQuery.data?.posicao_ao_vivo_conservadora ?? 0);
    const faixas = faixasQuery.data ?? [];
    const atualNumero = posQuery.data?.faixa_conservadora?.faixa_numero ?? 0;
    const proxima = faixas.find((f) => f.faixa_numero === atualNumero + 1);
    if (!proxima) return null;
    const gap = Number(proxima.volume_min) - conserv;
    return gap > 0 ? gap : null;
  }, [posQuery.data, faixasQuery.data]);

  const prazos = prazosQuery.data ?? [];
  const defaultPrazo = useMemo(
    () => prazos.find((p) => p.padrao)?.codigo ?? prazos[0]?.codigo ?? "antecipado",
    [prazos],
  );

  const compareDefault = useMemo(
    () => prazos.find((p) => p.codigo !== defaultPrazo)?.codigo ?? defaultPrazo,
    [prazos, defaultPrazo],
  );

  const isLoading = prazosQuery.isLoading || posQuery.isLoading || faixasQuery.isLoading;

  return { prazos, faltamProximaFaixa, defaultPrazo, compareDefault, isLoading };
}
