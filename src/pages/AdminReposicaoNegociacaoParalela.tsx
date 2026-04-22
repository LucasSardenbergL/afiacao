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
  Eye,
  MoreVertical,
  Search,
  Info,
  TrendingUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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

const EMPRESA = "OBEN";

type StatusSugestao = "nova" | "visualizada" | "acao_tomada" | "ignorada" | "fechada_sem_acordo" | "convertida";
type Categoria = "prioritario" | "forte" | "moderado" | "fraco";

interface Sugestao {
  id: number;
  empresa: string;
  sku_codigo_omie: string;
  sku_descricao: string | null;
  motivo: string | null;
  motivo_detalhes: any;
  score_final: number | null;
  volume_financeiro_12m: number | null;
  preco_medio_unitario: number | null;
  promocoes_12m: number | null;
  perc_meses_com_promo: number | null;
  status: StatusSugestao;
  data_geracao: string | null;
  valido_ate: string | null;
  dias_ate_expirar: number | null;
  campanha_id_gerada: number | null;
  categoria: Categoria | null;
  fornecedor_nome: string | null;
  ponto_pedido: number | null;
  estoque_maximo: number | null;
  estoque_efetivo: number | null;
}

interface RankingRow {
  empresa: string;
  sku_codigo_omie: string;
  sku_descricao: string | null;
  fornecedor_nome: string | null;
  volume_financeiro_12m: number | null;
  num_compras_12m: number | null;
  meses_com_compra: number | null;
  preco_medio_unitario: number | null;
  coef_variacao: number | null;
  ultima_compra: string | null;
  promocoes_12m: number | null;
  perc_meses_com_promo: number | null;
  score_volume: number | null;
  score_consistencia: number | null;
  score_preco: number | null;
  score_ausencia_promo: number | null;
  score_final: number | null;
  categoria: Categoria | null;
  atualizado_em: string | null;
}

const CATEGORIAS: Array<{ value: Categoria; label: string }> = [
  { value: "prioritario", label: "Prioritário" },
  { value: "forte", label: "Forte" },
  { value: "moderado", label: "Moderado" },
  { value: "fraco", label: "Fraco" },
];

const STATUS_LIST: Array<{ value: StatusSugestao; label: string }> = [
  { value: "nova", label: "Nova" },
  { value: "visualizada", label: "Visualizada" },
  { value: "acao_tomada", label: "Em andamento" },
];

function formatBRL(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(v));
}

