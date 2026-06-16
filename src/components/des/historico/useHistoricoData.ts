// Hook de dados/estado do HistoricoTab.
// Extraído verbatim de src/components/des/HistoricoTab.tsx (god-component split):
// 4 queries (metas/snapshots/checkins/posição ao vivo) + memos derivados + filtros.
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { quarterDates } from "./format";
import type {
  MetaRow,
  SnapshotRow,
  CheckinDescontoRow,
  PosicaoLiveRow,
  QuarterCard,
} from "./types";

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
      return (data ?? []) as unknown as CheckinDescontoRow[];
    },
  });

  // Posição ao vivo (apenas trimestre corrente)
  const posLiveQuery = useQuery({
    queryKey: ["des-historico-poslive", empresa, anoAtual, trimestreAtual],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("v_des_posicao_trimestre_ao_vivo")
        .select("ano, trimestre, posicao_ao_vivo_conservadora, faixa_conservadora, meta_pessoal, inicio_trimestre, fim_trimestre")
        .eq("empresa", empresa)
        .eq("ano", anoAtual)
        .eq("trimestre", trimestreAtual)
        .maybeSingle();
      if (error) throw error;
      return data as unknown as PosicaoLiveRow | null;
    },
  });

  const cards: QuarterCard[] = useMemo(() => {
    const metas = metasQuery.data ?? [];
    const snapshots = snapshotsQuery.data ?? [];
    const checkins = checkinsQuery.data ?? [];
    const live = posLiveQuery.data;

    const keys = new Set<string>();
    metas.forEach((m) => keys.add(`${m.ano}-${m.trimestre}`));
    snapshots.forEach((s) => keys.add(`${s.ano}-${s.trimestre}`));
    checkins.forEach((c) => keys.add(`${c.ano}-${c.trimestre}`));
    keys.add(`${anoAtual}-${trimestreAtual}`);

    const list: QuarterCard[] = Array.from(keys).map((k) => {
      const [a, t] = k.split("-").map(Number);
      const isAtual = a === anoAtual && t === trimestreAtual;
      const meta = metas.find((m) => m.ano === a && m.trimestre === t);
      const snapsTri = snapshots.filter((s) => s.ano === a && s.trimestre === t);
      const ultimoSnap = snapsTri[0]; // já vem desc
      // Para trimestre corrente, prioriza posicao ao vivo conservadora
      const faturado = isAtual
        ? Number(live?.posicao_ao_vivo_conservadora ?? ultimoSnap?.fat_bruto_valor ?? 0)
        : Number(ultimoSnap?.fat_bruto_valor ?? 0);

      // Último checkin: confirmacao_andre tem prioridade, senão projecao
      const checkinsTri = checkins.filter((c) => c.ano === a && c.trimestre === t);
      const ultimoCheckin =
        checkinsTri.find((c) => c.tipo === "confirmacao_andre") ??
        checkinsTri[0] ??
        null;

      const faixaEstrelas = isAtual
        ? Number(live?.faixa_conservadora?.estrelas ?? ultimoCheckin?.estrelas ?? 0)
        : Number(ultimoCheckin?.estrelas ?? 0);

      const dates = quarterDates(a, t);
      return {
        ano: a,
        trimestre: t,
        isAtual,
        meta: Number(meta?.meta_faturamento ?? live?.meta_pessoal ?? 0),
        faturado,
        faixaEstrelas,
        inicio: isAtual ? (live?.inicio_trimestre ?? dates.inicio) : dates.inicio,
        fim: isAtual ? (live?.fim_trimestre ?? dates.fim) : dates.fim,
        ultimoCheckin,
        snapshots: snapsTri,
      };
    });

    // Ordena desc (ano, trimestre)
    list.sort((a, b) => (b.ano - a.ano) || (b.trimestre - a.trimestre));
    return list;
  }, [metasQuery.data, snapshotsQuery.data, checkinsQuery.data, posLiveQuery.data, anoAtual, trimestreAtual]);

  const anosDisponiveis = useMemo(() => {
    const set = new Set<number>();
    cards.forEach((c) => set.add(c.ano));
    return Array.from(set).sort((a, b) => b - a);
  }, [cards]);

  const cardsFiltrados = useMemo(() => {
    return cards.filter((c) => {
      if (filtroAno !== "__todos__" && String(c.ano) !== filtroAno) return false;
      if (filtroStatus === "andamento" && !c.isAtual) return false;
      if (filtroStatus === "encerrados" && c.isAtual) return false;
      return true;
    });
  }, [cards, filtroAno, filtroStatus]);

  const chartData = useMemo(() => {
    return [...cardsFiltrados]
      .sort((a, b) => (a.ano - b.ano) || (a.trimestre - b.trimestre))
      .map((c) => ({
        label: `T${c.trimestre}/${String(c.ano).slice(2)}`,
        faturado: c.faturado,
        meta: c.meta,
        isAtual: c.isAtual,
      }));
  }, [cardsFiltrados]);

  const metaMedia = useMemo(() => {
    const metas = chartData.map((d) => d.meta).filter((m) => m > 0);
    if (!metas.length) return 0;
    return metas.reduce((a, b) => a + b, 0) / metas.length;
  }, [chartData]);

  const isLoading =
    metasQuery.isLoading ||
    snapshotsQuery.isLoading ||
    checkinsQuery.isLoading ||
    posLiveQuery.isLoading;

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
  };
}
