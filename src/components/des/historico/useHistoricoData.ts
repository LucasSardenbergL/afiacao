// Hook de dados/estado do HistoricoTab.
// 4 queries (metas/snapshots/checkins/posição ao vivo) + derivação pura (./derivar) + filtros.
// Expõe isLoading E isError: leitura que falhou não vira lista vazia nem trimestre zerado.
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { MetaRow, SnapshotRow, QuarterCard } from "./types";
import { desatualizado, estadoDeLeitura, type EstadoSemLeitura } from "@/lib/leitura/estado-de-leitura";
import { montarCards, montarChartData, mediaDasMetas, type PosicaoAoVivo } from "./derivar";
import { linhasCom } from "@/lib/linha-view";

export function useHistoricoData(empresa: string, anoAtual: number, trimestreAtual: number) {
  const [filtroAno, setFiltroAno] = useState<string>("__todos__");
  const [filtroStatus, setFiltroStatus] = useState<string>("todos");

  // Metas
  const metasQuery = useQuery({
    queryKey: ["des-historico-metas", empresa],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("des_meta_empresa")
        .select("ano, trimestre, meta_faturamento, faixa_des_objetivo")
        .eq("empresa", empresa)
        .order("ano", { ascending: false })
        .order("trimestre", { ascending: false });
      if (error) throw error;
      return (data ?? []) as MetaRow[];
    },
  });

  // Snapshots (todos)
  const snapshotsQuery = useQuery({
    queryKey: ["des-historico-snapshots", empresa],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("des_trimestre_snapshot")
        .select("ano, trimestre, data_referencia, fat_bruto_valor, pedidos_abertos_valor, objetivo_valor")
        .eq("empresa", empresa)
        .order("data_referencia", { ascending: false });
      if (error) throw error;
      return (data ?? []) as SnapshotRow[];
    },
  });

  // Checkins (via view de desconto)
  const checkinsQuery = useQuery({
    queryKey: ["des-historico-checkins", empresa],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("v_des_desconto_por_checkin")
        .select("*")
        .eq("empresa", empresa)
        .order("data_avaliacao", { ascending: false });
      if (error) throw error;
      return linhasCom(data, ["checkin_id", "ano", "trimestre", "data_avaliacao", "tipo"], "v_des_desconto_por_checkin");
    },
  });

  // Posição ao vivo (apenas trimestre corrente)
  const posLiveQuery = useQuery({
    queryKey: ["des-historico-poslive", empresa, anoAtual, trimestreAtual],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("v_des_posicao_trimestre_ao_vivo")
        .select(
          "ano, trimestre, posicao_ao_vivo_conservadora, fat_bruto_confirmado, gooddata_data_referencia, faixa_conservadora, meta_pessoal, inicio_trimestre, fim_trimestre",
        )
        .eq("empresa", empresa)
        .eq("ano", anoAtual)
        .eq("trimestre", trimestreAtual)
        .maybeSingle();
      if (error) throw error;
      return data as PosicaoAoVivo | null;
    },
  });

  // Derivação pura (ausente ≠ zero · meta do próprio trimestre) — ver ./derivar.ts.
  const cards: QuarterCard[] = useMemo(
    () =>
      montarCards({
        metas: metasQuery.data ?? [],
        snapshots: snapshotsQuery.data ?? [],
        checkins: checkinsQuery.data ?? [],
        live: posLiveQuery.data,
        anoAtual,
        trimestreAtual,
      }),
    [metasQuery.data, snapshotsQuery.data, checkinsQuery.data, posLiveQuery.data, anoAtual, trimestreAtual],
  );

  const anosDisponiveis = useMemo(() => {
    const set = new Set<number>();
    cards.forEach((c) => set.add(c.ano));
    return Array.from(set).sort((a, b) => b - a);
  }, [cards]);

  const cardsFiltrados = useMemo(() => {
    return cards.filter((c) => {
      if (filtroAno !== "__todos__" && String(c.ano) !== filtroAno) return false;
      if (filtroStatus === "andamento" && !c.isAtual) return false;
      if (filtroStatus === "encerrados" && (c.isAtual || c.isFuturo)) return false;
      return true;
    });
  }, [cards, filtroAno, filtroStatus]);

  const chartData = useMemo(() => montarChartData(cardsFiltrados), [cardsFiltrados]);

  const metaMedia = useMemo(() => mediaDasMetas(chartData), [chartData]);

  // Fail-closed: QUALQUER leitura que não aconteceu (erro, inclusive após sucesso com cache, ou
  // offline na 1ª leitura — pending+paused, que NÃO é isLoading) → a tela não julga trimestre
  // nenhum. Dado parcial tratado como completo vira "sem dado" em massa ou "Nenhum trimestre".
  // Com cache em mãos, `estadoDeLeitura` diz 'pronta' mesmo com o refetch pausado offline:
  // `desatualizado` nomeia isso — a posição "ao vivo" velha não pode passar por atual.
  const queries = [metasQuery, snapshotsQuery, checkinsQuery, posLiveQuery];
  const estados = queries.flatMap((q) => [estadoDeLeitura(q), desatualizado(q, q.data !== undefined)]);
  const estadoSemLeitura: EstadoSemLeitura | null = estados.includes("erro")
    ? "erro"
    : estados.includes("sem-rede")
      ? "sem-rede"
      : null;
  const isLoading = estados.includes("carregando");

  return {
    filtroAno,
    setFiltroAno,
    filtroStatus,
    setFiltroStatus,
    cards,
    anosDisponiveis,
    cardsFiltrados,
    chartData,
    metaMedia,
    isLoading,
    estadoSemLeitura,
  };
}
