// Lógica da revisão de parâmetros de reposição (query paginada, aprovação, edição).
// Extraída verbatim de src/pages/AdminReposicaoRevisao.tsx (god-component split).
import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useReposicaoEmpresa } from "@/contexts/ReposicaoEmpresaContext";
import { toast } from "sonner";
import { type SkuParam, type RowWithPrice, type StatusFilterValue } from "@/lib/reposicao/sku-param";
import { PAGE_SIZE, type SkuSugeridoView } from "./types";

export function useRevisaoParametros() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const { empresa } = useReposicaoEmpresa();
  const [classes, setClasses] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState<StatusFilterValue>("pendente");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [openSku, setOpenSku] = useState<RowWithPrice | null>(null);
  const [confirmBatch, setConfirmBatch] = useState(false);
  const [batchJustificativa, setBatchJustificativa] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["sku_parametros_revisao", empresa, classes, statusFilter, search, page],
    queryFn: async () => {
      // Caso especial: SKUs aguardando habilitação de fornecedor vêm da view
      if (statusFilter === "aguardando_fornecedor") {
        let q = supabase
          .from("v_sku_parametros_sugeridos")
          .select("*", { count: "exact" })
          .eq("empresa", empresa)
          .eq("status_sugestao", "AGUARDANDO_HABILITACAO_FORNECEDOR");

        if (classes.length > 0) q = q.in("classe_consolidada", classes);
        if (search.trim()) {
          const s = search.trim();
          if (/^\d+$/.test(s)) {
            q = q.eq("sku_codigo_omie", Number(s));
          } else {
            q = q.ilike("sku_descricao", `%${s}%`);
          }
        }

        q = q.order("valor_total_90d", { ascending: false, nullsFirst: false });
        q = q.range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

        const { data: vdata, error, count } = await q;
        if (error) throw error;

        const priced: RowWithPrice[] = ((vdata ?? []) as SkuSugeridoView[]).map((v) => ({
          id: `view-${v.sku_codigo_omie}`,
          empresa: v.empresa ?? empresa,
          sku_codigo_omie: Number(v.sku_codigo_omie),
          sku_descricao: v.sku_descricao,
          fornecedor_nome: v.fornecedor_nome,
          classe_consolidada: v.classe_consolidada,
          classe_abc: v.classe_abc_proposta,
          classe_xyz: v.classe_xyz_proposta,
          demanda_media_diaria: v.demanda_media_diaria,
          demanda_desvio_padrao: v.demanda_sigma_diario,
          demanda_coef_variacao: v.coef_variacao_ordem,
          demanda_dias_com_movimento: v.dias_com_movimento,
          demanda_total_90d: null,
          valor_vendido_90d: v.valor_total_90d,
          lt_medio_dias_uteis: v.lead_time_medio,
          lt_desvio_padrao_dias: v.lead_time_desvio,
          lt_p95_dias: v.lt_p95_dias,
          lt_n_observacoes: null,
          fonte_leadtime: v.fonte_leadtime,
          estoque_minimo: v.estoque_minimo_sugerido,
          ponto_pedido: v.ponto_pedido_sugerido,
          estoque_maximo: v.estoque_maximo_sugerido,
          estoque_seguranca: null,
          z_score: v.z_aplicado,
          cobertura_alvo_dias: v.cobertura_alvo_dias,
          aplicar_no_omie: false,
          aprovado_em: null,
          aprovado_por: null,
          justificativa_aprovacao: null,
          ultima_atualizacao_calculo: v.calculado_em,
          preco_compra_real: v.preco_compra_real,
          preco_venda_medio: v.preco_venda_medio,
          fonte_preco: v.fonte_preco,
          status_sugestao: v.status_sugestao,
          fornecedor_habilitado: v.fornecedor_habilitado,
          read_only: true,
        }));

        return { rows: priced, total: count ?? 0 };
      }

      // Cold-start: candidatos a PRIMEIRA COMPRA (venda recorrente, nunca comprados). Lê de uma VIEW
      // DERIVADA dedicada (v_sku_candidatos_primeira_compra) — não toca a view-mãe money-path. A view
      // só contém candidatos, então não precisa filtrar por status. Não está nos types gerados até a
      // migration A1 + regen → cast `as never` no .from (resultado tipado por SkuSugeridoView).
      if (statusFilter === "primeira_compra") {
        let q = supabase
          .from("v_sku_candidatos_primeira_compra" as never)
          .select("*", { count: "exact" })
          .eq("empresa", empresa);

        if (classes.length > 0) q = q.in("classe_consolidada", classes);
        if (search.trim()) {
          const s = search.trim();
          if (/^\d+$/.test(s)) {
            q = q.eq("sku_codigo_omie", Number(s));
          } else {
            q = q.ilike("sku_descricao", `%${s}%`);
          }
        }

        q = q.order("valor_total_180d", { ascending: false, nullsFirst: false });
        q = q.range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

        const { data: vdata, error, count } = await q;
        if (error) throw error;

        const priced: RowWithPrice[] = ((vdata ?? []) as SkuSugeridoView[]).map((v) => ({
          id: `pc-${v.sku_codigo_omie}`,
          empresa: v.empresa ?? empresa,
          sku_codigo_omie: Number(v.sku_codigo_omie),
          sku_descricao: v.sku_descricao,
          fornecedor_nome: v.fornecedor_nome,
          classe_consolidada: v.classe_consolidada,
          classe_abc: v.classe_abc_proposta,
          classe_xyz: v.classe_xyz_proposta,
          demanda_media_diaria: v.demanda_media_diaria,
          demanda_desvio_padrao: v.demanda_sigma_diario,
          demanda_coef_variacao: v.coef_variacao_ordem,
          demanda_dias_com_movimento: v.dias_com_movimento,
          demanda_total_90d: null,
          valor_vendido_90d: v.valor_total_90d,
          lt_medio_dias_uteis: v.lead_time_medio,
          lt_desvio_padrao_dias: v.lead_time_desvio,
          lt_p95_dias: v.lt_p95_dias,
          lt_n_observacoes: null,
          fonte_leadtime: v.fonte_leadtime,
          estoque_minimo: null,
          ponto_pedido: v.primeira_compra_ponto_pedido ?? null,
          estoque_maximo: v.primeira_compra_estoque_maximo ?? null,
          estoque_seguranca: null,
          z_score: v.z_aplicado,
          cobertura_alvo_dias: v.primeira_compra_cap_dias ?? null,
          aplicar_no_omie: false,
          aprovado_em: null,
          aprovado_por: null,
          justificativa_aprovacao: null,
          ultima_atualizacao_calculo: v.calculado_em,
          preco_compra_real: v.preco_compra_real,
          preco_venda_medio: v.preco_venda_medio,
          fonte_preco: v.fonte_preco,
          status_sugestao: v.status_sugestao,
          fornecedor_habilitado: v.fornecedor_habilitado,
          read_only: true,
          primeira_compra_qtde: v.primeira_compra_qtde ?? null,
          recorrencia_meses_180d: v.recorrencia_meses_180d ?? null,
          recorrencia_nfs_180d: v.recorrencia_nfs_180d ?? null,
          recorrencia_clientes_180d: v.recorrencia_clientes_180d ?? null,
          dias_desde_ultima_venda: v.dias_desde_ultima_venda ?? null,
          ja_habilitado: v.ja_habilitado ?? null,
        }));

        return { rows: priced, total: count ?? 0 };
      }

      let q = supabase
        .from("sku_parametros")
        .select("*", { count: "exact" })
        .eq("empresa", empresa)
        .eq("ativo", true)
        .not("estoque_minimo", "is", null);

      if (classes.length > 0) q = q.in("classe_consolidada", classes);
      if (statusFilter === "pendente") q = q.is("aprovado_em", null);
      if (statusFilter === "aprovado") q = q.not("aprovado_em", "is", null);
      if (search.trim()) {
        const s = search.trim();
        if (/^\d+$/.test(s)) {
          q = q.eq("sku_codigo_omie", Number(s));
        } else {
          q = q.ilike("sku_descricao", `%${s}%`);
        }
      }

      q = q.order("valor_vendido_90d", { ascending: false, nullsFirst: false });
      q = q.range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

      const { data, error, count } = await q;
      if (error) throw error;

      const baseRows = (data ?? []) as SkuParam[];

      // Buscar preços/fonte da view para todos os SKUs da página em uma chamada
      let priced: RowWithPrice[] = baseRows.map((r) => ({
        ...r,
        preco_compra_real: null,
        preco_venda_medio: null,
        fonte_preco: null,
      }));

      if (baseRows.length > 0) {
        const codes = baseRows.map((r) => r.sku_codigo_omie);
        const { data: vrows } = await supabase
          .from("v_sku_parametros_sugeridos")
          .select("sku_codigo_omie, preco_compra_real, preco_venda_medio, fonte_preco, fornecedor_habilitado, status_sugestao")
          .eq("empresa", empresa)
          .in("sku_codigo_omie", codes);

        type SkuPriceRow = Pick<
          SkuSugeridoView,
          "sku_codigo_omie" | "preco_compra_real" | "preco_venda_medio" | "fonte_preco" | "fornecedor_habilitado" | "status_sugestao"
        >;
        const map = new Map<number, SkuPriceRow>();
        ((vrows ?? []) as SkuPriceRow[]).forEach((row) => map.set(Number(row.sku_codigo_omie), row));
        priced = baseRows.map((r) => {
          const v = map.get(Number(r.sku_codigo_omie));
          return {
            ...r,
            preco_compra_real: v?.preco_compra_real ?? null,
            preco_venda_medio: v?.preco_venda_medio ?? null,
            fonte_preco: v?.fonte_preco ?? null,
            status_sugestao: v?.status_sugestao ?? null,
            fornecedor_habilitado: v?.fornecedor_habilitado ?? null,
            read_only: false,
          };
        });
      }

      return { rows: priced, total: count ?? 0 };
    },
  });

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const selectedIds = useMemo(() => Object.keys(selected).filter((k) => selected[k]), [selected]);
  const selectedRows = useMemo(() => rows.filter((r) => selected[r.id]), [rows, selected]);

  const aggregateImpact = useMemo(() => {
    const cap = selectedRows.reduce((acc, r) => acc + (r.estoque_maximo ?? 0) * 1, 0);
    return { count: selectedRows.length, capUnits: cap };
  }, [selectedRows]);

  const approveMutation = useMutation({
    mutationFn: async (payload: { ids: string[]; justificativa?: string }) => {
      const { error } = await supabase
        .from("sku_parametros")
        .update({
          aplicar_no_omie: true,
          aprovado_em: new Date().toISOString(),
          aprovado_por: user?.email ?? "desconhecido",
          justificativa_aprovacao: payload.justificativa || null,
        })
        .in("id", payload.ids);
      if (error) throw error;
    },
    onSuccess: (_d, vars) => {
      toast.success(`${vars.ids.length} SKU(s) aprovado(s)`);
      setSelected({});
      setConfirmBatch(false);
      setBatchJustificativa("");
      setOpenSku(null);
      queryClient.invalidateQueries({ queryKey: ["sku_parametros_revisao"] });
    },
    onError: (e: Error) => toast.error("Falha ao aprovar: " + e.message),
  });

  const updateMutation = useMutation({
    mutationFn: async (payload: { id: string; values: Partial<SkuParam> }) => {
      const { error } = await supabase
        .from("sku_parametros")
        .update(payload.values)
        .eq("id", payload.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Valores atualizados");
      queryClient.invalidateQueries({ queryKey: ["sku_parametros_revisao"] });
    },
    onError: (e: Error) => toast.error("Falha ao atualizar: " + e.message),
  });

  // Promove um candidato a primeira compra: preenche os parâmetros capados em sku_parametros e habilita
  // a reposição → o item entra no fluxo NORMAL (motor sugere → aprovação do pedido → disparo).
  // RPC `as never`: ainda não está nos types gerados do Supabase (vem só após a migration A2 + regen).
  const promoverMutation = useMutation({
    mutationFn: async (sku: number) => {
      const { data, error } = await supabase.rpc(
        "promover_candidato_primeira_compra" as never,
        { p_empresa: empresa, p_sku: sku } as never,
      );
      if (error) throw error;
      return (data as number) ?? 0;
    },
    onSuccess: (n) => {
      if (n && n > 0) toast.success("SKU promovido — entra na próxima sugestão de compra");
      else toast.info("Nada a promover (já promovido ou não é mais candidato)");
      queryClient.invalidateQueries({ queryKey: ["sku_parametros_revisao"] });
    },
    onError: (e: Error) => toast.error("Falha ao promover: " + e.message),
  });

  const toggleClasse = (c: string) => {
    setPage(0);
    setClasses((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));
  };

  const selectableRows = useMemo(() => rows.filter((r) => !r.read_only), [rows]);
  const allChecked = selectableRows.length > 0 && selectableRows.every((r) => selected[r.id]);
  const toggleAll = () => {
    if (allChecked) {
      const next = { ...selected };
      selectableRows.forEach((r) => delete next[r.id]);
      setSelected(next);
    } else {
      const next = { ...selected };
      selectableRows.forEach((r) => (next[r.id] = true));
      setSelected(next);
    }
  };

  // Handlers compostos (encapsulam os resets de página/seleção inline do JSX original)
  const onStatusChange = (v: StatusFilterValue) => {
    setPage(0);
    setStatusFilter(v);
    setSelected({});
  };
  const onSearchChange = (v: string) => {
    setPage(0);
    setSearch(v);
  };
  const clearClasses = () => setClasses([]);
  const onToggleSelect = (id: string, checked: boolean) =>
    setSelected((s) => ({ ...s, [id]: checked }));
  const prevPage = () => setPage((p) => Math.max(0, p - 1));
  const nextPage = () => setPage((p) => p + 1);

  return {
    empresa,
    classes,
    statusFilter,
    search,
    page,
    selected,
    openSku,
    setOpenSku,
    confirmBatch,
    setConfirmBatch,
    batchJustificativa,
    setBatchJustificativa,
    isLoading,
    rows,
    total,
    totalPages,
    selectedIds,
    selectedRows,
    aggregateImpact,
    allChecked,
    toggleAll,
    toggleClasse,
    clearClasses,
    onStatusChange,
    onSearchChange,
    onToggleSelect,
    prevPage,
    nextPage,
    approveMutation,
    updateMutation,
    promoverMutation,
  };
}
