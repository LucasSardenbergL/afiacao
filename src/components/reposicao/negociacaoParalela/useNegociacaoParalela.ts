// Camada de dados/lógica da tela de negociação paralela.
// Extraída verbatim de src/pages/AdminReposicaoNegociacaoParalela.tsx (god-component split).
// Mantém estado, queries, memos derivados e handlers; a página vira composição de UI.
import { useState, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  EMPRESA,
  type StatusSugestao,
  type Categoria,
  type OrdenacaoKey,
  type Sugestao,
  type RankingRow,
  type ConvertForm,
} from "./types";
import { lastDayOfNextMonth, toggleSet } from "./helpers";

const PAGE_SIZE = 20;

export function useNegociacaoParalela() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const rankingRef = useRef<HTMLDivElement>(null);

  // Bloco 1 filtros
  const [statusFiltro, setStatusFiltro] = useState<Set<StatusSugestao>>(
    new Set(["nova", "visualizada", "acao_tomada"]),
  );
  const [categoriaFiltro, setCategoriaFiltro] = useState<Set<Categoria>>(
    new Set(["prioritario", "forte", "moderado"]),
  );
  const [ordenacao, setOrdenacao] = useState<OrdenacaoKey>("score");

  // Bloco 2 filtros
  const [rankingCategoriaFiltro, setRankingCategoriaFiltro] = useState<Set<Categoria>>(
    new Set(["prioritario", "forte", "moderado", "fraco"]),
  );
  const [rankingComSugestao, setRankingComSugestao] = useState<"sim" | "nao" | "ambos">("ambos");
  const [rankingBusca, setRankingBusca] = useState("");
  const [rankingPagina, setRankingPagina] = useState(1);
  const [highlightSku, setHighlightSku] = useState<string | null>(null);

  // Action states
  const [gerando, setGerando] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [ignoreTarget, setIgnoreTarget] = useState<Sugestao | null>(null);
  const [fecharSemAcordoTarget, setFecharSemAcordoTarget] = useState<Sugestao | null>(null);
  const [fecharObs, setFecharObs] = useState("");
  const [convertTarget, setConvertTarget] = useState<Sugestao | null>(null);
  const [convertForm, setConvertForm] = useState<ConvertForm>({
    desconto_perc: 5,
    volume_minimo: 1000,
    volume_unidade: "reais",
    data_fim: lastDayOfNextMonth(),
    responsavel: "",
    canal: "ligacao",
    observacoes: "",
  });
  const [convertSubmitting, setConvertSubmitting] = useState(false);

  // Queries
  const { data: sugestoes = [], isLoading: loadingSugestoes } = useQuery({
    queryKey: ["negociacao-paralela-sugestoes", EMPRESA],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("v_sugestao_negociacao_ativa" as never)
        .select("*")
        .eq("empresa", EMPRESA);
      if (error) throw error;
      return (data ?? []) as unknown as Sugestao[];
    },
    staleTime: 30_000,
  });

  const { data: ranking = [], isLoading: loadingRanking } = useQuery({
    queryKey: ["negociacao-paralela-ranking", EMPRESA],
    queryFn: async () => {
      // A matview foi movida p/ schema `private` (não exposto via REST direto);
      // o ranking vem por RPC SECURITY DEFINER staff-guard, que já filtra a
      // empresa e ordena por score_final desc no servidor.
      const { data, error } = await supabase
        .rpc("get_sku_ranking_negociacao_paralela" as never, { p_empresa: EMPRESA } as never);
      if (error) throw error;
      return (data ?? []) as unknown as RankingRow[];
    },
    staleTime: 30_000,
  });

  // SKUs com sugestão ativa (qualquer status considerado "ativo" pela view)
  const skusComSugestao = useMemo(
    () => new Set(sugestoes.map((s) => s.sku_codigo_omie)),
    [sugestoes],
  );

  // Filtragem das sugestões
  const sugestoesFiltradas = useMemo(() => {
    let arr = sugestoes.filter((s) => statusFiltro.has(s.status as StatusSugestao));
    if (categoriaFiltro.size > 0) {
      arr = arr.filter((s) => !s.categoria || categoriaFiltro.has(s.categoria));
    }
    arr = [...arr].sort((a, b) => {
      switch (ordenacao) {
        case "volume":
          return Number(b.volume_financeiro_12m ?? 0) - Number(a.volume_financeiro_12m ?? 0);
        case "preco":
          return Number(b.preco_medio_unitario ?? 0) - Number(a.preco_medio_unitario ?? 0);
        case "expirando":
          return (a.dias_ate_expirar ?? 999) - (b.dias_ate_expirar ?? 999);
        case "score":
        default:
          return Number(b.score_final ?? 0) - Number(a.score_final ?? 0);
      }
    });
    return arr;
  }, [sugestoes, statusFiltro, categoriaFiltro, ordenacao]);

  // Distribuição categorias do ranking
  const distribuicao = useMemo(() => {
    const acc: Record<Categoria, number> = { prioritario: 0, forte: 0, moderado: 0, fraco: 0 };
    for (const r of ranking) {
      if (r.categoria) acc[r.categoria] = (acc[r.categoria] ?? 0) + 1;
    }
    return acc;
  }, [ranking]);

  // Filtragem ranking
  const rankingFiltrado = useMemo(() => {
    let arr = ranking.filter((r) => !r.categoria || rankingCategoriaFiltro.has(r.categoria));
    if (rankingComSugestao !== "ambos") {
      arr = arr.filter((r) => {
        const tem = skusComSugestao.has(r.sku_codigo_omie);
        return rankingComSugestao === "sim" ? tem : !tem;
      });
    }
    if (rankingBusca.trim()) {
      const q = rankingBusca.trim().toLowerCase();
      arr = arr.filter(
        (r) =>
          r.sku_codigo_omie.toLowerCase().includes(q) ||
          (r.sku_descricao ?? "").toLowerCase().includes(q),
      );
    }
    return arr;
  }, [ranking, rankingCategoriaFiltro, rankingComSugestao, rankingBusca, skusComSugestao]);

  const totalPaginas = Math.max(1, Math.ceil(rankingFiltrado.length / PAGE_SIZE));
  const paginaAtual = Math.min(rankingPagina, totalPaginas);
  const rankingPagina_ = useMemo(
    () => rankingFiltrado.slice((paginaAtual - 1) * PAGE_SIZE, paginaAtual * PAGE_SIZE),
    [rankingFiltrado, paginaAtual],
  );

  const ultimaAtualizacao = ranking[0]?.atualizado_em
    ? new Date(ranking[0].atualizado_em).toLocaleString("pt-BR")
    : null;

  // Calcular "compras 12m" e "meses" lookup do ranking para enriquecer cards
  const rankingMap = useMemo(() => {
    const m = new Map<string, RankingRow>();
    for (const r of ranking) m.set(r.sku_codigo_omie, r);
    return m;
  }, [ranking]);

  // Actions
  const handleGerarSugestoes = async () => {
    setGerando(true);
    try {
      const { data, error } = await supabase.rpc("sugerir_negociacao_paralela_hoje" as never, {
        p_empresa: EMPRESA,
        p_limite: 10,
      } as never);
      if (error) throw error;
      const arr = data as unknown as unknown[] | null;
      const count = Array.isArray(arr) ? arr.length : 0;
      toast.success(`${count} sugest${count === 1 ? "ão criada" : "ões criadas"}.`);
      queryClient.invalidateQueries({ queryKey: ["negociacao-paralela-sugestoes"] });
      queryClient.invalidateQueries({ queryKey: ["negociacao-paralela-sugestoes-count"] });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error("Erro ao gerar sugestões: " + message);
    } finally {
      setGerando(false);
    }
  };

  const handleRefreshRanking = async () => {
    setRefreshing(true);
    try {
      const { error } = await supabase.rpc("refresh_sku_ranking_negociacao" as never);
      if (error) throw error;
      toast.success("Ranking atualizado.");
      queryClient.invalidateQueries({ queryKey: ["negociacao-paralela-ranking"] });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error("Erro ao atualizar ranking: " + message);
    } finally {
      setRefreshing(false);
    }
  };

  const updateStatus = async (id: number, novoStatus: StatusSugestao, extra: Record<string, unknown> = {}) => {
    const { error } = await supabase
      .from("sugestao_negociacao_paralela")
      .update({ status: novoStatus, ...extra } as never)
      .eq("id", id);
    if (error) {
      toast.error("Erro ao atualizar status: " + error.message);
      return false;
    }
    queryClient.invalidateQueries({ queryKey: ["negociacao-paralela-sugestoes"] });
    queryClient.invalidateQueries({ queryKey: ["negociacao-paralela-sugestoes-count"] });
    return true;
  };

  const handleMarcarVisualizada = async (s: Sugestao) => {
    const ok = await updateStatus(s.id, "visualizada");
    if (ok) toast.success("Marcada como visualizada.");
  };

  const handleMarcarEmAndamento = async (s: Sugestao) => {
    const ok = await updateStatus(s.id, "acao_tomada", { data_acao: new Date().toISOString() });
    if (ok) toast.success("Marcada como em andamento.");
  };

  const handleIgnorarConfirm = async () => {
    if (!ignoreTarget) return;
    const ok = await updateStatus(ignoreTarget.id, "ignorada");
    if (ok) toast.success("Sugestão ignorada.");
    setIgnoreTarget(null);
  };

  const handleFecharSemAcordoConfirm = async () => {
    if (!fecharSemAcordoTarget) return;
    const ok = await updateStatus(fecharSemAcordoTarget.id, "fechada_sem_acordo", {
      observacoes: fecharObs || null,
      data_acao: new Date().toISOString(),
    });
    if (ok) toast.success("Negociação encerrada sem acordo.");
    setFecharSemAcordoTarget(null);
    setFecharObs("");
  };

  const handleIrAoRanking = (s: Sugestao) => {
    setHighlightSku(s.sku_codigo_omie);
    rankingRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    setTimeout(() => setHighlightSku(null), 3000);
  };

  const openConvertDialog = (s: Sugestao) => {
    setConvertTarget(s);
    setConvertForm({
      desconto_perc: 5,
      volume_minimo: Math.round(Number(s.volume_financeiro_12m ?? 0) / 12) || 1000,
      volume_unidade: "reais",
      data_fim: lastDayOfNextMonth(),
      responsavel: "",
      canal: "ligacao",
      observacoes: "",
    });
  };

  const handleConverterConfirm = async () => {
    if (!convertTarget) return;
    if (convertForm.desconto_perc < 1 || convertForm.desconto_perc > 50) {
      toast.error("Desconto deve estar entre 1 e 50%.");
      return;
    }
    if (convertForm.volume_minimo <= 0) {
      toast.error("Volume mínimo deve ser maior que zero.");
      return;
    }
    setConvertSubmitting(true);
    try {
      const { data, error } = await supabase.rpc("converter_sugestao_em_campanha_flat" as never, {
        p_sugestao_id: convertTarget.id,
        p_desconto_perc: convertForm.desconto_perc,
        p_volume_minimo: convertForm.volume_minimo,
        p_volume_unidade: convertForm.volume_unidade,
        p_data_fim: convertForm.data_fim,
        p_responsavel_nome: convertForm.responsavel || null,
        p_canal: convertForm.canal,
        p_observacoes: convertForm.observacoes || null,
      } as never);
      if (error) throw error;
      toast.success("Sugestão convertida em campanha.");
      queryClient.invalidateQueries({ queryKey: ["negociacao-paralela-sugestoes"] });
      const campanhaId = typeof data === "number" || typeof data === "string" ? data : null;
      if (campanhaId) navigate(`/admin/reposicao/promocoes/${campanhaId}`);
      else navigate(`/admin/reposicao/promocoes`);
      setConvertTarget(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error("Erro ao converter: " + message);
    } finally {
      setConvertSubmitting(false);
    }
  };

  const handleCriarSugestaoDoRanking = async (r: RankingRow) => {
    try {
      const dataGeracao = new Date().toISOString().slice(0, 10);
      const validoAte = new Date();
      validoAte.setDate(validoAte.getDate() + 14);
      const { error } = await supabase.from("sugestao_negociacao_paralela").insert({
        empresa: r.empresa,
        sku_codigo_omie: r.sku_codigo_omie,
        sku_descricao: r.sku_descricao,
        motivo: "score_alto_ciclo_semanal",
        motivo_detalhes: { criado_via: "ui_ranking", categoria_ranking: r.categoria },
        score_final: r.score_final,
        volume_financeiro_12m: r.volume_financeiro_12m,
        preco_medio_unitario: r.preco_medio_unitario,
        promocoes_12m: r.promocoes_12m,
        perc_meses_com_promo: r.perc_meses_com_promo,
        status: "nova",
        data_geracao: dataGeracao,
        valido_ate: validoAte.toISOString().slice(0, 10),
      });
      if (error) throw error;
      toast.success(`Sugestão criada para ${r.sku_codigo_omie}.`);
      queryClient.invalidateQueries({ queryKey: ["negociacao-paralela-sugestoes"] });
      queryClient.invalidateQueries({ queryKey: ["negociacao-paralela-sugestoes-count"] });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error("Erro ao criar sugestão: " + message);
    }
  };

  // Callbacks de filtro (encapsulam os updaters imutáveis para a UI presentacional)
  const toggleStatusFiltro = (v: StatusSugestao) => setStatusFiltro((prev) => toggleSet(prev, v));
  const toggleCategoriaFiltro = (v: Categoria) => setCategoriaFiltro((prev) => toggleSet(prev, v));
  const toggleRankingCategoria = (v: Categoria) =>
    setRankingCategoriaFiltro((prev) => toggleSet(prev, v));
  const onRankingBuscaChange = (v: string) => {
    setRankingBusca(v);
    setRankingPagina(1);
  };

  return {
    PAGE_SIZE,
    rankingRef,
    // Bloco 1 filtros
    statusFiltro,
    categoriaFiltro,
    ordenacao,
    setOrdenacao,
    toggleStatusFiltro,
    toggleCategoriaFiltro,
    // Bloco 2 filtros
    rankingCategoriaFiltro,
    toggleRankingCategoria,
    rankingComSugestao,
    setRankingComSugestao,
    rankingBusca,
    onRankingBuscaChange,
    rankingPagina,
    setRankingPagina,
    highlightSku,
    // Action states
    gerando,
    refreshing,
    ignoreTarget,
    setIgnoreTarget,
    fecharSemAcordoTarget,
    setFecharSemAcordoTarget,
    fecharObs,
    setFecharObs,
    convertTarget,
    setConvertTarget,
    convertForm,
    setConvertForm,
    convertSubmitting,
    // Derived
    loadingSugestoes,
    loadingRanking,
    skusComSugestao,
    sugestoesFiltradas,
    distribuicao,
    rankingFiltrado,
    totalPaginas,
    paginaAtual,
    rankingPagina_,
    ultimaAtualizacao,
    rankingMap,
    // Handlers
    handleGerarSugestoes,
    handleRefreshRanking,
    handleMarcarVisualizada,
    handleMarcarEmAndamento,
    handleIgnorarConfirm,
    handleFecharSemAcordoConfirm,
    handleIrAoRanking,
    openConvertDialog,
    handleConverterConfirm,
    handleCriarSugestaoDoRanking,
  };
}