function formatPerc(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined) return "—";
  return `${Number(v).toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;
}

function formatDateBR(d: string | null | undefined): string {
  if (!d) return "—";
  const date = new Date(d);
  return date.toLocaleDateString("pt-BR");
}

function categoriaBadgeClass(cat: Categoria | null | undefined): string {
  switch (cat) {
    case "prioritario":
      return "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30";
    case "forte":
      return "bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30";
    case "moderado":
      return "bg-muted text-muted-foreground border-border";
    case "fraco":
      return "bg-muted/50 text-muted-foreground border-border";
    default:
      return "bg-muted text-muted-foreground border-border";
  }
}

function categoriaLabel(cat: Categoria | null | undefined): string {
  return CATEGORIAS.find((c) => c.value === cat)?.label ?? "—";
}

function statusBadgeClass(status: StatusSugestao): string {
  switch (status) {
    case "nova":
      return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30";
    case "visualizada":
      return "bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30";
    case "acao_tomada":
      return "bg-orange-500/15 text-orange-700 dark:text-orange-400 border-orange-500/30";
    default:
      return "bg-muted text-muted-foreground border-border";
  }
}

function statusLabel(status: StatusSugestao): string {
  switch (status) {
    case "nova":
      return "Nova";
    case "visualizada":
      return "Visualizada";
    case "acao_tomada":
      return "Em andamento";
    case "ignorada":
      return "Ignorada";
    case "fechada_sem_acordo":
      return "Fechada sem acordo";
    case "convertida":
      return "Convertida";
    default:
      return status;
  }
}

function percPromoBadgeClass(p: number | null | undefined): string {
  const v = Number(p ?? 0);
  if (v === 0) return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30";
  if (v <= 30) return "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30";
  return "bg-destructive/15 text-destructive border-destructive/30";
}

type OrdenacaoKey = "score" | "volume" | "preco" | "expirando";

const ORDENACOES: Array<{ value: OrdenacaoKey; label: string }> = [
  { value: "score", label: "Maior score" },
  { value: "volume", label: "Maior volume" },
  { value: "preco", label: "Maior preço unitário" },
  { value: "expirando", label: "Expirando primeiro" },
];

function lastDayOfNextMonth(): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() + 2, 0);
  return d.toISOString().slice(0, 10);
}

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
  const [convertForm, setConvertForm] = useState({
    desconto_perc: 5,
    volume_minimo: 1000,
    volume_unidade: "reais" as "unidades" | "reais" | "kg" | "litros",
    data_fim: lastDayOfNextMonth(),
    responsavel: "",
    canal: "ligacao" as "email" | "whatsapp" | "ligacao" | "visita_presencial" | "outro",
    observacoes: "",
  });
  const [convertSubmitting, setConvertSubmitting] = useState(false);

  // Queries
  const { data: sugestoes = [], isLoading: loadingSugestoes } = useQuery({
    queryKey: ["negociacao-paralela-sugestoes", EMPRESA],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("v_sugestao_negociacao_ativa" as any)
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
        .from("mv_sku_ranking_negociacao_paralela" as any)
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

  // Faltam para próxima faixa não se aplica aqui (era no DES). Removido.

  // Actions
  const handleGerarSugestoes = async () => {
    setGerando(true);
    try {
      const { data, error } = await supabase.rpc("sugerir_negociacao_paralela_hoje" as any, {
        p_empresa: EMPRESA,
        p_limite: 10,
      });
      if (error) throw error;
      const count = Array.isArray(data) ? data.length : 0;
      toast.success(`${count} sugest${count === 1 ? "ão criada" : "ões criadas"}.`);
      queryClient.invalidateQueries({ queryKey: ["negociacao-paralela-sugestoes"] });
      queryClient.invalidateQueries({ queryKey: ["negociacao-paralela-sugestoes-count"] });
    } catch (err: any) {
      toast.error("Erro ao gerar sugestões: " + (err?.message ?? "desconhecido"));
    } finally {
      setGerando(false);
    }
  };

  const handleRefreshRanking = async () => {
    setRefreshing(true);
    try {
      const { error } = await supabase.rpc("refresh_sku_ranking_negociacao" as any);
      if (error) throw error;
      toast.success("Ranking atualizado.");
      queryClient.invalidateQueries({ queryKey: ["negociacao-paralela-ranking"] });
    } catch (err: any) {
      toast.error("Erro ao atualizar ranking: " + (err?.message ?? "desconhecido"));
    } finally {
      setRefreshing(false);
    }
  };

  const updateStatus = async (id: number, novoStatus: StatusSugestao, extra: Record<string, any> = {}) => {
    const { error } = await supabase
      .from("sugestao_negociacao_paralela" as any)
      .update({ status: novoStatus, ...extra })
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
      const { data, error } = await supabase.rpc("converter_sugestao_em_campanha_flat" as any, {
        p_sugestao_id: convertTarget.id,
        p_desconto_perc: convertForm.desconto_perc,
        p_volume_minimo: convertForm.volume_minimo,
        p_volume_unidade: convertForm.volume_unidade,
        p_data_fim: convertForm.data_fim,
        p_responsavel_nome: convertForm.responsavel || null,
        p_canal: convertForm.canal,
        p_observacoes: convertForm.observacoes || null,
      });
      if (error) throw error;
      toast.success("Sugestão convertida em campanha.");
      queryClient.invalidateQueries({ queryKey: ["negociacao-paralela-sugestoes"] });
      const campanhaId = typeof data === "number" || typeof data === "string" ? data : null;
      if (campanhaId) navigate(`/admin/reposicao/promocoes/${campanhaId}`);
      else navigate(`/admin/reposicao/promocoes`);
      setConvertTarget(null);
    } catch (err: any) {
      toast.error("Erro ao converter: " + (err?.message ?? "desconhecido"));
    } finally {
      setConvertSubmitting(false);
    }
  };

  const handleCriarSugestaoDoRanking = async (r: RankingRow) => {
    try {
      const dataGeracao = new Date().toISOString().slice(0, 10);
      const validoAte = new Date();
      validoAte.setDate(validoAte.getDate() + 14);
      const { error } = await supabase.from("sugestao_negociacao_paralela" as any).insert({
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
    } catch (err: any) {
      toast.error("Erro ao criar sugestão: " + (err?.message ?? "desconhecido"));
    }
  };

  const toggleSet = <T,>(set: Set<T>, value: T): Set<T> => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  // Render helpers
  const renderSugestaoCard = (s: Sugestao) => {
    const rankingExtra = rankingMap.get(s.sku_codigo_omie);
    const numCompras = rankingExtra?.num_compras_12m ?? null;
    const mesesCompra = rankingExtra?.meses_com_compra ?? null;
    const score = Number(s.score_final ?? 0);
    return (
      <Card key={s.id} className="flex flex-col">
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-2">
            {s.categoria && s.categoria !== "fraco" ? (
              <Badge variant="outline" className={cn("uppercase text-[10px] tracking-wide", categoriaBadgeClass(s.categoria))}>
                {categoriaLabel(s.categoria)}
              </Badge>
            ) : <span />}
            <Badge variant="outline" className={cn("text-[10px]", statusBadgeClass(s.status))}>
              {statusLabel(s.status)}
            </Badge>
          </div>
          <CardTitle className="text-base leading-snug mt-2 break-words">
            {s.sku_descricao ?? "Sem descrição"}
          </CardTitle>
          <p className="text-xs font-mono text-muted-foreground">{s.sku_codigo_omie}</p>
        </CardHeader>
        <CardContent className="flex-1 flex flex-col gap-4 pt-0">
          <div>
            <div className="flex items-center justify-between text-xs mb-1.5">
              <span className="font-medium">Score</span>
              <span className="font-semibold">{score.toFixed(1)}</span>
            </div>
            <Progress value={score} className="h-2" />
          </div>

          {s.motivo && (
            <p className="text-sm text-muted-foreground leading-relaxed">
              {(s.motivo_detalhes && (s.motivo_detalhes as any).motivo_legivel) || s.motivo}
            </p>
          )}

          <div className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <p className="text-muted-foreground">Volume 12m</p>
              <p className="font-semibold">{formatBRL(s.volume_financeiro_12m)}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Preço médio</p>
              <p className="font-semibold">{formatBRL(s.preco_medio_unitario)}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Compras 12m</p>
              <p className="font-semibold">
                {numCompras ?? "—"}
                {mesesCompra !== null && (
                  <span className="text-muted-foreground font-normal"> em {mesesCompra} meses</span>
                )}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground">% meses com promo</p>
              <p className="font-semibold">{formatPerc(s.perc_meses_com_promo)}</p>
            </div>
          </div>

          <div className="flex items-center justify-between text-xs px-3 py-2 bg-muted/40 rounded-md border border-border">
            <span className="text-muted-foreground">
              Estoque: <span className="font-semibold text-foreground">{s.estoque_efetivo ?? 0}</span>
            </span>
            <span className="text-muted-foreground">
              PP: <span className="font-semibold text-foreground">{s.ponto_pedido ?? "—"}</span>
            </span>
          </div>

          <p className="text-xs text-muted-foreground">
            Expira em {s.dias_ate_expirar ?? "—"} dia{(s.dias_ate_expirar ?? 0) === 1 ? "" : "s"}
          </p>

          <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-border">
            <Button
              variant="outline"
              size="sm"
              disabled={s.status !== "nova"}
              onClick={() => handleMarcarVisualizada(s)}
            >
              <Eye className="h-3.5 w-3.5 mr-1.5" />
              Marcar visualizada
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  <MoreVertical className="h-3.5 w-3.5 mr-1.5" />
                  Ações
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => handleIrAoRanking(s)}>Ir ao ranking</DropdownMenuItem>
                <DropdownMenuItem onClick={() => handleMarcarEmAndamento(s)}>
                  Marcar como em andamento
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setIgnoreTarget(s)}>Ignorar</DropdownMenuItem>
                <DropdownMenuItem onClick={() => setFecharSemAcordoTarget(s)}>
                  Fechar sem acordo
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              size="sm"
              className="ml-auto bg-emerald-600 hover:bg-emerald-700 text-white"
              onClick={() => openConvertDialog(s)}
            >
              <Handshake className="h-3.5 w-3.5 mr-1.5" />
              Registrar desconto fechado
            </Button>
          </div>
        </CardContent>
      </Card>
    );
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
      <Card className="border-blue-500/30 bg-blue-500/5">
        <CardContent className="flex items-start gap-3 py-4">
          <Info className="h-5 w-5 text-blue-600 dark:text-blue-400 mt-0.5 shrink-0" />
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
            {sugestoesFiltradas.map(renderSugestaoCard)}
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
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">#</TableHead>
                  <TableHead className="w-[35%] min-w-[280px]">SKU</TableHead>
                  <TableHead>Volume 12m</TableHead>
                  <TableHead>Compras</TableHead>
                  <TableHead>Preço médio</TableHead>
                  <TableHead>% meses promo</TableHead>
                  <TableHead className="w-[180px]">Score</TableHead>
                  <TableHead>Categoria</TableHead>
                  <TableHead>Ação</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loadingRanking ? (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center py-10 text-muted-foreground">
                      <Loader2 className="h-5 w-5 animate-spin inline mr-2" />
                      Carregando ranking...
                    </TableCell>
                  </TableRow>
                ) : rankingPagina_.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center py-10 text-muted-foreground">
                      Nenhum SKU encontrado.
                    </TableCell>
                  </TableRow>
                ) : (
                  rankingPagina_.map((r, idx) => {
                    const posicao = (paginaAtual - 1) * PAGE_SIZE + idx + 1;
                    const temSugestao = skusComSugestao.has(r.sku_codigo_omie);
                    const isHighlight = highlightSku === r.sku_codigo_omie;
                    const score = Number(r.score_final ?? 0);
                    return (
                      <TableRow
                        key={r.sku_codigo_omie}
                        className={cn(isHighlight && "bg-primary/10 transition-colors")}
                      >
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {posicao}
                        </TableCell>
                        <TableCell>
                          <div className="space-y-0.5">
                            <p className="text-xs font-mono text-muted-foreground">
                              {r.sku_codigo_omie}
                            </p>
                            <p className="text-sm whitespace-normal break-words leading-snug">
                              {r.sku_descricao ?? "—"}
                            </p>
                          </div>
                        </TableCell>
                        <TableCell className="font-medium">
                          {formatBRL(r.volume_financeiro_12m)}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-0.5">
                            <span className="font-medium">{r.num_compras_12m ?? "—"}</span>
                            {r.meses_com_compra !== null && (
                              <Badge variant="outline" className="text-[10px] w-fit">
                                em {r.meses_com_compra} meses
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>{formatBRL(r.preco_medio_unitario)}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className={percPromoBadgeClass(r.perc_meses_com_promo)}>
                            {formatPerc(r.perc_meses_com_promo)}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <span className="font-semibold w-10">{score.toFixed(1)}</span>
                            <Progress value={score} className="h-1.5 flex-1" />
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="outline"
                            className={cn("uppercase text-[10px]", categoriaBadgeClass(r.categoria))}
                          >
                            {categoriaLabel(r.categoria)}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {temSugestao ? (
                            <Badge variant="outline" className="text-[10px]">
                              Já sugerido
                            </Badge>
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handleCriarSugestaoDoRanking(r)}
                            >
                              <Sparkles className="h-3 w-3 mr-1" />
                              Criar sugestão
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

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
      <AlertDialog open={!!ignoreTarget} onOpenChange={(o) => !o && setIgnoreTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Ignorar sugestão?</AlertDialogTitle>
            <AlertDialogDescription>
              A sugestão será marcada como ignorada e removida da lista ativa. Você ainda poderá
              gerar novas sugestões depois.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={handleIgnorarConfirm}>Ignorar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Dialog: fechar sem acordo */}
      <Dialog
        open={!!fecharSemAcordoTarget}
        onOpenChange={(o) => {
          if (!o) {
            setFecharSemAcordoTarget(null);
            setFecharObs("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Fechar sem acordo</DialogTitle>
            <DialogDescription>
              Registre o motivo do encerramento sem acordo. Útil para histórico futuro.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label>Observação (opcional)</Label>
            <Textarea
              rows={4}
              value={fecharObs}
              onChange={(e) => setFecharObs(e.target.value)}
              placeholder="Ex: Sayerlack não aceitou contraproposta, alegou margem apertada."
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFecharSemAcordoTarget(null)}>
              Cancelar
            </Button>
            <Button onClick={handleFecharSemAcordoConfirm}>Confirmar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog: registrar desconto fechado (converter) */}
      <Dialog open={!!convertTarget} onOpenChange={(o) => !o && setConvertTarget(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Registrar desconto fechado</DialogTitle>
            <DialogDescription>
              Converte a sugestão em uma campanha flat condicional vinculada ao SKU{" "}
              <span className="font-mono">{convertTarget?.sku_codigo_omie}</span>.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Desconto percentual (%)</Label>
              <Input
                type="number"
                min={1}
                max={50}
                step={0.5}
                value={convertForm.desconto_perc}
                onChange={(e) =>
                  setConvertForm((f) => ({ ...f, desconto_perc: parseFloat(e.target.value) || 0 }))
                }
              />
            </div>
            <div className="space-y-2">
              <Label>Volume mínimo</Label>
              <Input
                type="number"
                min={0}
                step={1}
                value={convertForm.volume_minimo}
                onChange={(e) =>
                  setConvertForm((f) => ({ ...f, volume_minimo: parseFloat(e.target.value) || 0 }))
                }
              />
            </div>
            <div className="space-y-2">
              <Label>Unidade do volume</Label>
              <Select
                value={convertForm.volume_unidade}
                onValueChange={(v) =>
                  setConvertForm((f) => ({ ...f, volume_unidade: v as typeof f.volume_unidade }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="reais">Reais (R$)</SelectItem>
                  <SelectItem value="unidades">Unidades</SelectItem>
                  <SelectItem value="kg">Quilos (kg)</SelectItem>
                  <SelectItem value="litros">Litros</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Data fim</Label>
              <Input
                type="date"
                value={convertForm.data_fim}
                onChange={(e) => setConvertForm((f) => ({ ...f, data_fim: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label>Responsável</Label>
              <Input
                value={convertForm.responsavel}
                onChange={(e) => setConvertForm((f) => ({ ...f, responsavel: e.target.value }))}
                placeholder="Nome do vendedor / contato"
              />
            </div>
            <div className="space-y-2">
              <Label>Canal</Label>
              <Select
                value={convertForm.canal}
                onValueChange={(v) =>
                  setConvertForm((f) => ({ ...f, canal: v as typeof f.canal }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ligacao">Ligação</SelectItem>
                  <SelectItem value="whatsapp">WhatsApp</SelectItem>
                  <SelectItem value="email">E-mail</SelectItem>
                  <SelectItem value="visita_presencial">Visita presencial</SelectItem>
                  <SelectItem value="outro">Outro</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="col-span-2 space-y-2">
              <Label>Observações (opcional)</Label>
              <Textarea
                rows={3}
                value={convertForm.observacoes}
                onChange={(e) => setConvertForm((f) => ({ ...f, observacoes: e.target.value }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConvertTarget(null)}>
              Cancelar
            </Button>
            <Button onClick={handleConverterConfirm} disabled={convertSubmitting}>
              {convertSubmitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Converter em campanha
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
