import { useState, useMemo, Fragment, useEffect } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useIsTouchDevice } from "@/hooks/useIsTouchDevice";
import { shouldRedirectToMobile, getForceFullPref, setForceFull } from "@/lib/picking/view-pref";
import { supabase } from "@/integrations/supabase/client";
import {
  Boxes,
  Loader2,
  ClipboardList,
  Clock,
  AlertTriangle,
  ShieldCheck,
  Building2,
  ChevronDown,
  ChevronRight,
  Search,
  Smartphone,
  Send,
  PackagePlus,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import { ScanBar } from "@/components/picking/ScanBar";
import { EmptyState } from "@/components/EmptyState";
import { usePedidosASeparar } from "@/queries/usePedidosASeparar";
import { useEnviarParaSeparacao } from "@/queries/useEnviarParaSeparacao";

const truncate = (s: string | null | undefined, n = 8) =>
  s ? s.slice(0, n) : "—";

const fmtDate = (v: string | null | undefined) =>
  v ? new Date(v).toLocaleString("pt-BR") : "—";

const fmtBRL = (v: number | null | undefined) =>
  Number(v ?? 0).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });

function StatusBadge({ status }: { status: string | null }) {
  const map: Record<string, string> = {
    pendente: "bg-warning/15 text-warning border-warning/40",
    em_andamento: "bg-primary/15 text-primary border-primary/40",
    concluido: "bg-success/15 text-success border-success/40",
  };
  const cls = map[status ?? ""] ?? "bg-muted text-muted-foreground border-border";
  return (
    <Badge variant="outline" className={cls}>
      {status ?? "—"}
    </Badge>
  );
}

