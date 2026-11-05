// Lógica do check-in qualitativo DES (queries, respostas, salvar projeção/confirmação).
// Extraída verbatim de src/components/des/CheckinQualitativoTab.tsx (god-component split).
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { hojeSP } from "@/lib/time/sp-day";
import {
  type Props,
  type Criterio,
  type CriterioPercentual,
  type LinhaHistoricoCheckin,
  type Resposta,
} from "./types";
import { coresDoDesconto, numeroOuNulo } from "./format";
import { derivarPosicaoAoVivo } from "../posicao-ao-vivo";
import { exigirColunas, linhasCom } from "@/lib/linha-view";

/** Colunas sem as quais uma linha da `v_des_desconto_por_checkin` não faz sentido (ver `DescontoCheckin`). */
const CHAVE_DESCONTO = ["checkin_id", "data_avaliacao", "tipo"] as const;

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
        .from("v_des_posicao_trimestre_ao_vivo")
        .select("fat_bruto_confirmado, posicao_ao_vivo_conservadora, faixa_conservadora, faixa_otimista")
        .eq("empresa", empresa)
        .eq("ano", ano)
        .eq("trimestre", trimestre)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  // Percentuais por critério para a faixa atual. Sem faturado confirmado do GoodData a faixa é
  // desconhecida (ausente ≠ zero) — vale também com a view antiga, que a tirava só do trânsito.
  const posicao = useMemo(() => derivarPosicaoAoVivo(posicaoQuery.data), [posicaoQuery.data]);
  const faixaConservId = posicao.faixaConservadoraId;

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
        .from("v_des_checkin_atual")
        .select("*")
        .eq("empresa", empresa)
        .eq("ano", ano)
        .eq("trimestre", trimestre);
      if (error) throw error;
      return (data ?? []);
    },
  });

  // Desconto projetado para o checkin atual
  const descontoQuery = useQuery({
    queryKey: ["des-desconto", empresa, ano, trimestre],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("v_des_desconto_por_checkin")
        .select("*")
        .eq("empresa", empresa)
        .eq("ano", ano)
        .eq("trimestre", trimestre)
        .order("data_avaliacao", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      exigirColunas(data, CHAVE_DESCONTO, "v_des_desconto_por_checkin");
      return data;
    },
  });

  // Histórico de checkins do trimestre. A LISTA vem de des_checkin_qualitativo: o check-in existe
  // mesmo sem faixa, e a v_des_desconto_por_checkin só traz quem tem faixa (sem faturado confirmado,
  // ninguém) — ler a lista dela diria "nenhum checkin registrado" com check-in salvo. Os percentuais
  // vêm da view, casados por checkin_id; sem linha nela, ficam null ("—").
  const historicoQuery = useQuery({
    queryKey: ["des-checkin-historico", empresa, ano, trimestre],
    queryFn: async (): Promise<LinhaHistoricoCheckin[]> => {
      const { data: checkins, error } = await supabase
        .from("des_checkin_qualitativo")
        .select("id, data_avaliacao, tipo, avaliado_por")
        .eq("empresa", empresa)
        .eq("ano", ano)
        .eq("trimestre", trimestre)
        .order("data_avaliacao", { ascending: false });
      if (error) throw error;
      const { data: descontos, error: erroDesconto } = await supabase
        .from("v_des_desconto_por_checkin")
        .select("*")
        .eq("empresa", empresa)
        .eq("ano", ano)
        .eq("trimestre", trimestre);
      if (erroDesconto) throw erroDesconto;
      const porCheckin = new Map(
        linhasCom(descontos, CHAVE_DESCONTO, "v_des_desconto_por_checkin").map((d) => [d.checkin_id, d]),
      );
      return (checkins ?? []).map((c) => {
        const d = porCheckin.get(c.id);
        return {
          checkin_id: c.id,
          data_avaliacao: c.data_avaliacao,
          tipo: c.tipo,
          avaliado_por: c.avaliado_por,
          qualitativos_atingidos_perc: numeroOuNulo(d?.qualitativos_atingidos_perc),
          desconto_total_projetado: numeroOuNulo(d?.desconto_total_projetado),
        };
      });
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

  // Com a view antiga, a linha de desconto existe mesmo sem faturado (faixa tirada do trânsito).
  const desconto = posicao.conhecida ? descontoQuery.data : null;
  // Idem para os check-ins anteriores: sem posição confirmada, os percentuais da view antiga saíam da
  // faixa tirada do trânsito. O check-in continua listado; só os percentuais viram "—".
  const historico = useMemo(
    () =>
      posicao.conhecida
        ? historicoQuery.data
        : historicoQuery.data?.map((h) => ({ ...h, qualitativos_atingidos_perc: null, desconto_total_projetado: null })),
    [posicao.conhecida, historicoQuery.data],
  );
  // Ausente ≠ zero: sem check-in no trimestre (ou faixa sem percentual) o máximo e o projetado são
  // null — a tela mostra "—" com o card neutro, em vez de "0,00%" em vermelho.
  const max = numeroOuNulo(desconto?.desconto_total_maximo);
  const total = numeroOuNulo(desconto?.desconto_total_projetado);
  const { cardColor, totalColor } = coresDoDesconto(total, max);

  async function salvarCheckin(tipo: "projecao" | "confirmacao_andre") {
    if (!user) {
      toast.error("Sessão expirada. Faça login novamente.");
      return;
    }
    setSaving(true);
    try {
      const hoje = hojeSP(); // data_avaliacao é o dia de SP (às 22h o UTC já é amanhã)
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
    historico,
    historicoErro: historicoQuery.isError,
  };
}
