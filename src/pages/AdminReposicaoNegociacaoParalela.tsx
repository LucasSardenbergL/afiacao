import { useState, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  Handshake,
  Loader2,
  RefreshCw,
  Sparkles,
  ClipboardList,
  Search,
  Info,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { cn } from "@/lib/utils";
import { HelpDrawer } from "@/components/help/HelpDrawer";
import {
  EMPRESA,
  CATEGORIAS,
  STATUS_LIST,
  ORDENACOES,
  type StatusSugestao,
  type Categoria,
  type OrdenacaoKey,
  type Sugestao,
  type RankingRow,
  type ConvertForm,
} from "@/components/reposicao/negociacaoParalela/types";
import {
  categoriaBadgeClass,
  categoriaLabel,
  lastDayOfNextMonth,
} from "@/components/reposicao/negociacaoParalela/helpers";
import { SugestaoCard } from "@/components/reposicao/negociacaoParalela/SugestaoCard";
import { RankingTable } from "@/components/reposicao/negociacaoParalela/RankingTable";
import {
  IgnorarDialog,
  FecharSemAcordoDialog,
  ConverterDialog,
} from "@/components/reposicao/negociacaoParalela/dialogs";

export default function AdminReposicaoNegociacaoParalela() {
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
  const PAGE_SIZE = 20;

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
      const { data, error } = await supabase
        .from("mv_sku_ranking_negociacao_paralela" as never)
        .select("*")
        .eq("empresa", EMPRESA)
        .order("score_final", { ascending: false });
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

  const toggleSet = <T,>(set: Set<T>, value: T): Set<T> => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  return (
    <div className="container mx-auto py-6 space-y-6 max-w-screen-2xl">
      {/* Breadcrumb + título */}
      <div className="space-y-3">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="/admin/reposicao/oportunidades">Reposição</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>Negociação Paralela</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Handshake className="h-7 w-7 text-primary" />
            <h1 className="text-2xl font-semibold tracking-tight">Negociação Paralela</h1>
          </div>
          <HelpDrawer />
        </div>
      </div>

      {/* Card explicativo */}
      <Card className="border-status-info/30 bg-status-info/5">
        <CardContent className="flex items-start gap-3 py-4">
          <Info className="h-5 w-5 text-status-info dark:text-status-info mt-0.5 shrink-0" />
          <p className="text-sm text-foreground/90 leading-relaxed">
            O sistema analisa seu histórico de compras e identifica SKUs candidatos a negociar descontos
            flat condicionais com a Sayerlack. Sugestões são geradas automaticamente; você decide quais
            vale abordar.
          </p>
        </CardContent>
      </Card>

      {/* BLOCO 1: Sugestões ativas */}
      <section className="space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-lg font-semibold">Sugestões ativas</h2>
            <p className="text-xs text-muted-foreground">
              {sugestoesFiltradas.length} sugest{sugestoesFiltradas.length === 1 ? "ão" : "ões"}
            </p>
          </div>
          <Button onClick={handleGerarSugestoes} disabled={gerando}>
            {gerando ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4 mr-2" />
            )}
            Gerar novas sugestões
          </Button>
        </div>

        {/* Filtros */}
        <div className="flex flex-wrap items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                Status ({statusFiltro.size})
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuLabel>Filtrar por status</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {STATUS_LIST.map((st) => (
                <DropdownMenuCheckboxItem
                  key={st.value}
                  checked={statusFiltro.has(st.value)}
                  onCheckedChange={() => setStatusFiltro((prev) => toggleSet(prev, st.value))}
                  onSelect={(e) => e.preventDefault()}
                >
                  {st.label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                Categoria ({categoriaFiltro.size})
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuLabel>Filtrar por categoria</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {(["prioritario", "forte", "moderado"] as Categoria[]).map((c) => (
                <DropdownMenuCheckboxItem
                  key={c}
                  checked={categoriaFiltro.has(c)}
                  onCheckedChange={() => setCategoriaFiltro((prev) => toggleSet(prev, c))}
                  onSelect={(e) => e.preventDefault()}
                >
                  {categoriaLabel(c)}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Select value={ordenacao} onValueChange={(v) => setOrdenacao(v as OrdenacaoKey)}>
            <SelectTrigger className="w-[200px] h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ORDENACOES.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {loadingSugestoes ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            Carregando sugestões...
          </div>
        ) : sugestoesFiltradas.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12 text-center gap-3">
              <ClipboardList className="h-10 w-10 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">Nenhuma sugestão ativa no momento</p>
              <Button onClick={handleGerarSugestoes} disabled={gerando} variant="outline">
                {gerando ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4 mr-2" />
                )}
                Gerar sugestões agora
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {sugestoesFiltradas.map((s) => (
              <SugestaoCard
                key={s.id}
                s={s}
                rankingExtra={rankingMap.get(s.sku_codigo_omie)}
                onMarcarVisualizada={handleMarcarVisualizada}
                onIrAoRanking={handleIrAoRanking}
                onMarcarEmAndamento={handleMarcarEmAndamento}
                onIgnorar={(sug) => setIgnoreTarget(sug)}
                onFecharSemAcordo={(sug) => setFecharSemAcordoTarget(sug)}
                onConverter={openConvertDialog}
              />
            ))}
          </div>
        )}
      </section>

      {/* BLOCO 2: Ranking completo */}
      <section ref={rankingRef} className="space-y-4 pt-6">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-lg font-semibold">Ranking completo de candidatos</h2>
            <p className="text-xs text-muted-foreground">
              Atualizado semanalmente via cron.
              {ultimaAtualizacao && ` Última atualização: ${ultimaAtualizacao}`}
            </p>
          </div>
          <Button variant="outline" onClick={handleRefreshRanking} disabled={refreshing}>
            {refreshing ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-2" />
            )}
            Atualizar ranking agora
          </Button>
        </div>

        {/* Distribuição */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {(["prioritario", "forte", "moderado", "fraco"] as Categoria[]).map((c) => (
            <Card key={c}>
              <CardContent className="py-3">
                <div className="flex items-center justify-between gap-2">
                  <Badge variant="outline" className={cn("uppercase text-[10px]", categoriaBadgeClass(c))}>
                    {categoriaLabel(c)}
                  </Badge>
                  <span className="text-xl font-semibold">{distribuicao[c]}</span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Filtros ranking */}
        <div className="flex flex-wrap items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                Categoria ({rankingCategoriaFiltro.size})
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuLabel>Filtrar por categoria</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {CATEGORIAS.map((c) => (
                <DropdownMenuCheckboxItem
                  key={c.value}
                  checked={rankingCategoriaFiltro.has(c.value)}
                  onCheckedChange={() =>
                    setRankingCategoriaFiltro((prev) => toggleSet(prev, c.value))
                  }
                  onSelect={(e) => e.preventDefault()}
                >
                  {c.label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Select
            value={rankingComSugestao}
            onValueChange={(v) => setRankingComSugestao(v as "sim" | "nao" | "ambos")}
          >
            <SelectTrigger className="w-[180px] h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ambos">Com/sem sugestão</SelectItem>
              <SelectItem value="sim">Com sugestão ativa</SelectItem>
              <SelectItem value="nao">Sem sugestão ativa</SelectItem>
            </SelectContent>
          </Select>
          <div className="relative flex-1 min-w-[220px] max-w-md">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Buscar por SKU ou descrição..."
              value={rankingBusca}
              onChange={(e) => {
                setRankingBusca(e.target.value);
                setRankingPagina(1);
              }}
              className="pl-8 h-9"
            />
          </div>
        </div>

        {/* Tabela */}
        <RankingTable
          rows={rankingPagina_}
          loading={loadingRanking}
          paginaAtual={paginaAtual}
          pageSize={PAGE_SIZE}
          skusComSugestao={skusComSugestao}
          highlightSku={highlightSku}
          onCriarSugestao={handleCriarSugestaoDoRanking}
        />

        {/* Paginação */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <p className="text-xs text-muted-foreground">
            Mostrando {rankingFiltrado.length === 0 ? 0 : (paginaAtual - 1) * PAGE_SIZE + 1}–
            {Math.min(paginaAtual * PAGE_SIZE, rankingFiltrado.length)} de {rankingFiltrado.length} SKUs
            ranqueados
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={paginaAtual === 1}
              onClick={() => setRankingPagina((p) => Math.max(1, p - 1))}
            >
              Anterior
            </Button>
            <span className="text-xs text-muted-foreground">
              {paginaAtual} / {totalPaginas}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={paginaAtual >= totalPaginas}
              onClick={() => setRankingPagina((p) => Math.min(totalPaginas, p + 1))}
            >
              Próxima
            </Button>
          </div>
        </div>
      </section>

      {/* Dialog: ignorar */}
      <IgnorarDialog
        open={!!ignoreTarget}
        onOpenChange={(o) => !o && setIgnoreTarget(null)}
        onConfirm={handleIgnorarConfirm}
      />

      {/* Dialog: fechar sem acordo */}
      <FecharSemAcordoDialog
        open={!!fecharSemAcordoTarget}
        onOpenChange={(o) => {
          if (!o) {
            setFecharSemAcordoTarget(null);
            setFecharObs("");
          }
        }}
        obs={fecharObs}
        onObsChange={setFecharObs}
        onCancel={() => setFecharSemAcordoTarget(null)}
        onConfirm={handleFecharSemAcordoConfirm}
      />

      {/* Dialog: registrar desconto fechado (converter) */}
      <ConverterDialog
        target={convertTarget}
        form={convertForm}
        setForm={setConvertForm}
        submitting={convertSubmitting}
        onOpenChange={(o) => !o && setConvertTarget(null)}
        onCancel={() => setConvertTarget(null)}
        onConfirm={handleConverterConfirm}
      />
    </div>
  );
}
