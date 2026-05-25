// Hook de dados/estado do SLA de fornecedor.
// Extraído verbatim de src/pages/AdminReposicaoSlaFornecedor.tsx (god-component split):
// 3 queries (compliance por fornecedor/SKU + histórico) + memos + exportCsv + toggleStatus.
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useReposicaoEmpresa } from "@/contexts/ReposicaoEmpresaContext";
import { STATUS_RANK } from "./config";
import type { ForCompliance, SkuCompliance, SlaStatus } from "./types";

export function useSlaFornecedor() {
  const { empresa } = useReposicaoEmpresa();
  const [filtroFornecedor, setFiltroFornecedor] = useState<string>("__all__");
  const [filtroStatus, setFiltroStatus] = useState<SlaStatus[]>([
    "cumprindo",
    "limite",
    "violando",
    "critico",
  ]);
  const [filtroTendencia, setFiltroTendencia] = useState<string>("__all__");
  const [filtroGrupo, setFiltroGrupo] = useState<string>("__all__");
  const [busca, setBusca] = useState("");
  const [skuDetalhe, setSkuDetalhe] = useState<SkuCompliance | null>(null);

  // Compliance por fornecedor
  const { data: fornecedores, isLoading: loadingFor } = useQuery({
    queryKey: ["sla-fornecedor", empresa],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("v_fornecedor_sla_compliance")
        .select("*")
        .eq("empresa", empresa)
        .order("perc_sla_compliance", { ascending: true, nullsFirst: false });
      if (error) throw error;
      return (data ?? []) as ForCompliance[];
    },
  });

  // Compliance por SKU
  const { data: skus, isLoading: loadingSkus } = useQuery({
    queryKey: ["sla-sku", empresa],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("v_sku_sla_compliance")
        .select("*")
        .eq("empresa", empresa)
        .limit(5000);
      if (error) throw error;
      return (data ?? []) as unknown as SkuCompliance[];
    },
  });

  // Histórico do SKU selecionado
  const { data: historico, isLoading: loadingHist } = useQuery({
    enabled: !!skuDetalhe,
    queryKey: ["sla-hist", skuDetalhe?.sku_codigo_omie],
    queryFn: async () => {
      if (!skuDetalhe) return [];
      const { data, error } = await supabase
        .from("sku_leadtime_history")
        .select("t4_data_recebimento, lt_bruto_dias_uteis, lt_faturamento_dias_uteis, lt_logistica_dias_uteis")
        .eq("sku_codigo_omie", Number(skuDetalhe.sku_codigo_omie))
        .not("lt_bruto_dias_uteis", "is", null)
        .order("t4_data_recebimento", { ascending: false })
        .limit(15);
      if (error) throw error;
      type HistRow = {
        t4_data_recebimento: string | null;
        lt_bruto_dias_uteis: number | string | null;
        lt_faturamento_dias_uteis: number | string | null;
        lt_logistica_dias_uteis: number | string | null;
      };
      return ((data ?? []) as HistRow[])
        .reverse()
        .map((r) => ({
          data: r.t4_data_recebimento
            ? new Date(r.t4_data_recebimento).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })
            : "",
          lt: r.lt_bruto_dias_uteis != null ? Number(r.lt_bruto_dias_uteis) : null,
          faturamento: r.lt_faturamento_dias_uteis != null ? Number(r.lt_faturamento_dias_uteis) : null,
          logistica: r.lt_logistica_dias_uteis != null ? Number(r.lt_logistica_dias_uteis) : null,
        }));
    },
  });

  const grupos = useMemo(
    () => Array.from(new Set((skus ?? []).map((s) => s.grupo_codigo).filter(Boolean))).sort() as string[],
    [skus],
  );

  const skusFiltrados = useMemo(() => {
    const q = busca.trim().toLowerCase();
    return (skus ?? [])
      .filter((s) => filtroStatus.includes(s.status_sla))
      .filter((s) => filtroFornecedor === "__all__" || s.fornecedor_nome === filtroFornecedor)
      .filter((s) => filtroTendencia === "__all__" || s.tendencia === filtroTendencia)
      .filter((s) => filtroGrupo === "__all__" || s.grupo_codigo === filtroGrupo)
      .filter(
        (s) =>
          !q ||
          s.sku_codigo_omie.toLowerCase().includes(q) ||
          (s.sku_descricao ?? "").toLowerCase().includes(q),
      )
      .sort((a, b) => {
        const r = STATUS_RANK[a.status_sla] - STATUS_RANK[b.status_sla];
        if (r !== 0) return r;
        return (b.desvio_perc ?? -Infinity) - (a.desvio_perc ?? -Infinity);
      });
  }, [skus, filtroStatus, filtroFornecedor, filtroTendencia, filtroGrupo, busca]);

  const fornecedoresOptions = useMemo(
    () => Array.from(new Set((skus ?? []).map((s) => s.fornecedor_nome).filter(Boolean))).sort() as string[],
    [skus],
  );

  const exportCsv = () => {
    if (!fornecedores?.length) return;
    const head = [
      "fornecedor",
      "skus_total",
      "perc_sla_compliance",
      "skus_cumprindo",
      "skus_limite",
      "skus_violando",
      "skus_criticos",
      "lt_teorico_agregado",
      "lt_medio_observado_agregado",
    ];
    const rows = fornecedores.map((f) =>
      [
        `"${f.fornecedor_nome.replace(/"/g, '""')}"`,
        f.skus_total,
        f.perc_sla_compliance ?? "",
        f.skus_cumprindo,
        f.skus_limite,
        f.skus_violando,
        f.skus_criticos,
        f.lt_teorico_agregado ?? "",
        f.lt_medio_observado_agregado ?? "",
      ].join(","),
    );
    const blob = new Blob([head.join(",") + "\n" + rows.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sla-fornecedor-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const toggleStatus = (s: SlaStatus) => {
    setFiltroStatus((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  };

  return {
    fornecedores,
    loadingFor,
    loadingSkus,
    skusFiltrados,
    historico,
    loadingHist,
    grupos,
    fornecedoresOptions,
    filtroFornecedor,
    setFiltroFornecedor,
    filtroTendencia,
    setFiltroTendencia,
    filtroGrupo,
    setFiltroGrupo,
    busca,
    setBusca,
    filtroStatus,
    toggleStatus,
    skuDetalhe,
    setSkuDetalhe,
    exportCsv,
  };
}
