import { lazy, Suspense, useEffect, useMemo, useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { format, subDays, differenceInHours } from "date-fns";
import { toast } from "sonner";
import {
  Sparkles,
  Loader2,
  CalendarRange,
  AlertTriangle,
  Download,
  ChevronDown,
  ChevronRight,
  ScrollText,
  Search,
  ListChecks,
  RotateCw,
  Keyboard,
  X,
  CheckCircle2,
  XCircle,
  Bell,
  Settings as SettingsIcon,
  Package,
  DollarSign,
  TrendingUp,
  PiggyBank,
  Printer,
  Check,
  GitCompare,
  Info,
  Pencil,
  Zap,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ProcessoComprasStepper } from "@/components/reposicao/ProcessoComprasStepper";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as ReTooltip,
  ResponsiveContainer,
} from "recharts";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";

const AdminReposicaoPedidos = lazy(() => import("./AdminReposicaoPedidos"));
const AdminReposicaoAplicacao = lazy(() => import("./AdminReposicaoAplicacao"));
const AdminReposicaoHistorico = lazy(() => import("./AdminReposicaoHistorico"));

const EMPRESA = "OBEN";
const ALL = "__all__";
const CUTOFF_HOUR = 9;
const CUTOFF_MIN = 30;

const formatBRL = (v: number | null | undefined) =>
  v === null || v === undefined
    ? "—"
    : new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(v));

const formatDate = (d: string | null | undefined) => {
  if (!d) return "—";
  const [y, m, day] = d.split("-");
  return `${day}/${m}/${y}`;
};

const TabFallback = () => (
  <div className="flex items-center justify-center py-16 text-muted-foreground">
    <Loader2 className="h-5 w-5 animate-spin mr-2" />
    Carregando...
  </div>
);

// ============================================================================
// CSV utils
// ============================================================================

function toCsvValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n;]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function downloadCsv(filename: string, headers: string[], rows: unknown[][]) {
  const csv = [headers.join(";"), ...rows.map((r) => r.map(toCsvValue).join(";"))].join("\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ============================================================================
// Audit log
// ============================================================================

async function logAudit(params: {
  userId: string | null;
  action: string;
  result: string;
  metadata?: Record<string, unknown>;
}) {
  try {
    await supabase.from("cockpit_audit_log" as any).insert({
      user_id: params.userId,
      action: params.action,
      result: params.result,
      metadata: params.metadata ?? {},
    });
  } catch {
    /* não bloqueia a UI */
  }
}

function AuditLogSection() {
  const [open, setOpen] = useState(false);
  const [limit, setLimit] = useState(20);

  type LogRow = {
    id: string;
    created_at: string;
    user_id: string | null;
    action: string;
    result: string;
    metadata: Record<string, unknown> | null;
  };

  const { data: rows = [], isLoading, refetch } = useQuery({
    queryKey: ["cockpit-audit-log", limit],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("cockpit_audit_log" as any)
        .select("id,created_at,user_id,action,result,metadata")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return ((data ?? []) as unknown) as LogRow[];
    },
    enabled: open,
  });

  return (
    <Card>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="w-full flex items-center justify-between p-4 hover:bg-muted/40 transition-colors"
          >
            <div className="flex items-center gap-2">
              <ScrollText className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">Log de Auditoria</span>
            </div>
            {open ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="pt-0">
            {isLoading ? (
              <TabFallback />
            ) : rows.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                Nenhum registro de auditoria.
              </div>
            ) : (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Quando</TableHead>
                      <TableHead>Usuário</TableHead>
                      <TableHead>Ação</TableHead>
                      <TableHead>Resultado</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((r) => {
                      const isErr = r.result.toLowerCase().startsWith("erro");
                      return (
                        <TableRow key={r.id}>
                          <TableCell className="text-xs whitespace-nowrap">
                            {new Date(r.created_at).toLocaleString("pt-BR")}
                          </TableCell>
                          <TableCell className="text-xs font-mono">
                            {r.user_id ? r.user_id.slice(0, 8) : "—"}
                          </TableCell>
                          <TableCell className="text-sm">{r.action}</TableCell>
                          <TableCell>
                            <Badge variant={isErr ? "destructive" : "secondary"}>
                              {r.result}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
                <div className="flex justify-center pt-4">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setLimit((l) => l + 20);
                      refetch();
                    }}
                  >
                    Ver mais
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

// ============================================================================
// Itens do ciclo (hoje) — query reutilizada para filtros, métricas, batch e CSV
// ============================================================================

type PedidoItem = {
  id: number;
  fornecedor_nome: string | null;
  grupo_codigo: string | null;
  num_skus: number | null;
  valor_total: number | null;
  pedido_anterior_valor: number | null;
  status: string | null;
  aprovado_em: string | null;
  cancelado_em: string | null;
  horario_disparo_real: string | null;
};

function useItensDoDia() {
  const today = format(new Date(), "yyyy-MM-dd");
  return useQuery({
    queryKey: ["cockpit-itens-dia", EMPRESA, today],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("pedido_compra_sugerido" as any)
        .select(
          "id,fornecedor_nome,grupo_codigo,num_skus,valor_total,pedido_anterior_valor,status,aprovado_em,cancelado_em,horario_disparo_real",
        )
        .eq("empresa", EMPRESA)
        .eq("data_ciclo", today)
        .order("fornecedor_nome");
      if (error) throw error;
      return ((data ?? []) as unknown) as PedidoItem[];
    },
    staleTime: 30_000,
  });
}

// ============================================================================
// Histórico chart query (12 últimos ciclos)
// ============================================================================

function useHistoricoChart() {
  const fim = useMemo(() => new Date(), []);
  const inicio = useMemo(() => subDays(fim, 60), [fim]);
  return useQuery({
    queryKey: ["cockpit-historico-chart", EMPRESA, format(fim, "yyyy-MM-dd")],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("pedido_compra_sugerido" as any)
        .select("data_ciclo,num_skus,valor_total")
        .eq("empresa", EMPRESA)
        .gte("data_ciclo", format(inicio, "yyyy-MM-dd"))
        .lte("data_ciclo", format(fim, "yyyy-MM-dd"));
      if (error) throw error;
      const rows = ((data ?? []) as unknown) as Array<{
        data_ciclo: string;
        num_skus: number | null;
        valor_total: number | null;
      }>;
      const map = new Map<string, { data: string; total: number; skus: number; valor: number }>();
      for (const r of rows) {
        const acc = map.get(r.data_ciclo) ?? {
          data: r.data_ciclo,
          total: 0,
          skus: 0,
          valor: 0,
        };
        acc.total += 1;
        acc.skus += Number(r.num_skus ?? 0);
        acc.valor += Number(r.valor_total ?? 0);
        map.set(r.data_ciclo, acc);
      }
      return Array.from(map.values())
        .sort((a, b) => a.data.localeCompare(b.data))
        .slice(-12)
        .map((x) => {
          const [y, m, d] = x.data.split("-");
          return { ...x, label: `${d}/${m}` };
        });
    },
  });
}

// ============================================================================
// Smart alerts
// ============================================================================

type SmartAlert = {
  id: string;
  level: "yellow" | "orange" | "red";
  message: string;
  actionLabel: string;
  onAction: () => void;
};

function useSmartAlerts(): SmartAlert[] {
  const navigate = useNavigate();

  const { data: paramsPendentes = 0 } = useQuery({
    queryKey: ["cockpit-alert-params-pendentes", EMPRESA],
    queryFn: async () => {
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { count, error } = await supabase
        .from("sku_parametros" as any)
        .select("*", { count: "exact", head: true })
        .eq("empresa", EMPRESA)
        .eq("ativo", true)
        .is("aprovado_em", null)
        .lt("ultima_atualizacao_calculo", cutoff);
      if (error) throw error;
      return count ?? 0;
    },
    staleTime: 60_000,
  });

  const { data: skusSemParam = 0 } = useQuery({
    queryKey: ["cockpit-alert-sem-parametro", EMPRESA],
    queryFn: async () => {
      const { count, error } = await supabase
        .from("sku_parametros" as any)
        .select("*", { count: "exact", head: true })
        .eq("empresa", EMPRESA)
        .eq("ativo", true)
        .is("estoque_minimo", null);
      if (error) throw error;
      return count ?? 0;
    },
    staleTime: 60_000,
  });

  return useMemo(() => {
    const list: SmartAlert[] = [];
    if (paramsPendentes > 0) {
      list.push({
        id: "params-24h",
        level: "yellow",
        message: `${paramsPendentes} parâmetro(s) aguardam aprovação há mais de 24h`,
        actionLabel: "Ver parâmetros",
        onAction: () => navigate("/admin/reposicao/parametros"),
      });
    }
    // Janela fecha em < 1h
    const now = new Date();
    const cutoff = new Date(now);
    cutoff.setHours(CUTOFF_HOUR, CUTOFF_MIN, 0, 0);
    const minutes = (cutoff.getTime() - now.getTime()) / 60_000;
    if (minutes > 0 && minutes < 60) {
      list.push({
        id: "janela-1h",
        level: "orange",
        message: `Janela de compra fecha em ${Math.ceil(minutes)} minutos`,
        actionLabel: "Ver cockpit",
        onAction: () => navigate("/admin/reposicao/cockpit?tab=ciclohoje"),
      });
    }
    if (skusSemParam > 0) {
      list.push({
        id: "skus-sem-param",
        level: "red",
        message: `${skusSemParam} SKU(s) ativos sem parâmetro configurado`,
        actionLabel: "Configurar",
        onAction: () => navigate("/admin/reposicao/parametros"),
      });
    }
    return list;
  }, [paramsPendentes, skusSemParam, navigate]);
}

function SmartAlertsSection() {
  const alerts = useSmartAlerts();
  const [dismissed, setDismissed] = useState<Set<string>>(() => {
    try {
      const raw = sessionStorage.getItem("cockpit-dismissed-alerts");
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set();
    }
  });

  const dismiss = (id: string) => {
    const next = new Set(dismissed);
    next.add(id);
    setDismissed(next);
    try {
      sessionStorage.setItem("cockpit-dismissed-alerts", JSON.stringify(Array.from(next)));
    } catch {
      /* ignore */
    }
  };

  const visible = alerts.filter((a) => !dismissed.has(a.id)).slice(0, 3);
  if (visible.length === 0) return null;

  const tone = (l: SmartAlert["level"]) =>
    l === "yellow"
      ? "border-amber-500/40 bg-amber-500/5 text-amber-900 dark:text-amber-200"
      : l === "orange"
        ? "border-orange-500/40 bg-orange-500/5 text-orange-900 dark:text-orange-200"
        : "border-destructive/40 bg-destructive/5 text-destructive";

  const Icon = ({ l }: { l: SmartAlert["level"] }) =>
    l === "red" ? (
      <AlertTriangle className="h-4 w-4 shrink-0" />
    ) : l === "orange" ? (
      <Bell className="h-4 w-4 shrink-0" />
    ) : (
      <AlertTriangle className="h-4 w-4 shrink-0" />
    );

  return (
    <div className="space-y-2">
      {visible.map((a) => (
        <div
          key={a.id}
          className={`flex items-center gap-3 rounded-md border px-3 py-2 text-sm ${tone(
            a.level,
          )}`}
        >
          <Icon l={a.level} />
          <span className="flex-1">{a.message}</span>
          <Button size="sm" variant="outline" onClick={a.onAction}>
            {a.actionLabel}
          </Button>
          <button
            type="button"
            onClick={() => dismiss(a.id)}
            className="opacity-60 hover:opacity-100"
            aria-label="Dispensar"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
}

// ============================================================================
// Métricas do ciclo
// ============================================================================

function MetricsStrip({ items }: { items: PedidoItem[] }) {
  const totalSkus = items.reduce((s, r) => s + Number(r.num_skus ?? 0), 0);
  const valorEstimado = items.reduce((s, r) => s + Number(r.valor_total ?? 0), 0);
  const aprovados = items.filter((r) => !!r.aprovado_em).length;
  const pctAprovado = items.length > 0 ? (aprovados / items.length) * 100 : 0;
  const economia = 0; // campo não disponível

  const Card1 = ({
    icon: I,
    label,
    value,
    extra,
  }: {
    icon: typeof Package;
    label: string;
    value: string;
    extra?: React.ReactNode;
  }) => (
    <Card>
      <CardContent className="p-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
          <I className="h-3.5 w-3.5" />
          {label}
        </div>
        <div className="text-lg font-semibold">{value}</div>
        {extra}
      </CardContent>
    </Card>
  );

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <Card1 icon={Package} label="SKUs sugeridos" value={totalSkus.toLocaleString("pt-BR")} />
      <Card1 icon={DollarSign} label="Valor estimado" value={formatBRL(valorEstimado)} />
      <Card1
        icon={TrendingUp}
        label="% Aprovado"
        value={`${pctAprovado.toFixed(0)}%`}
        extra={<Progress value={pctAprovado} className="h-1.5 mt-2" />}
      />
      <Card1 icon={PiggyBank} label="Economia potencial" value={formatBRL(economia)} />
    </div>
  );
}

// ============================================================================
// Configuração de colunas (persistida em localStorage)
// ============================================================================

type ColKey =
  | "fornecedor"
  | "grupo"
  | "skus"
  | "valor"
  | "status"
  | "qtdAprovada"
  | "preco"
  | "confianca";

const COL_DEFS: Array<{ key: ColKey; label: string }> = [
  { key: "fornecedor", label: "Fornecedor" },
  { key: "grupo", label: "Grupo" },
  { key: "skus", label: "SKUs" },
  { key: "valor", label: "Valor" },
  { key: "status", label: "Status" },
  { key: "qtdAprovada", label: "Qtd Aprovada" },
  { key: "preco", label: "Preço" },
  { key: "confianca", label: "Confiança" },
];

const DEFAULT_COLS: Record<ColKey, boolean> = {
  fornecedor: true,
  grupo: true,
  skus: true,
  valor: true,
  status: true,
  qtdAprovada: true,
  preco: false,
  confianca: false,
};

const COLS_STORAGE_KEY = "cockpit-colunas-v1";

function useColumnConfig() {
  const [cols, setCols] = useState<Record<ColKey, boolean>>(() => {
    try {
      const raw = localStorage.getItem(COLS_STORAGE_KEY);
      if (!raw) return DEFAULT_COLS;
      const parsed = JSON.parse(raw) as Partial<Record<ColKey, boolean>>;
      return { ...DEFAULT_COLS, ...parsed };
    } catch {
      return DEFAULT_COLS;
    }
  });
  const update = (key: ColKey, value: boolean) => {
    const next = { ...cols, [key]: value };
    setCols(next);
    try {
      localStorage.setItem(COLS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };
  return { cols, update };
}

function ColumnConfigPopover({
  cols,
  onChange,
}: {
  cols: Record<ColKey, boolean>;
  onChange: (k: ColKey, v: boolean) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline" title="Configurar colunas">
          <SettingsIcon className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-3" align="end">
        <div className="text-xs font-semibold mb-2 text-muted-foreground">
          Colunas visíveis
        </div>
        <div className="space-y-2">
          {COL_DEFS.map((c) => (
            <label
              key={c.key}
              className="flex items-center gap-2 text-sm cursor-pointer"
            >
              <Checkbox
                checked={cols[c.key]}
                onCheckedChange={(v) => onChange(c.key, !!v)}
              />
              {c.label}
            </label>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ============================================================================
// Confiança (inferida do status quando não há dias_cobertura_*)
// ============================================================================

type ConfLevel = "alta" | "media" | "baixa";
function inferConfianca(r: PedidoItem): { level: ConfLevel; reason: string } {
  // Schema atual não possui dias_cobertura_atual/alvo — inferimos pelo status.
  const s = (r.status ?? "").toLowerCase();
  if (s.includes("pendente_aprovacao")) {
    return { level: "alta", reason: "Pedido pendente gerado pelos guardrails do ciclo." };
  }
  if (s.includes("disparado") || s.includes("aprovado")) {
    return { level: "alta", reason: "Pedido já aprovado/disparado." };
  }
  if (s.includes("cancel")) {
    return { level: "baixa", reason: "Pedido cancelado — comprar geraria sobrestoque." };
  }
  if (s.includes("bloque")) {
    return { level: "baixa", reason: "Bloqueado por guardrail." };
  }
  return {
    level: "media",
    reason:
      "Sem dados de cobertura no registro; confiança média por padrão (status pendente).",
  };
}

type ApprovalSuggestion = { mode: "auto" | "review"; reasons: string[] };

function calcApprovalSuggestion(item: PedidoItem): ApprovalSuggestion {
  const reasons: string[] = [];
  const status = (item.status ?? "").toLowerCase();
  const qtd = Number(item.num_skus ?? 0);
  const valorAtual = Number(item.valor_total ?? 0);
  const valorAnterior = Number(item.pedido_anterior_valor ?? 0);

  if (!Number.isFinite(qtd) || qtd <= 0) {
    reasons.push("Quantidade sugerida inválida");
  }
  if (item.aprovado_em || item.cancelado_em || !status.includes("pendente_aprovacao")) {
    reasons.push("Confiança baixa/média — verificar status");
  }
  if (!Number.isFinite(valorAnterior) || valorAnterior <= 0) {
    reasons.push("Primeiro pedido — sem referência histórica");
  } else {
    const delta = Math.abs(valorAtual - valorAnterior) / valorAnterior;
    if (delta > 0.3) {
      reasons.push(`Valor varia ${(delta * 100).toFixed(1)}% vs. ciclo anterior`);
    }
  }

  return reasons.length === 0 ? { mode: "auto", reasons: [] } : { mode: "review", reasons };
}

// ============================================================================
// Itens do ciclo (com filtros + batch review + ações inline + colunas)
// ============================================================================

function PrecoCell({ row }: { row: PedidoItem }) {
  const atual = Number(row.valor_total ?? 0);
  const anterior = Number(row.pedido_anterior_valor ?? NaN);
  if (!Number.isFinite(anterior) || anterior === 0) {
    return <span className="font-medium">{formatBRL(atual)}</span>;
  }
  const deltaPct = ((atual - anterior) / anterior) * 100;
  const tone =
    Math.abs(deltaPct) < 0.5
      ? "text-muted-foreground"
      : deltaPct < 0
        ? "text-emerald-600"
        : "text-destructive";
  return (
    <div className="flex flex-col items-end">
      <span className="font-medium">{formatBRL(atual)}</span>
      <span className={`text-[11px] ${tone}`}>
        {deltaPct > 0 ? "+" : ""}
        {deltaPct.toFixed(1)}%
      </span>
    </div>
  );
}

function ConfiancaBadge({ row }: { row: PedidoItem }) {
  const { level, reason } = inferConfianca(row);
  const map = {
    alta: { label: "Alta", cls: "bg-emerald-500/15 text-emerald-700 border-emerald-500/40" },
    media: { label: "Média", cls: "bg-amber-500/15 text-amber-700 border-amber-500/40" },
    baixa: { label: "Baixa", cls: "bg-muted text-muted-foreground border-border" },
  } as const;
  const m = map[level];
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium ${m.cls}`}
          >
            <Info className="h-3 w-3" /> {m.label}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-[240px] text-xs">{reason}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function PedidoRow({
  row,
  reviewMode,
  selected,
  onToggle,
  cols,
  user,
  onChanged,
}: {
  row: PedidoItem;
  reviewMode: boolean;
  selected: boolean;
  onToggle: () => void;
  cols: Record<ColKey, boolean>;
  user: { id?: string; email?: string | null } | null;
  onChanged: () => void;
}) {
  const [qty, setQty] = useState<number>(Number(row.num_skus ?? 0));
  const [busy, setBusy] = useState<null | "approve" | "reject">(null);
  const [editingAuto, setEditingAuto] = useState(false);
  const suggestion = calcApprovalSuggestion(row);
  const showInlineEditor = suggestion.mode === "review" || editingAuto;

  useEffect(() => {
    setQty(Number(row.num_skus ?? 0));
  }, [row.num_skus]);

  const isApproved = !!row.aprovado_em;
  const isRejected = !!row.cancelado_em;

  const rowBg = isApproved
    ? "bg-emerald-500/5 hover:bg-emerald-500/10"
    : isRejected
      ? "bg-destructive/5 hover:bg-destructive/10"
      : "";

  const act = async (kind: "approve" | "reject") => {
    if (busy) return;
    setBusy(kind);
    const nowIso = new Date().toISOString();
    const who = user?.email ?? user?.id ?? "cockpit";
    try {
      const patch =
        kind === "approve"
          ? {
              aprovado_em: nowIso,
              aprovado_por: who,
              status: "aprovado_aguardando_disparo" as const,
              num_skus: qty,
            }
          : {
              cancelado_em: nowIso,
              cancelado_por: who,
              status: "cancelado" as const,
              justificativa_cancelamento: "Rejeitado inline no Cockpit",
            };
      const { error } = await supabase
        .from("pedido_compra_sugerido" as any)
        .update(patch)
        .eq("id", row.id);
      if (error) throw error;
      await logAudit({
        userId: user?.id ?? null,
        action: kind === "approve" ? "Aprovação inline" : "Rejeição inline",
        result: "Sucesso",
        metadata: { id: row.id, qty },
      });
      toast.success(kind === "approve" ? "Pedido aprovado" : "Pedido rejeitado");
      onChanged();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logAudit({
        userId: user?.id ?? null,
        action: kind === "approve" ? "Aprovação inline" : "Rejeição inline",
        result: `Erro: ${msg}`,
        metadata: { id: row.id },
      });
      toast.error("Falha na operação");
    } finally {
      setBusy(null);
    }
  };

  return (
    <TableRow data-state={selected ? "selected" : undefined} className={rowBg}>
      {reviewMode && (
        <TableCell>
          <Checkbox checked={selected} onCheckedChange={onToggle} />
        </TableCell>
      )}
      {cols.fornecedor && (
        <TableCell className="text-sm">{row.fornecedor_nome ?? "—"}</TableCell>
      )}
      {cols.grupo && (
        <TableCell className="text-xs text-muted-foreground">
          {row.grupo_codigo ?? "—"}
        </TableCell>
      )}
      {cols.skus && (
        <TableCell className="text-right">{row.num_skus ?? 0}</TableCell>
      )}
      {cols.valor && (
        <TableCell className="text-right font-medium">
          {formatBRL(row.valor_total)}
        </TableCell>
      )}
      {cols.preco && (
        <TableCell className="text-right">
          <PrecoCell row={row} />
        </TableCell>
      )}
      {cols.confianca && (
        <TableCell>
          <ConfiancaBadge row={row} />
        </TableCell>
      )}
      {cols.status && (
        <TableCell>
          <Badge variant="secondary">{row.status ?? "—"}</Badge>
        </TableCell>
      )}
      {cols.qtdAprovada && (
        <TableCell>
          <div className="flex items-center gap-1.5 justify-end">
            {suggestion.mode === "auto" && !showInlineEditor ? (
              <>
                <Badge variant="secondary" className="gap-1 bg-primary/10 text-primary border-primary/20">
                  <Zap className="h-3 w-3" /> Auto
                </Badge>
                <span className="w-10 text-right tabular-nums font-medium">{qty}</span>
                <Button
                  size="icon"
                  variant="outline"
                  className="h-8 w-8"
                  onClick={() => setEditingAuto(true)}
                  title="Editar quantidade antes de aprovar"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
              </>
            ) : (
              <>
                {suggestion.mode === "review" && (
                  <TooltipProvider delayDuration={200}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge variant="outline" className="gap-1 border-amber-500/40 text-amber-700 bg-amber-500/10">
                          <AlertTriangle className="h-3 w-3" /> Revisar
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-[260px] text-xs">
                        {suggestion.reasons.join(" · ")}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
            <Input
              type="number"
              min={0}
              value={qty}
              disabled={isApproved || isRejected || busy !== null}
              onChange={(e) => setQty(Number(e.target.value) || 0)}
              onFocus={(e) => e.currentTarget.select()}
              className="h-8 w-20 text-right"
            />
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-500/10"
              disabled={isApproved || busy !== null}
              onClick={() => act("approve")}
              title="Aprovar"
            >
              {busy === "approve" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Check className="h-4 w-4" />
              )}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8 text-destructive hover:bg-destructive/10"
              disabled={isRejected || busy !== null}
              onClick={() => act("reject")}
              title="Rejeitar"
            >
              {busy === "reject" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <X className="h-4 w-4" />
              )}
            </Button>
              </>
            )}
          </div>
        </TableCell>
      )}
    </TableRow>
  );
}

function CicloHojePanel({
  user,
  reviewMode,
  setReviewMode,
  filters,
  setFilters,
  filteredItems,
  fornecedores,
  statuses,
  isLoading,
  cols,
  onColChange,
}: {
  user: { id?: string; email?: string | null } | null;
  reviewMode: boolean;
  setReviewMode: (b: boolean) => void;
  filters: { search: string; fornecedor: string; status: string };
  setFilters: (f: { search: string; fornecedor: string; status: string }) => void;
  filteredItems: PedidoItem[];
  fornecedores: string[];
  statuses: string[];
  isLoading: boolean;
  cols: Record<ColKey, boolean>;
  onColChange: (k: ColKey, v: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [confirmAuto, setConfirmAuto] = useState(false);

  useEffect(() => {
    if (!reviewMode) setSelected(new Set());
  }, [reviewMode]);

  const allChecked = filteredItems.length > 0 && filteredItems.every((i) => selected.has(i.id));
  const toggleAll = () => {
    if (allChecked) setSelected(new Set());
    else setSelected(new Set(filteredItems.map((i) => i.id)));
  };
  const toggleOne = (id: number) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const totalSelectedValue = filteredItems
    .filter((i) => selected.has(i.id))
    .reduce((s, r) => s + Number(r.valor_total ?? 0), 0);

  const eligibleAutoItems = useMemo(
    () =>
      filteredItems.filter(
        (item) =>
          calcApprovalSuggestion(item).mode === "auto" &&
          !item.aprovado_em &&
          !item.cancelado_em,
      ),
    [filteredItems],
  );

  const autoApprovalGroups = useMemo(() => {
    const map = new Map<string, number>();
    eligibleAutoItems.forEach((item) => {
      const fornecedor = item.fornecedor_nome ?? "Sem fornecedor";
      map.set(fornecedor, (map.get(fornecedor) ?? 0) + Number(item.num_skus ?? 0));
    });
    return Array.from(map.entries()).map(([fornecedor, qtd]) => ({ fornecedor, qtd }));
  }, [eligibleAutoItems]);

  const manualReviewItems = useMemo(
    () =>
      filteredItems
        .filter((item) => !item.aprovado_em && !item.cancelado_em)
        .map((item) => ({ item, suggestion: calcApprovalSuggestion(item) }))
        .filter(({ suggestion }) => suggestion.mode === "review"),
    [filteredItems],
  );

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["cockpit-itens-dia"] });
    queryClient.invalidateQueries({ queryKey: ["cockpit-current-step"] });
    queryClient.invalidateQueries({ queryKey: ["reposicao-pedidos"] });
  };

  const runBatch = async (kind: "approve" | "reject") => {
    if (selected.size === 0 || busy) return;
    setBusy(true);
    const ids = Array.from(selected);
    const nowIso = new Date().toISOString();
    const who = user?.email ?? user?.id ?? "cockpit";
    try {
      const patch =
        kind === "approve"
          ? {
              aprovado_em: nowIso,
              aprovado_por: who,
              status: "aprovado_aguardando_disparo" as const,
            }
          : {
              cancelado_em: nowIso,
              cancelado_por: who,
              status: "cancelado" as const,
              justificativa_cancelamento: "Rejeitado em lote no Cockpit",
            };
      const { error } = await supabase
        .from("pedido_compra_sugerido" as any)
        .update(patch)
        .in("id", ids);
      if (error) throw error;

      await logAudit({
        userId: user?.id ?? null,
        action: kind === "approve" ? "Aprovação em lote" : "Rejeição em lote",
        result: "Sucesso",
        metadata: { ids, count: ids.length },
      });
      toast.success(
        `${ids.length} pedido(s) ${kind === "approve" ? "aprovado(s)" : "rejeitado(s)"}`,
      );
      setSelected(new Set());
      invalidate();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logAudit({
        userId: user?.id ?? null,
        action: kind === "approve" ? "Aprovação em lote" : "Rejeição em lote",
        result: `Erro: ${msg}`,
        metadata: { ids },
      });
      toast.error("Falha na operação em lote");
    } finally {
      setBusy(false);
    }
  };

  const runAutoApprove = async () => {
    if (eligibleAutoItems.length === 0 || busy) return;
    setBusy(true);
    const ids = eligibleAutoItems.map((item) => item.id);
    const nowIso = new Date().toISOString();
    const who = user?.email ?? user?.id ?? "cockpit";
    try {
      const { error } = await supabase
        .from("pedido_compra_sugerido" as any)
        .update({
          aprovado_em: nowIso,
          aprovado_por: who,
          status: "aprovado_aguardando_disparo",
        })
        .in("id", ids);
      if (error) throw error;
      await logAudit({
        userId: user?.id ?? null,
        action: "Aprovação automática de elegíveis",
        result: "Sucesso",
        metadata: { ids, count: ids.length },
      });
      toast.success(`${ids.length} pedido(s) aprovado(s) automaticamente`);
      setConfirmAuto(false);
      invalidate();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logAudit({
        userId: user?.id ?? null,
        action: "Aprovação automática de elegíveis",
        result: `Erro: ${msg}`,
        metadata: { ids },
      });
      toast.error("Falha ao aprovar elegíveis");
    } finally {
      setBusy(false);
    }
  };

  const clearFilters = () =>
    setFilters({ search: "", fornecedor: ALL, status: ALL });

  return (
    <div className="space-y-4">
      {/* Filters bar */}
      <div className="flex flex-wrap items-center gap-2 rounded-md border p-2 bg-card">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={filters.search}
            onChange={(e) => setFilters({ ...filters, search: e.target.value })}
            placeholder="Buscar SKU, descrição ou fornecedor..."
            className="pl-8 h-9"
          />
        </div>
        <Select
          value={filters.fornecedor}
          onValueChange={(v) => setFilters({ ...filters, fornecedor: v })}
        >
          <SelectTrigger className="w-[180px] h-9">
            <SelectValue placeholder="Fornecedor" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Todos os fornecedores</SelectItem>
            {fornecedores.map((f) => (
              <SelectItem key={f} value={f}>
                {f}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={filters.status}
          onValueChange={(v) => setFilters({ ...filters, status: v })}
        >
          <SelectTrigger className="w-[180px] h-9">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Todos os status</SelectItem>
            {statuses.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" variant="ghost" onClick={clearFilters}>
          Limpar filtros
        </Button>
        <Button
          size="sm"
          onClick={() => setConfirmAuto(true)}
          disabled={eligibleAutoItems.length === 0 || busy}
          title="Aprovar automaticamente apenas os itens classificados como Auto"
        >
          <Zap className="h-4 w-4 mr-1.5" />
          Aprovar elegíveis ({eligibleAutoItems.length})
        </Button>
        <Button
          size="sm"
          variant={reviewMode ? "default" : "outline"}
          onClick={() => setReviewMode(!reviewMode)}
        >
          <ListChecks className="h-4 w-4 mr-1.5" />
          Modo revisão
        </Button>
        <ColumnConfigPopover cols={cols} onChange={onColChange} />
      </div>

      {/* Items table */}
      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-base">
            Pedidos do ciclo ({filteredItems.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          {isLoading ? (
            <TabFallback />
          ) : filteredItems.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              Nenhum pedido para os filtros atuais.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  {reviewMode && (
                    <TableHead className="w-[40px]">
                      <Checkbox checked={allChecked} onCheckedChange={toggleAll} />
                    </TableHead>
                  )}
                  {cols.fornecedor && <TableHead>Fornecedor</TableHead>}
                  {cols.grupo && <TableHead>Grupo</TableHead>}
                  {cols.skus && <TableHead className="text-right">SKUs</TableHead>}
                  {cols.valor && <TableHead className="text-right">Valor</TableHead>}
                  {cols.preco && <TableHead className="text-right">Preço</TableHead>}
                  {cols.confianca && <TableHead>Confiança</TableHead>}
                  {cols.status && <TableHead>Status</TableHead>}
                  {cols.qtdAprovada && (
                    <TableHead className="text-right">Qtd Aprovada</TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredItems.map((r) => (
                  <PedidoRow
                    key={r.id}
                    row={r}
                    reviewMode={reviewMode}
                    selected={selected.has(r.id)}
                    onToggle={() => toggleOne(r.id)}
                    cols={cols}
                    user={user}
                    onChanged={invalidate}
                  />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={confirmAuto} onOpenChange={setConfirmAuto}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Zap className="h-5 w-5 text-primary" /> Aprovar elegíveis automaticamente
            </DialogTitle>
            <DialogDescription>
              {eligibleAutoItems.length} pedido(s) serão aprovados automaticamente.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-56 overflow-y-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Fornecedor</TableHead>
                  <TableHead className="text-right">Qtd</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {autoApprovalGroups.map((group) => (
                  <TableRow key={group.fornecedor}>
                    <TableCell>{group.fornecedor}</TableCell>
                    <TableCell className="text-right tabular-nums">{group.qtd}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setConfirmAuto(false)} disabled={busy}>
              Cancelar
            </Button>
            <Button onClick={runAutoApprove} disabled={busy || eligibleAutoItems.length === 0}>
              {busy && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              Confirmar aprovação
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Conteúdo original detalhado */}
      <Suspense fallback={<TabFallback />}>
        <AdminReposicaoPedidos />
      </Suspense>

      {/* Sticky footer for batch review */}
      {reviewMode && selected.size > 0 && (
        <div className="fixed bottom-0 left-0 right-0 z-40 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 shadow-lg">
          <div className="container max-w-7xl mx-auto px-4 py-3 flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm">
              <span className="font-semibold">{selected.size}</span> itens selecionados |{" "}
              <span className="font-semibold">Total: {formatBRL(totalSelectedValue)}</span>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => runBatch("reject")}
                disabled={busy}
              >
                <XCircle className="h-4 w-4 mr-1.5" /> Rejeitar selecionados
              </Button>
              <Button size="sm" onClick={() => runBatch("approve")} disabled={busy}>
                {busy ? (
                  <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-4 w-4 mr-1.5" />
                )}
                Aprovar selecionados
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Stepper / etapa atual
// ============================================================================

function useCurrentStep() {
  const today = format(new Date(), "yyyy-MM-dd");

  return useQuery({
    queryKey: ["cockpit-current-step", EMPRESA, today],
    queryFn: async () => {
      const oport = await supabase
        .from("v_oportunidade_economica_hoje" as any)
        .select("*", { count: "exact", head: true })
        .eq("empresa", EMPRESA);
      if (oport.error) throw oport.error;

      const params = await supabase
        .from("sku_parametros" as any)
        .select("*", { count: "exact", head: true })
        .eq("empresa", EMPRESA)
        .eq("ativo", true)
        .is("aprovado_em", null);
      if (params.error) throw params.error;

      const pedidos = await supabase
        .from("pedido_compra_sugerido" as any)
        .select("status")
        .eq("empresa", EMPRESA)
        .eq("data_ciclo", today);
      if (pedidos.error) throw pedidos.error;

      const statuses = (((pedidos.data ?? []) as unknown) as Array<{ status: string | null }>).map(
        (r) => r.status,
      );
      const hasPendentes = statuses.some(
        (s) => s === "pendente_aprovacao" || s === "bloqueado_guardrail",
      );
      const hasAprovados = statuses.some((s) => s === "aprovado_aguardando_disparo");
      const hasDisparados = statuses.some((s) => s === "disparado");

      if ((oport.count ?? 0) > 0) return 1;
      if ((params.count ?? 0) > 0) return 2;
      if (hasPendentes) return 3;
      if (hasAprovados) return 4;
      if (hasDisparados) return 5;
      return 3;
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

const TAB_VALUES = ["ciclohoje", "aplicaromie", "anteriores"] as const;
type TabValue = (typeof TAB_VALUES)[number];

// ============================================================================
// Histórico (chart) tab
// ============================================================================

type CompareRow = {
  fornecedor_nome: string;
  num_skus: number;
  valor_total: number;
};

function CompareCyclesSection({ cycles }: { cycles: string[] }) {
  const [a, setA] = useState<string>("");
  const [b, setB] = useState<string>("");
  const [diff, setDiff] = useState<{
    novos: CompareRow[];
    removidos: CompareRow[];
    alterados: Array<{
      fornecedor_nome: string;
      a: CompareRow;
      b: CompareRow;
      deltaQty: number;
      deltaVal: number;
    }>;
  } | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchCycle = async (data_ciclo: string): Promise<CompareRow[]> => {
    const { data, error } = await supabase
      .from("pedido_compra_sugerido" as any)
      .select("fornecedor_nome,num_skus,valor_total")
      .eq("empresa", EMPRESA)
      .eq("data_ciclo", data_ciclo);
    if (error) throw error;
    const rows = ((data ?? []) as unknown) as Array<{
      fornecedor_nome: string | null;
      num_skus: number | null;
      valor_total: number | null;
    }>;
    const map = new Map<string, CompareRow>();
    for (const r of rows) {
      const key = r.fornecedor_nome ?? "—";
      const acc = map.get(key) ?? { fornecedor_nome: key, num_skus: 0, valor_total: 0 };
      acc.num_skus += Number(r.num_skus ?? 0);
      acc.valor_total += Number(r.valor_total ?? 0);
      map.set(key, acc);
    }
    return Array.from(map.values());
  };

  const compare = async () => {
    if (!a || !b || a === b) {
      toast.error("Selecione dois ciclos diferentes");
      return;
    }
    setLoading(true);
    try {
      const [arows, brows] = await Promise.all([fetchCycle(a), fetchCycle(b)]);
      const amap = new Map(arows.map((r) => [r.fornecedor_nome, r]));
      const bmap = new Map(brows.map((r) => [r.fornecedor_nome, r]));
      const novos = brows.filter((r) => !amap.has(r.fornecedor_nome));
      const removidos = arows.filter((r) => !bmap.has(r.fornecedor_nome));
      const alterados: typeof diff extends infer T
        ? T extends { alterados: infer U }
          ? U
          : never
        : never = [];
      for (const br of brows) {
        const ar = amap.get(br.fornecedor_nome);
        if (!ar) continue;
        if (ar.num_skus !== br.num_skus || ar.valor_total !== br.valor_total) {
          alterados.push({
            fornecedor_nome: br.fornecedor_nome,
            a: ar,
            b: br,
            deltaQty: br.num_skus - ar.num_skus,
            deltaVal: br.valor_total - ar.valor_total,
          });
        }
      }
      setDiff({ novos, removidos, alterados });
    } catch (err) {
      toast.error("Falha ao comparar ciclos");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader className="py-3">
        <div className="flex items-center gap-2">
          <GitCompare className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-base">Comparar ciclos</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={a} onValueChange={setA}>
            <SelectTrigger className="w-[180px] h-9">
              <SelectValue placeholder="Ciclo A" />
            </SelectTrigger>
            <SelectContent>
              {cycles.map((c) => (
                <SelectItem key={c} value={c}>
                  {formatDate(c)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={b} onValueChange={setB}>
            <SelectTrigger className="w-[180px] h-9">
              <SelectValue placeholder="Ciclo B" />
            </SelectTrigger>
            <SelectContent>
              {cycles.map((c) => (
                <SelectItem key={c} value={c}>
                  {formatDate(c)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" onClick={compare} disabled={loading || !a || !b}>
            {loading ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : null}
            Comparar
          </Button>
        </div>

        {diff && (
          <div className="space-y-3">
            <div>
              <div className="text-xs font-semibold text-emerald-700 mb-1">
                Novos no Ciclo B ({diff.novos.length})
              </div>
              {diff.novos.length === 0 ? (
                <div className="text-xs text-muted-foreground">Nenhum.</div>
              ) : (
                <div className="rounded-md border bg-emerald-500/5 divide-y">
                  {diff.novos.map((r) => (
                    <div key={r.fornecedor_nome} className="px-3 py-1.5 text-sm flex justify-between">
                      <span>{r.fornecedor_nome}</span>
                      <span className="text-muted-foreground">
                        {r.num_skus} SKUs · {formatBRL(r.valor_total)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <div className="text-xs font-semibold text-destructive mb-1">
                Removidos vs Ciclo A ({diff.removidos.length})
              </div>
              {diff.removidos.length === 0 ? (
                <div className="text-xs text-muted-foreground">Nenhum.</div>
              ) : (
                <div className="rounded-md border bg-destructive/5 divide-y">
                  {diff.removidos.map((r) => (
                    <div key={r.fornecedor_nome} className="px-3 py-1.5 text-sm flex justify-between">
                      <span>{r.fornecedor_nome}</span>
                      <span className="text-muted-foreground">
                        {r.num_skus} SKUs · {formatBRL(r.valor_total)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <div className="text-xs font-semibold text-amber-700 mb-1">
                Alterados ({diff.alterados.length})
              </div>
              {diff.alterados.length === 0 ? (
                <div className="text-xs text-muted-foreground">Nenhum.</div>
              ) : (
                <div className="rounded-md border bg-amber-500/5 divide-y">
                  {diff.alterados.map((r) => (
                    <div key={r.fornecedor_nome} className="px-3 py-1.5 text-sm flex justify-between gap-2">
                      <span>{r.fornecedor_nome}</span>
                      <span className="text-xs text-muted-foreground">
                        Δ SKUs: {r.deltaQty > 0 ? "+" : ""}
                        {r.deltaQty} · Δ valor: {r.deltaVal >= 0 ? "+" : ""}
                        {formatBRL(r.deltaVal)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function HistoricoComChart() {
  const { data = [], isLoading } = useHistoricoChart();
  const cycles = useMemo(() => data.map((d) => d.data).reverse(), [data]);
  return (
    <div className="space-y-4">
      <CompareCyclesSection cycles={cycles} />
      <Card>
        <CardHeader className="py-3">
          <div className="flex items-center gap-2">
            <CalendarRange className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">Últimos 12 ciclos</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <TabFallback />
          ) : data.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              Sem ciclos no período.
            </div>
          ) : (
            <div className="h-[220px] w-full">
              <ResponsiveContainer>
                <BarChart data={data}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis dataKey="label" className="text-xs" />
                  <YAxis className="text-xs" />
                  <ReTooltip
                    formatter={(value: number, name: string) => {
                      if (name === "valor") return [formatBRL(value), "Valor"];
                      if (name === "skus") return [value, "SKUs"];
                      return [value, name];
                    }}
                    labelFormatter={(l) => `Ciclo ${l}`}
                    content={({ active, payload, label }) => {
                      if (!active || !payload?.length) return null;
                      const p = payload[0].payload as {
                        label: string;
                        total: number;
                        skus: number;
                        valor: number;
                      };
                      return (
                        <div className="rounded-md border bg-popover p-2 text-xs shadow-md">
                          <div className="font-medium mb-1">{label}</div>
                          <div>Total pedidos: {p.total}</div>
                          <div>SKUs: {p.skus}</div>
                          <div>Valor: {formatBRL(p.valor)}</div>
                        </div>
                      );
                    }}
                  />
                  <Bar dataKey="total" className="fill-primary" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      <Suspense fallback={<TabFallback />}>
        <AdminReposicaoHistorico />
      </Suspense>
    </div>
  );
}

// ============================================================================
// Shortcuts dialog
// ============================================================================

const SHORTCUTS: Array<{ key: string; label: string }> = [
  { key: "g", label: "Rodar geração manual" },
  { key: "e", label: "Exportar CSV da aba atual" },
  { key: "1", label: "Aba: Ciclo de hoje" },
  { key: "2", label: "Aba: Aplicar no Omie" },
  { key: "3", label: "Aba: Ciclos anteriores" },
  { key: "r", label: "Atualizar dados" },
  { key: "m", label: "Ativar/desativar modo revisão" },
  { key: "?", label: "Abrir esta lista" },
];

function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (b: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Keyboard className="h-5 w-5" /> Atalhos disponíveis
          </DialogTitle>
          <DialogDescription>
            Teclas rápidas do Cockpit. Não funcionam quando o foco está em um campo de texto.
          </DialogDescription>
        </DialogHeader>
        <div className="border rounded-md divide-y">
          {SHORTCUTS.map((s) => (
            <div key={s.key} className="flex items-center justify-between px-3 py-2 text-sm">
              <span>{s.label}</span>
              <kbd className="px-2 py-1 text-xs font-mono rounded bg-muted border">{s.key}</kbd>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================================
// Main page
// ============================================================================

export default function AdminReposicaoCockpit() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tabParam = params.get("tab");
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const {
    data: currentStep = 3,
    isLoading: isLoadingStep,
    isError: stepError,
    refetch: refetchStep,
    isFetching: isFetchingStep,
  } = useCurrentStep();

  const { data: itensDia = [], isLoading: isLoadingItens } = useItensDoDia();
  const { cols, update: updateCol } = useColumnConfig();

  const defaultTab: TabValue = currentStep === 4 ? "aplicaromie" : "ciclohoje";
  const tab: TabValue = (TAB_VALUES as readonly string[]).includes(tabParam ?? "")
    ? (tabParam as TabValue)
    : defaultTab;

  useEffect(() => {
    if (tabParam === "oportunidades") {
      navigate("/admin/reposicao/oportunidades", { replace: true });
    }
  }, [tabParam, navigate]);

  // Realtime
  useEffect(() => {
    const channel = supabase
      .channel("cockpit-reposicao-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "pedido_compra_sugerido" },
        () => {
          queryClient.invalidateQueries({ queryKey: ["cockpit-current-step"] });
          queryClient.invalidateQueries({ queryKey: ["cockpit-itens-dia"] });
          queryClient.invalidateQueries({ queryKey: ["cockpit-historico-chart"] });
          queryClient.invalidateQueries({ queryKey: ["reposicao-pedidos"] });
          queryClient.invalidateQueries({ queryKey: ["reposicao-aplicacao"] });
          queryClient.invalidateQueries({ queryKey: ["reposicao-historico"] });
          toast("Dados atualizados automaticamente", { duration: 1800 });
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "sku_parametros" },
        () => {
          queryClient.invalidateQueries({ queryKey: ["cockpit-current-step"] });
          queryClient.invalidateQueries({ queryKey: ["reposicao-aplicacao"] });
          toast("Dados atualizados automaticamente", { duration: 1800 });
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient]);

  const handleTab = useCallback(
    (v: string) => {
      const next = new URLSearchParams(params);
      next.set("tab", v);
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  const handleStepClick = (step: number) => {
    switch (step) {
      case 1:
        navigate("/admin/reposicao/oportunidades");
        break;
      case 2:
        navigate("/admin/reposicao/parametros");
        break;
      case 3:
        handleTab("ciclohoje");
        break;
      case 4:
        handleTab("aplicaromie");
        break;
      case 5:
        handleTab("ciclohoje");
        break;
    }
  };

  // Filtros + review mode (compartilhados com a aba ciclohoje)
  const [reviewMode, setReviewMode] = useState(false);
  const [filters, setFilters] = useState({ search: "", fornecedor: ALL, status: ALL });

  const fornecedores = useMemo(
    () =>
      Array.from(new Set(itensDia.map((i) => i.fornecedor_nome).filter((x): x is string => !!x))).sort(),
    [itensDia],
  );
  const statuses = useMemo(
    () => Array.from(new Set(itensDia.map((i) => i.status).filter((x): x is string => !!x))).sort(),
    [itensDia],
  );

  const filteredItems = useMemo(() => {
    const q = filters.search.trim().toLowerCase();
    return itensDia.filter((i) => {
      if (filters.fornecedor !== ALL && i.fornecedor_nome !== filters.fornecedor) return false;
      if (filters.status !== ALL && i.status !== filters.status) return false;
      if (q) {
        const hay = [i.fornecedor_nome, i.grupo_codigo, i.status]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [itensDia, filters]);

  // ------ Export CSV --------------------------------------------------------
  const [isExporting, setIsExporting] = useState(false);

  const handleExportCsv = async () => {
    if (isExporting) return;
    setIsExporting(true);
    const today = format(new Date(), "yyyy-MM-dd");
    const filename = `cockpit-${tab}-${today}.csv`;
    try {
      if (tab === "ciclohoje") {
        const rows = filteredItems.map((r) => [
          r.grupo_codigo ?? "",
          r.fornecedor_nome ?? "",
          r.fornecedor_nome ?? "",
          r.num_skus ?? 0,
          r.aprovado_em ? r.num_skus ?? 0 : 0,
          r.status ?? "",
        ]);
        downloadCsv(
          filename,
          ["SKU", "Descrição", "Fornecedor", "Qtd sugerida", "Qtd aprovada", "Status"],
          rows,
        );
      } else if (tab === "aplicaromie") {
        const { data, error } = await supabase
          .from("sku_parametros" as any)
          .select(
            "sku_codigo_omie,sku_descricao,estoque_minimo,estoque_minimo_omie,aplicar_no_omie,ultima_aplicacao_omie",
          )
          .eq("empresa", EMPRESA)
          .eq("ativo", true);
        if (error) throw error;
        const rows = (((data ?? []) as unknown) as Array<{
          sku_codigo_omie: number | null;
          sku_descricao: string | null;
          estoque_minimo: number | null;
          estoque_minimo_omie: number | null;
          aplicar_no_omie: boolean | null;
          ultima_aplicacao_omie: string | null;
        }>).map((r) => [
          r.sku_codigo_omie ?? "",
          r.sku_descricao ?? "",
          "estoque_minimo",
          r.estoque_minimo_omie ?? "",
          r.estoque_minimo ?? "",
          r.ultima_aplicacao_omie
            ? "aplicado"
            : r.aplicar_no_omie
              ? "pronto_para_aplicar"
              : "pendente",
        ]);
        downloadCsv(
          filename,
          ["SKU", "Descrição", "Parâmetro", "Valor atual", "Valor novo", "Status"],
          rows,
        );
      } else {
        const fim = new Date();
        const inicio = subDays(fim, 29);
        const { data, error } = await supabase
          .from("pedido_compra_sugerido" as any)
          .select("data_ciclo,num_skus,valor_total,status")
          .eq("empresa", EMPRESA)
          .gte("data_ciclo", format(inicio, "yyyy-MM-dd"))
          .lte("data_ciclo", format(fim, "yyyy-MM-dd"));
        if (error) throw error;
        const map = new Map<string, { skus: number; valor: number; statuses: Set<string> }>();
        for (const r of (((data ?? []) as unknown) as Array<{
          data_ciclo: string;
          num_skus: number | null;
          valor_total: number | null;
          status: string | null;
        }>)) {
          const acc = map.get(r.data_ciclo) ?? { skus: 0, valor: 0, statuses: new Set<string>() };
          acc.skus += Number(r.num_skus ?? 0);
          acc.valor += Number(r.valor_total ?? 0);
          if (r.status) acc.statuses.add(r.status);
          map.set(r.data_ciclo, acc);
        }
        const rows = Array.from(map.entries())
          .sort((a, b) => b[0].localeCompare(a[0]))
          .map(([data, v]) => [
            formatDate(data),
            v.skus,
            v.valor.toFixed(2).replace(".", ","),
            Array.from(v.statuses).join(","),
          ]);
        downloadCsv(filename, ["Data", "SKUs", "Total pedido", "Status"], rows);
      }
      await logAudit({
        userId: user?.id ?? null,
        action: "CSV exportado",
        result: "Sucesso",
        metadata: { tab, filename },
      });
      toast.success("CSV exportado");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logAudit({
        userId: user?.id ?? null,
        action: "CSV exportado",
        result: `Erro: ${msg}`,
        metadata: { tab },
      });
      toast.error("Falha ao exportar CSV");
    } finally {
      setIsExporting(false);
    }
  };

  // ------ Manual generation -------------------------------------------------
  const [isGenerating, setIsGenerating] = useState(false);
  const handleGenerate = async () => {
    if (isGenerating) return;
    setIsGenerating(true);
    try {
      const { error } = await supabase.functions.invoke("gerar-pedidos-diario", {
        body: { empresa: EMPRESA, manual: true },
      });
      if (error) throw error;
      await logAudit({
        userId: user?.id ?? null,
        action: "Geração manual",
        result: "Sucesso",
      });
      toast.success("Geração disparada");
      queryClient.invalidateQueries({ queryKey: ["cockpit-itens-dia"] });
      queryClient.invalidateQueries({ queryKey: ["cockpit-current-step"] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logAudit({
        userId: user?.id ?? null,
        action: "Geração manual",
        result: `Erro: ${msg}`,
      });
      toast.error("Falha na geração manual");
    } finally {
      setIsGenerating(false);
    }
  };

  const handleRefetchAll = () => {
    queryClient.invalidateQueries({ queryKey: ["cockpit-itens-dia"] });
    queryClient.invalidateQueries({ queryKey: ["cockpit-current-step"] });
    queryClient.invalidateQueries({ queryKey: ["cockpit-historico-chart"] });
    queryClient.invalidateQueries({ queryKey: ["reposicao-pedidos"] });
    queryClient.invalidateQueries({ queryKey: ["reposicao-aplicacao"] });
    queryClient.invalidateQueries({ queryKey: ["reposicao-historico"] });
    toast("Atualizando...", { duration: 1200 });
  };

  // ------ PDF (window.print) -----------------------------------------------
  const handlePrintPdf = () => {
    const today = format(new Date(), "yyyy-MM-dd");
    const styleId = "__cockpit_print_style__";
    let style = document.getElementById(styleId) as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement("style");
      style.id = styleId;
      style.media = "print";
      document.head.appendChild(style);
    }
    style.innerHTML = `
      @page { margin: 16mm; }
      body * { visibility: hidden !important; }
      #cockpit-print-area, #cockpit-print-area * { visibility: visible !important; }
      #cockpit-print-area {
        position: absolute !important;
        left: 0; top: 0; width: 100%;
        background: white; color: black;
        padding: 12px 20px;
        font-family: Inter, system-ui, sans-serif;
        font-size: 12px;
      }
      #cockpit-print-area h1 { font-size: 18px; margin: 0 0 4px; }
      #cockpit-print-area .meta { color: #555; font-size: 11px; margin-bottom: 12px; }
      #cockpit-print-area table { width: 100%; border-collapse: collapse; }
      #cockpit-print-area th, #cockpit-print-area td {
        border: 1px solid #ccc; padding: 4px 6px; text-align: left;
      }
      #cockpit-print-area th { background: #f3f4f6; font-weight: 600; }
      #cockpit-print-area .right { text-align: right; }
      #cockpit-print-area .footer { margin-top: 12px; font-size: 10px; color: #777; text-align: right; }
    `;

    const existing = document.getElementById("cockpit-print-area");
    if (existing) existing.remove();
    const area = document.createElement("div");
    area.id = "cockpit-print-area";
    const rowsHtml = filteredItems
      .map(
        (r) => `<tr>
        <td>${r.grupo_codigo ?? "—"}</td>
        <td>${r.fornecedor_nome ?? "—"}</td>
        <td class="right">${r.num_skus ?? 0}</td>
        <td class="right">${r.aprovado_em ? (r.num_skus ?? 0) : ""}</td>
        <td class="right">${formatBRL(r.valor_total)}</td>
        <td>${r.status ?? "—"}</td>
      </tr>`,
      )
      .join("");
    area.innerHTML = `
      <h1>COLACOR — Cockpit de Reposição</h1>
      <div class="meta">Ciclo: ${formatDate(today)} · ${filteredItems.length} pedido(s)</div>
      <table>
        <thead>
          <tr>
            <th>SKU/Grupo</th><th>Fornecedor</th>
            <th class="right">Qtd sugerida</th><th class="right">Qtd aprovada</th>
            <th class="right">Valor</th><th>Status</th>
          </tr>
        </thead>
        <tbody>${rowsHtml || `<tr><td colspan="6" style="text-align:center;color:#777">Sem itens</td></tr>`}</tbody>
      </table>
      <div class="footer">Gerado em ${new Date().toLocaleString("pt-BR")}</div>
    `;
    document.body.appendChild(area);

    const cleanup = () => {
      area.remove();
      window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup);
    setTimeout(() => window.print(), 50);

    logAudit({
      userId: user?.id ?? null,
      action: "PDF gerado",
      result: "Sucesso",
      metadata: { count: filteredItems.length },
    });
  };
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  useKeyboardShortcuts({
    g: () => handleGenerate(),
    e: () => handleExportCsv(),
    "1": () => handleTab("ciclohoje"),
    "2": () => handleTab("aplicaromie"),
    "3": () => handleTab("anteriores"),
    r: () => handleRefetchAll(),
    m: () => setReviewMode(!reviewMode),
    "?": () => setShortcutsOpen(true),
  });

  return (
    <div className="container mx-auto p-4 sm:p-6 space-y-6 max-w-7xl pb-24">
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <Sparkles className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Cockpit de Reposição</h1>
            <p className="text-sm text-muted-foreground">
              Todo o ciclo diário de compras em uma única tela
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShortcutsOpen(true)}
            title="Atalhos de teclado (?)"
          >
            <Keyboard className="h-4 w-4" />
          </Button>
          <Button size="sm" variant="outline" onClick={handleRefetchAll} title="Atualizar (R)">
            <RotateCw className="h-4 w-4 mr-1.5" /> Atualizar
          </Button>
          <Button size="sm" onClick={handleGenerate} disabled={isGenerating} title="Gerar (G)">
            {isGenerating ? (
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4 mr-1.5" />
            )}
            Gerar agora
          </Button>
        </div>
      </header>

      {stepError && (
        <Alert variant="default" className="border-amber-500/40 bg-amber-500/5">
          <AlertTriangle className="h-4 w-4 text-amber-600" />
          <AlertTitle>Etapa atual indisponível</AlertTitle>
          <AlertDescription className="flex items-center justify-between gap-3 flex-wrap">
            <span>Não foi possível calcular a etapa atual. Exibindo dados em cache.</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => refetchStep()}
              disabled={isFetchingStep}
            >
              {isFetchingStep ? (
                <>
                  <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
                  Tentando...
                </>
              ) : (
                "Tentar novamente"
              )}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <SmartAlertsSection />

      <ProcessoComprasStepper
        currentStep={currentStep}
        onStepClick={handleStepClick}
        isLoading={isLoadingStep}
      />

      <MetricsStrip items={itensDia} />

      <Tabs value={tab} onValueChange={handleTab} className="space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <TabsList className="grid grid-cols-3 w-full sm:w-auto">
            <TabsTrigger value="ciclohoje">Ciclo de hoje</TabsTrigger>
            <TabsTrigger value="aplicaromie">Aplicar no Omie</TabsTrigger>
            <TabsTrigger value="anteriores">Ciclos anteriores</TabsTrigger>
          </TabsList>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={handleExportCsv} disabled={isExporting}>
              {isExporting ? (
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              ) : (
                <Download className="h-4 w-4 mr-1.5" />
              )}
              Exportar CSV
            </Button>
            <Button size="sm" variant="outline" onClick={handlePrintPdf}>
              <Printer className="h-4 w-4 mr-1.5" /> PDF
            </Button>
          </div>
        </div>

        <TabsContent value="ciclohoje" className="m-0">
          <CicloHojePanel
            user={user}
            reviewMode={reviewMode}
            setReviewMode={setReviewMode}
            filters={filters}
            setFilters={setFilters}
            filteredItems={filteredItems}
            fornecedores={fornecedores}
            statuses={statuses}
            isLoading={isLoadingItens}
            cols={cols}
            onColChange={updateCol}
          />
        </TabsContent>

        <TabsContent value="aplicaromie" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <AdminReposicaoAplicacao />
          </Suspense>
        </TabsContent>

        <TabsContent value="anteriores" className="m-0">
          <HistoricoComChart />
        </TabsContent>
      </Tabs>

      <AuditLogSection />

      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </div>
  );
}
