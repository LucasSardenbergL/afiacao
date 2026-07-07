// Lógica do check-in qualitativo DES (queries, respostas, salvar projeção/confirmação).
// Extraída verbatim de src/components/des/CheckinQualitativoTab.tsx (god-component split).
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import {
  type Props,
  type Criterio,
  type CriterioPercentual,
  type DescontoCheckin,
  type CheckinAtualRow,
  type PosicaoTrimestreRow,
  type DescontoCheckinRow,
  type CheckinQualitativoRow,
  type Resposta,
} from "./types";

export function useCheckinQualitativo({ empresa, ano, trimestre }: Props) {
  const { user } = useAuth();
  const qc = useQueryClient();

  const [respostas, setRespostas] = useState<Record<number, Resposta>>({});
  const [saving, setSaving] = useState(false);
  const [confirmAndreOpen, setConfirmAndreOpen] = useState(false);

  // Critérios cadastrados
  const criteriosQuery = useQuery({
    queryKey: ["des-criterios"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("des_criterio_qualitativo")
        .select("id, codigo, nome, descricao, ordem, tipo")
        .order("ordem", { ascending: true });
      if (error) throw error;
      return (data ?? []) as Criterio[];
    },
  });

  // Posição ao vivo (para descobrir faixa atual e percentuais)
  const posicaoQuery = useQuery({
    queryKey: ["des-posicao-checkin", empresa, ano, trimestre],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("v_des_posicao_trimestre_ao_vivo" as never)
        .select("faixa_conservadora, faixa_otimista")
        .eq("empresa", empresa)
        .eq("ano", ano)
        .eq("trimestre", trimestre)
        .maybeSingle();
      if (error) throw error;
      return data as unknown as PosicaoTrimestreRow | null;
    },
  });

  // Percentuais por critério para a faixa atual
  const faixaConservId = posicaoQuery.data?.faixa_conservadora?.faixa_id ?? null;

  const percentuaisQuery = useQuery({
    queryKey: ["des-percentuais", faixaConservId],
    enabled: !!faixaConservId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("des_criterio_percentual")
        .select("criterio_id, faixa_id, percentual")
        .eq("faixa_id", faixaConservId as number);
      if (error) throw error;
      return (data ?? []) as CriterioPercentual[];
    },
  });

  // Checkin atual (mais recente do trimestre)
  const checkinAtualQuery = useQuery({
    queryKey: ["des-checkin-atual", empresa, ano, trimestre],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("v_des_checkin_atual" as never)
        .select("*")
        .eq("empresa", empresa)
        .eq("ano", ano)
        .eq("trimestre", trimestre);
      if (error) throw error;
      return (data ?? []) as unknown as CheckinAtualRow[];
    },
  });

  // Desconto projetado para o checkin atual
  const descontoQuery = useQuery({
    queryKey: ["des-desconto", empresa, ano, trimestre],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("v_des_desconto_por_checkin" as never)
        .select("*")
        .eq("empresa", empresa)
        .eq("ano", ano)
        .eq("trimestre", trimestre)
        .order("data_avaliacao", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as unknown as DescontoCheckin | null;
    },
  });

  // Histórico de checkins do trimestre
  const historicoQuery = useQuery({
    queryKey: ["des-checkin-historico", empresa, ano, trimestre],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("v_des_desconto_por_checkin" as never)
        .select("*")
        .eq("empresa", empresa)
        .eq("ano", ano)
        .eq("trimestre", trimestre)
        .order("data_avaliacao", { ascending: false });
      if (error) throw error;
      const rows = (data ?? []) as unknown as DescontoCheckinRow[];
      // join avaliado_por via des_checkin_qualitativo
      const ids = rows.map((d) => d.checkin_id).filter(Boolean);
      const porMap: Record<number, string | null> = {};
      if (ids.length) {
        const { data: chs } = await supabase
          .from("des_checkin_qualitativo")
          .select("id, avaliado_por")
          .in("id", ids);
        const chsRows = (chs ?? []) as unknown as CheckinQualitativoRow[];
        chsRows.forEach((c) => { porMap[c.id] = c.avaliado_por; });
      }
      return rows.map((d) => ({
        ...d,
        avaliado_por: porMap[d.checkin_id] ?? null,
      })) as DescontoCheckin[];
    },
  });

  // Inicializa respostas a partir do checkin atual
  useEffect(() => {
    const criterios = criteriosQuery.data ?? [];
    const rows = checkinAtualQuery.data ?? [];
    if (!criterios.length) return;

    const next: Record<number, Resposta> = {};
    criterios.forEach((c) => {
      const row = rows.find((r) => r.codigo === c.codigo);
      next[c.id] = {
        atingido: row?.atingido ?? false,
        observacao: row?.observacao_criterio ?? "",
      };
    });
    setRespostas(next);
  }, [criteriosQuery.data, checkinAtualQuery.data]);

  const percentualPorCriterio = useMemo(() => {
    const map: Record<number, number> = {};
    (percentuaisQuery.data ?? []).forEach((p) => {
      map[p.criterio_id] = Number(p.percentual);
    });
    return map;
  }, [percentuaisQuery.data]);

  const desconto = descontoQuery.data;
  const max = Number(desconto?.desconto_total_maximo ?? 0);
  const total = Number(desconto?.desconto_total_projetado ?? 0);
  const ratio = max > 0 ? total / max : 0;
  const cardColor =
    ratio >= 1
      ? "bg-status-success/5 border-status-success/30"
      : ratio >= 0.5
        ? "bg-status-warning/5 border-status-warning/30"
        : "bg-status-error/5 border-status-error/30";
  const totalColor =
    ratio >= 1 ? "text-status-success-foreground" : ratio >= 0.5 ? "text-status-warning-foreground" : "text-status-error-foreground";

  async function salvarCheckin(tipo: "projecao" | "confirmacao_andre") {
    if (!user) {
      toast.error("Sessão expirada. Faça login novamente.");
      return;
    }
    setSaving(true);
    try {
      const hoje = new Date().toISOString().slice(0, 10);
      const avaliadoCom = tipo === "confirmacao_andre" ? "André (Sayerlack)" : null;
      const avaliadoPor = user.email ?? user.id;

      // 1. Procura checkin existente do mesmo tipo
      const { data: existentes, error: errFind } = await supabase
        .from("des_checkin_qualitativo")
        .select("id")
        .eq("empresa", empresa)
        .eq("ano", ano)
        .eq("trimestre", trimestre)
        .eq("tipo", tipo)
        .order("criado_em", { ascending: false })
        .limit(1);
      if (errFind) throw errFind;

      let checkinId: number;
      if (existentes && existentes.length > 0) {
        checkinId = existentes[0].id;
        const { error: errUpd } = await supabase
          .from("des_checkin_qualitativo")
          .update({
            data_avaliacao: hoje,
            avaliado_por: avaliadoPor,
            avaliado_com: avaliadoCom,
            atualizado_em: new Date().toISOString(),
          })
          .eq("id", checkinId);
        if (errUpd) throw errUpd;
      } else {
        const { data: novo, error: errIns } = await supabase
          .from("des_checkin_qualitativo")
          .insert({
            empresa,
            ano,
            trimestre,
            data_avaliacao: hoje,
            tipo,
            avaliado_por: avaliadoPor,
            avaliado_com: avaliadoCom,
          })
          .select("id")
          .single();
        if (errIns) throw errIns;
        checkinId = novo.id;
      }

      // 2. Apaga respostas antigas e insere novas
      const { error: errDel } = await supabase
        .from("des_checkin_qualitativo_resposta")
        .delete()
        .eq("checkin_id", checkinId);
      if (errDel) throw errDel;

      const novasRespostas = Object.entries(respostas).map(([critId, val]) => ({
        checkin_id: checkinId,
        criterio_id: Number(critId),
        atingido: val.atingido,
        observacao: val.observacao || null,
      }));

      if (novasRespostas.length) {
        const { error: errInsR } = await supabase
          .from("des_checkin_qualitativo_resposta")
          .insert(novasRespostas);
        if (errInsR) throw errInsR;
      }

      toast.success(
        tipo === "projecao"
          ? "Projeção atualizada."
          : "Confirmação com André registrada."
      );

      // Refetch
      qc.invalidateQueries({ queryKey: ["des-checkin-atual", empresa, ano, trimestre] });
      qc.invalidateQueries({ queryKey: ["des-desconto", empresa, ano, trimestre] });
      qc.invalidateQueries({ queryKey: ["des-checkin-historico", empresa, ano, trimestre] });
    } catch (err) {
      console.error(err);
      const msg = err instanceof Error ? err.message : "desconhecido";
      toast.error("Erro ao salvar checkin: " + msg);
    } finally {
      setSaving(false);
      setConfirmAndreOpen(false);
    }
  }

  const isLoading = criteriosQuery.isLoading || checkinAtualQuery.isLoading;
  const criterios = criteriosQuery.data ?? [];
  const qualitativos = criterios.filter((c) => c.tipo === "qualitativo");
  const bonusItems = criterios.filter((c) => c.tipo === "bonus");

  const setResposta = (id: number, resposta: Resposta) =>
    setRespostas((prev) => ({ ...prev, [id]: resposta }));

  return {
    respostas,
    setResposta,
    saving,
    confirmAndreOpen,
    setConfirmAndreOpen,
    percentualPorCriterio,
    desconto,
    max,
    total,
    cardColor,
    totalColor,
    salvarCheckin,
    isLoading,
    qualitativos,
    bonusItems,
    historicoLoading: historicoQuery.isLoading,
    historico: historicoQuery.data,
  };
}