/* ─── KPIs ─── */
function KpiCards({ account }: { account: string }) {
  const { data: tasksAbertas } = useQuery({
    queryKey: ["pk-tasks-abertas", account],
    queryFn: async () => {
      const { count } = await supabase
        .from("picking_tasks")
        .select("*", { count: "exact", head: true })
        .eq("account", account.toLowerCase())
        .in("status", ["pendente", "em_andamento"]);
      return count ?? 0;
    },
    refetchInterval: 60000,
  });

  const { data: pedidosAguardando } = useQuery({
    queryKey: ["pk-pedidos-aguardando", account],
    queryFn: async () => {
      const { count } = await supabase
        .from("picking_tasks")
        .select("*", { count: "exact", head: true })
        .eq("account", account.toLowerCase())
        .eq("status", "pendente");
      return count ?? 0;
    },
    refetchInterval: 60000,
  });

  const { data: skusCriticos } = useQuery({
    queryKey: ["pk-skus-criticos", account],
    queryFn: async () => {
      const { count } = await supabase
        .from("inventory_position")
        .select("*", { count: "exact", head: true })
        .eq("account", account)
        .lte("saldo", 0);
      return count ?? 0;
    },
    refetchInterval: 60000,
  });

  const { data: fefoCompliance } = useQuery({
    queryKey: ["pk-fefo-compliance", account],
    queryFn: async () => {
      const { data: tasks } = await supabase
        .from("picking_tasks")
        .select("id")
        .eq("account", account.toLowerCase());
      const ids = (tasks ?? []).map((t) => t.id);
      if (!ids.length) return { pct: 0, total: 0, ok: 0 };
      const { data: items } = await supabase
        .from("picking_task_items")
        .select("lote_fefo, lote_separado")
        .in("picking_task_id", ids)
        .not("lote_separado", "is", null);
      const total = (items ?? []).length;
      const ok = (items ?? []).filter(
        (i) => i.lote_fefo && i.lote_separado && i.lote_fefo === i.lote_separado,
      ).length;
      return { pct: total ? (ok / total) * 100 : 0, total, ok };
    },
    refetchInterval: 60000,
  });

  const cards = [
    {
      label: "Tasks Abertas",
      value: tasksAbertas ?? 0,
      icon: ClipboardList,
      tone: (tasksAbertas ?? 0) > 0 ? "text-primary" : "text-muted-foreground",
      border: (tasksAbertas ?? 0) > 0 ? "border-primary/40" : "border-border",
    },
    {
      label: "Pedidos Aguardando",
      value: pedidosAguardando ?? 0,
      icon: Clock,
      tone:
        (pedidosAguardando ?? 0) > 0 ? "text-warning" : "text-muted-foreground",
      border:
        (pedidosAguardando ?? 0) > 0 ? "border-warning/40" : "border-border",
    },
    {
      label: "SKUs Críticos",
      value: skusCriticos ?? 0,
      icon: AlertTriangle,
      tone:
        (skusCriticos ?? 0) > 0 ? "text-destructive" : "text-muted-foreground",
      border:
        (skusCriticos ?? 0) > 0 ? "border-destructive/40" : "border-border",
    },
    {
      label: "FEFO Compliance",
      value: `${(fefoCompliance?.pct ?? 0).toFixed(1)}%`,
      icon: ShieldCheck,
      tone:
        (fefoCompliance?.pct ?? 0) >= 90
          ? "text-success"
          : (fefoCompliance?.pct ?? 0) >= 70
            ? "text-warning"
            : "text-destructive",
      border:
        (fefoCompliance?.pct ?? 0) >= 90
          ? "border-success/40"
          : "border-border",
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map((c) => (
        <Card key={c.label} className={c.border}>
          <CardContent className="pt-4 flex items-center justify-between">
            <div>
              <div className="text-xs text-muted-foreground">{c.label}</div>
              <div className={`text-2xl font-bold mt-1 ${c.tone}`}>
                {c.value}
              </div>
            </div>
            <c.icon className={`h-8 w-8 ${c.tone} opacity-60`} />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/* ─── Pedidos a separar tab ─── */
function PedidosASepararTab({ account }: { account: string }) {
  const { data, isLoading } = usePedidosASeparar(account);
  const enviar = useEnviarParaSeparacao();
  const [sendingId, setSendingId] = useState<string | null>(null);

  const handleEnviar = (id: string) => {
    setSendingId(id);
    enviar.mutate(id, {
      onSuccess: (r) =>
        toast.success(r.created ? "Pedido enviado para separação" : "Pedido já estava em separação"),
      onError: (e: Error) => toast.error(`Falha ao enviar: ${e.message}`),
      onSettled: () => setSendingId(null),
    });
  };

  if (isLoading)
    return (
      <div className="flex justify-center py-12 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" /> Carregando...
      </div>
    );

  const pedidos = data ?? [];

  return (
    <div className="space-y-3">
      <p className="text-xs text-warning flex items-center gap-1.5">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        O status vem do Omie e pode estar desatualizado — confira o pedido antes de enviar.
      </p>
      <Card>
        <CardContent className="p-0">
          {pedidos.length === 0 ? (
            <EmptyState
              icon={PackagePlus}
              tone="operational"
              title="Nenhum pedido aguardando separação"
              description="Pedidos recentes da Oben sem task de separação aparecem aqui."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Cliente</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead>Status (Omie)</TableHead>
                  <TableHead>Data</TableHead>
                  <TableHead className="text-right">Itens</TableHead>
                  <TableHead className="text-right">Ação</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pedidos.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="text-sm">{p.customerName}</TableCell>
                    <TableCell className="text-right text-xs">{fmtBRL(p.total)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{p.status}</TableCell>
                    <TableCell className="text-xs font-tabular">
                      {p.data ? p.data.split("-").reverse().join("/") : "—"}
                    </TableCell>
                    <TableCell className="text-right text-xs">
                      {p.itemCount}
                      {p.hasFractional && (
                        <Badge variant="outline" className="ml-1 bg-warning/15 text-warning border-warning/40">
                          frac
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        className="gap-1.5"
                        disabled={enviar.isPending && sendingId === p.id}
                        onClick={() => handleEnviar(p.id)}
                      >
                        <Send className="h-3.5 w-3.5" />
                        {enviar.isPending && sendingId === p.id ? "Enviando..." : "Enviar para separação"}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ─── Picking tab ─── */
function PickingTab({ account }: { account: string }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [lastScan, setLastScan] = useState<{ raw: string; kind: string; method: string; at: number } | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["pk-picking-list", account],
    queryFn: async () => {
      const { data } = await supabase
        .from("picking_tasks")
        .select("id, sales_order_id, status, assigned_to, created_at")
        .eq("account", account.toLowerCase())
        .order("created_at", { ascending: false })
        .limit(200);
      return data ?? [];
    },
  });

  const { data: items } = useQuery({
    queryKey: ["pk-picking-items", expanded],
    enabled: !!expanded,
    queryFn: async () => {
      const { data } = await supabase
        .from("picking_task_items")
        .select(
          "id, product_descricao, quantidade, quantidade_separada, status, lote_fefo, lote_separado",
        )
        .eq("picking_task_id", expanded ?? "");
      return data ?? [];
    },
  });

  // Handler de scan — v1: registra o último bipe e mostra feedback. A integração com a task ativa
  // (auto-foco no item correspondente, optimistic update) virá quando #19 (TouchPickingView) for
  // implementado a fundo. Hoje serve como hook + canal de feedback ao separador.
  const handleScan = (result: { raw: string; kind: 'address' | 'sku'; method: 'wedge' | 'manual' }) => {
    setLastScan({ raw: result.raw, kind: result.kind, method: result.method, at: Date.now() });
    // Latência alvo <100ms — toast com kind detectado
    toast.success(
      result.kind === 'address' ? `Endereço: ${result.raw}` : `Produto: ${result.raw}`,
      { description: result.method === 'wedge' ? 'Lido por scanner' : 'Digitado', duration: 1500 },
    );
  };

  if (isLoading)
    return (
      <div className="flex justify-center py-12 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" /> Carregando...
      </div>
    );

  return (
    <div className="space-y-4">
      <ScanBar onScan={handleScan} />
      {lastScan && (
        <div className="text-xs text-muted-foreground px-1">
          Último bipe: <span className="font-mono text-foreground">{lastScan.raw}</span> ({lastScan.kind}) — {new Date(lastScan.at).toLocaleTimeString('pt-BR')}
        </div>
      )}
      <Card>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>ID</TableHead>
              <TableHead>Pedido</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Responsável</TableHead>
              <TableHead>Criado</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                  Nenhuma task de picking.
                </TableCell>
              </TableRow>
            )}
            {(data ?? []).map((t) => (
              <Fragment key={t.id}>
                <TableRow key={t.id}>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => setExpanded(expanded === t.id ? null : t.id)}
                    >
                      {expanded === t.id ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                    </Button>
                  </TableCell>
                  <TableCell className="font-tabular text-xs">{truncate(t.id)}</TableCell>
                  <TableCell className="font-tabular text-xs">{truncate(t.sales_order_id)}</TableCell>
                  <TableCell><StatusBadge status={t.status} /></TableCell>
                  <TableCell className="font-tabular text-xs">{truncate(t.assigned_to)}</TableCell>
                  <TableCell className="text-xs">{fmtDate(t.created_at)}</TableCell>
                </TableRow>
                {expanded === t.id && (
                  <TableRow>
                    <TableCell colSpan={6} className="bg-muted/30 p-4">
                      {!items ? (
                        <div className="text-sm text-muted-foreground">Carregando itens...</div>
                      ) : items.length === 0 ? (
                        <div className="text-sm text-muted-foreground">Sem itens.</div>
                      ) : (
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Produto</TableHead>
                              <TableHead className="text-right">Qtd</TableHead>
                              <TableHead className="text-right">Separada</TableHead>
                              <TableHead>Status</TableHead>
                              <TableHead>Lote FEFO</TableHead>
                              <TableHead>Lote Separado</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {items.map((it) => (
                              <TableRow key={it.id}>
                                <TableCell className="text-xs">{it.product_descricao}</TableCell>
                                <TableCell className="text-right text-xs">{it.quantidade}</TableCell>
                                <TableCell className="text-right text-xs">{it.quantidade_separada ?? 0}</TableCell>
                                <TableCell><StatusBadge status={it.status} /></TableCell>
                                <TableCell className="font-tabular text-xs">{it.lote_fefo ?? "—"}</TableCell>
                                <TableCell className="font-tabular text-xs">
                                  {it.lote_separado ? (
                                    <span className={it.lote_separado !== it.lote_fefo ? "text-warning" : ""}>
                                      {it.lote_separado}
                                    </span>
                                  ) : "—"}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      )}
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
    </div>
  );
}

/* ─── Estoque tab ─── */
function EstoqueTab({ account }: { account: string }) {
  const [search, setSearch] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["pk-inventory", account],
    queryFn: async () => {
      const { data } = await supabase
        .from("inventory_position")
        .select("omie_codigo_produto, saldo, cmc, preco_medio, synced_at")
        .eq("account", account)
        .order("saldo", { ascending: true })
        .limit(500);
      return data ?? [];
    },
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return data ?? [];
    return (data ?? []).filter((r) =>
      String(r.omie_codigo_produto ?? "").toLowerCase().includes(q),
    );
  }, [data, search]);

  return (
    <Card>
      <CardContent className="p-4 space-y-4">
        <div className="relative max-w-sm">
          <Search className="h-4 w-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por código..."
            className="pl-8"
          />
        </div>
        {isLoading ? (
          <div className="flex justify-center py-8 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mr-2" /> Carregando...
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Código Omie</TableHead>
                <TableHead className="text-right">Saldo</TableHead>
                <TableHead className="text-right">CMC</TableHead>
                <TableHead className="text-right">Preço Médio</TableHead>
                <TableHead>Sincronizado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                    Nenhum SKU encontrado.
                  </TableCell>
                </TableRow>
              )}
              {filtered.map((r) => (
                <TableRow key={r.omie_codigo_produto}>
                  <TableCell className="font-tabular text-xs">{r.omie_codigo_produto}</TableCell>
                  <TableCell className="text-right">
                    {Number(r.saldo) <= 0 ? (
                      <Badge variant="outline" className="bg-destructive/15 text-destructive border-destructive/40">
                        {Number(r.saldo).toFixed(2)}
                      </Badge>
                    ) : (
                      <span>{Number(r.saldo).toFixed(2)}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right text-xs">{fmtBRL(r.cmc)}</TableCell>
                  <TableCell className="text-right text-xs">{fmtBRL(r.preco_medio)}</TableCell>
                  <TableCell className="text-xs">{fmtDate(r.synced_at)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

/* ─── Movimentações tab ─── */
function MovimentacoesTab() {
  const { data, isLoading } = useQuery({
    queryKey: ["pk-events"],
    queryFn: async () => {
      const { data } = await supabase
        .from("picking_events")
        .select("id, event_type, picking_task_id, lote_esperado, lote_informado, justificativa, created_at")
        .order("created_at", { ascending: false })
        .limit(300);
      return data ?? [];
    },
  });

  if (isLoading)
    return (
      <div className="flex justify-center py-12 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" /> Carregando...
      </div>
    );

  return (
    <Card>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Evento</TableHead>
              <TableHead>Task</TableHead>
              <TableHead>Lote Esperado</TableHead>
              <TableHead>Lote Informado</TableHead>
              <TableHead>Justificativa</TableHead>
              <TableHead>Quando</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                  Sem movimentações.
                </TableCell>
              </TableRow>
            )}
            {(data ?? []).map((e) => (
              <TableRow key={e.id}>
                <TableCell className="text-xs"><Badge variant="outline">{e.event_type}</Badge></TableCell>
                <TableCell className="font-tabular text-xs">{truncate(e.picking_task_id)}</TableCell>
                <TableCell className="font-tabular text-xs">{e.lote_esperado ?? "—"}</TableCell>
                <TableCell className="font-tabular text-xs">
                  {e.lote_informado ? (
                    <span className={e.lote_esperado && e.lote_informado !== e.lote_esperado ? "text-warning" : ""}>
                      {e.lote_informado}
                    </span>
                  ) : "—"}
                </TableCell>
                <TableCell className="text-xs max-w-[280px] truncate">{e.justificativa ?? "—"}</TableCell>
                <TableCell className="text-xs">{fmtDate(e.created_at)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/* ─── Auditoria tab ─── */
function AuditoriaTab({ account }: { account: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["pk-auditoria", account],
    queryFn: async () => {
      const { data: tasks } = await supabase
        .from("picking_tasks")
        .select("id, sales_order_id, completed_at, notes")
        .eq("account", account.toLowerCase())
        .eq("status", "concluido")
        .order("completed_at", { ascending: false })
        .limit(200);
      const ids = (tasks ?? []).map((t) => t.id);
      const divCount: Record<string, number> = {};
      if (ids.length) {
        const { data: items } = await supabase
          .from("picking_task_items")
          .select("picking_task_id, lote_fefo, lote_separado, quantidade, quantidade_separada")
          .in("picking_task_id", ids);
        for (const it of items ?? []) {
          const isDiv =
            (it.lote_separado && it.lote_fefo && it.lote_separado !== it.lote_fefo) ||
            (it.quantidade_separada ?? 0) !== (it.quantidade ?? 0);
          if (isDiv) {
            divCount[it.picking_task_id] = (divCount[it.picking_task_id] ?? 0) + 1;
          }
        }
      }
      return (tasks ?? []).map((t) => ({ ...t, divergencias: divCount[t.id] ?? 0 }));
    },
  });

  if (isLoading)
    return (
      <div className="flex justify-center py-12 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" /> Carregando...
      </div>
    );

  return (
    <Card>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Task</TableHead>
              <TableHead>Pedido</TableHead>
              <TableHead>Concluído</TableHead>
              <TableHead className="text-right">Divergências</TableHead>
              <TableHead>Notas</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                  Nenhuma task concluída.
                </TableCell>
              </TableRow>
            )}
            {(data ?? []).map((t) => (
              <TableRow key={t.id}>
                <TableCell className="font-tabular text-xs">{truncate(t.id)}</TableCell>
                <TableCell className="font-tabular text-xs">{truncate(t.sales_order_id)}</TableCell>
                <TableCell className="text-xs">{fmtDate(t.completed_at)}</TableCell>
                <TableCell className="text-right">
                  {t.divergencias > 0 ? (
                    <Badge variant="outline" className="bg-warning/15 text-warning border-warning/40">
                      {t.divergencias}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="bg-success/15 text-success border-success/40">0</Badge>
                  )}
                </TableCell>
                <TableCell className="text-xs max-w-[320px] truncate">{t.notes ?? "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export default function AdminEstoquePicking() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const isTouch = useIsTouchDevice();
  const tab = params.get("tab") ?? "a-separar";
  const [account, setAccount] = useState("OBEN");

  // Separador touch cai direto na visão de chão (salvo override "ver versão completa").
  useEffect(() => {
    if (shouldRedirectToMobile({ isTouch, forceFull: getForceFullPref() })) {
      navigate('/admin/estoque/picking/mobile', { replace: true });
    }
  }, [isTouch, navigate]);

  const handleTab = (v: string) => {
    const next = new URLSearchParams(params);
    next.set("tab", v);
    setParams(next, { replace: true });
  };

  return (
    <div className="container mx-auto p-4 sm:p-6 space-y-6 max-w-7xl">
      <header className="flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
        <div className="flex items-center gap-3">
          <Boxes className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Picking & Estoque</h1>
            <p className="text-sm text-muted-foreground">
              Separação de pedidos, posição de inventário e auditoria de movimentações.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-muted-foreground"
            onClick={() => { setForceFull(false); navigate('/admin/estoque/picking/mobile'); }}
          >
            <Smartphone className="h-4 w-4" />
            <span className="hidden sm:inline">Versão de chão</span>
          </Button>
          <Building2 className="h-4 w-4 text-muted-foreground" />
          <Select value={account} onValueChange={setAccount}>
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="Account" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="OBEN">OBEN</SelectItem>
              <SelectItem value="COLACOR">COLACOR</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </header>

      <KpiCards account={account} />

      <Tabs value={tab} onValueChange={handleTab} className="space-y-4">
        <TabsList className="grid grid-cols-3 sm:grid-cols-5 w-full">
          <TabsTrigger value="a-separar">A separar</TabsTrigger>
          <TabsTrigger value="picking">Picking</TabsTrigger>
          <TabsTrigger value="estoque">Estoque</TabsTrigger>
          <TabsTrigger value="movimentacoes">Movimentações</TabsTrigger>
          <TabsTrigger value="auditoria">Auditoria</TabsTrigger>
        </TabsList>

        <TabsContent value="a-separar" className="m-0">
          <PedidosASepararTab account={account} />
        </TabsContent>
        <TabsContent value="picking" className="m-0">
          <PickingTab account={account} />
        </TabsContent>
        <TabsContent value="estoque" className="m-0">
          <EstoqueTab account={account} />
        </TabsContent>
        <TabsContent value="movimentacoes" className="m-0">
          <MovimentacoesTab />
        </TabsContent>
        <TabsContent value="auditoria" className="m-0">
          <AuditoriaTab account={account} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
