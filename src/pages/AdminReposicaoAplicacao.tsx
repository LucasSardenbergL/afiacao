import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { format, formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";
import {
  ArrowRight,
  RefreshCw,
  PlayCircle,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Clock,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const EMPRESA = "OBEN";

type FilaItem = {
  id: number;
  empresa: string;
  sku_codigo_omie: string;
  sku_descricao: string | null;
  estoque_minimo_novo: number | null;
  ponto_pedido_novo: number | null;
  estoque_maximo_novo: number | null;
  estoque_minimo_omie_atual: number | null;
  ponto_pedido_omie_atual: number | null;
  estoque_maximo_omie_atual: number | null;
  status_validacao: string;
  mensagem_bloqueio: string | null;
  delta_max_perc: number | null;
  aplicado_em: string | null;
  resposta_omie: any;
  erro_omie: string | null;
  criado_em: string;
};

function deltaPct(novo: number | null, atual: number | null): number | null {
  if (novo == null) return null;
  if (atual == null || atual === 0) return null;
  return ((novo - atual) / atual) * 100;
}

function DeltaArrow({ novo, atual }: { novo: number | null; atual: number | null }) {
  const pct = deltaPct(novo, atual);
  return (
    <div className="flex items-center gap-1 text-xs whitespace-nowrap">
      <span className="text-muted-foreground">{atual ?? "—"}</span>
      <ArrowRight className="h-3 w-3 text-muted-foreground" />
      <span className="font-medium">{novo ?? "—"}</span>
      {pct != null && (
        <span
          className={
            Math.abs(pct) > 25
              ? "text-destructive ml-1"
              : Math.abs(pct) > 10
              ? "text-warning ml-1"
              : "text-muted-foreground ml-1"
          }
        >
          ({pct > 0 ? "+" : ""}
          {pct.toFixed(0)}%)
        </span>
      )}
    </div>
  );
}

export default function AdminReposicaoAplicacao() {
  const qc = useQueryClient();
  const [tab, setTab] = useState("pronto");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [deltaFilter, setDeltaFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [substituicaoOpen, setSubstituicaoOpen] = useState<FilaItem | null>(null);
  const [confirmLote, setConfirmLote] = useState<{ ids: number[]; maxDelta: number } | null>(null);
  const [confirmIndividual, setConfirmIndividual] = useState<FilaItem | null>(null);

  // Última sincronização Omie
  const { data: ultimoSync } = useQuery({
    queryKey: ["sku-status-omie-ultimo-sync", EMPRESA],
    queryFn: async () => {
      const { data } = await supabase
        .from("sku_status_omie")
        .select("ultima_sincronizacao")
        .eq("empresa", EMPRESA)
        .order("ultima_sincronizacao", { ascending: false })
        .limit(1)
        .maybeSingle();
      return data?.ultima_sincronizacao ?? null;
    },
    refetchInterval: 60000,
  });

  // Contadores de cada aba
  const { data: contadores } = useQuery({
    queryKey: ["fila-aplicacao-contadores", EMPRESA],
    queryFn: async () => {
      const { data } = await (supabase as any)
        .from("fila_aplicacao_omie")
        .select("status_validacao, aplicado_em")
        .eq("empresa", EMPRESA);
      const c = { pronto: 0, inativo: 0, substituicao: 0, aplicado: 0 };
      (data ?? []).forEach((r: any) => {
        if (r.aplicado_em) c.aplicado++;
        else if (r.status_validacao === "pronto") c.pronto++;
        else if (r.status_validacao === "bloqueado_inativo") c.inativo++;
        else if (r.status_validacao === "bloqueado_substituicao") c.substituicao++;
      });
      return c;
    },
    refetchInterval: 30000,
  });

  // Listagens por aba
  const { data: itens, isLoading } = useQuery({
    queryKey: ["fila-aplicacao", EMPRESA, tab],
    queryFn: async () => {
      let q: any = (supabase as any).from("fila_aplicacao_omie").select("*").eq("empresa", EMPRESA);
      if (tab === "pronto") q = q.eq("status_validacao", "pronto").is("aplicado_em", null);
      else if (tab === "inativo")
        q = q.eq("status_validacao", "bloqueado_inativo").is("aplicado_em", null);
      else if (tab === "substituicao")
        q = q.eq("status_validacao", "bloqueado_substituicao").is("aplicado_em", null);
      else if (tab === "aplicado")
        q = q
          .not("aplicado_em", "is", null)
          .gte("aplicado_em", new Date(Date.now() - 30 * 86400000).toISOString())
          .order("aplicado_em", { ascending: false });
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as FilaItem[];
    },
    refetchInterval: tab === "aplicado" ? 60000 : 15000,
  });

  // Filtros adicionais (delta + busca) somente na aba "pronto"
  const filteredItens = useMemo(() => {
    if (!itens) return [];
    let arr = itens;
    if (search.trim()) {
      const s = search.toLowerCase();
      arr = arr.filter(
        (i) =>
          i.sku_codigo_omie.toLowerCase().includes(s) ||
          (i.sku_descricao ?? "").toLowerCase().includes(s)
      );
    }
    if (tab === "pronto" && deltaFilter !== "all") {
      arr = arr.filter((i) => {
        const d = i.delta_max_perc ?? 0;
        if (deltaFilter === "<10") return d < 10;
        if (deltaFilter === "10-25") return d >= 10 && d < 25;
        if (deltaFilter === "25-50") return d >= 25 && d < 50;
        if (deltaFilter === ">50") return d >= 50;
        return true;
      });
    }
    return arr;
  }, [itens, search, deltaFilter, tab]);

  const hasBloqueados = (contadores?.inativo ?? 0) + (contadores?.substituicao ?? 0) > 0;
  const syncDesatualizado =
    !ultimoSync || Date.now() - new Date(ultimoSync).getTime() > 24 * 3600 * 1000;

  // Mutations
  const gerarFila = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("gerar_fila_aplicacao_omie" as any, {
        p_empresa: EMPRESA,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (data: any) => {
      const r = Array.isArray(data) ? data[0] : data;
      toast.success(
        `Fila gerada: ${r?.prontos ?? 0} prontos, ${r?.bloqueados_inativos ?? 0} inativos, ${
          r?.bloqueados_substituicao ?? 0
        } com substituição`
      );
      qc.invalidateQueries({ queryKey: ["fila-aplicacao"] });
      qc.invalidateQueries({ queryKey: ["fila-aplicacao-contadores"] });
    },
    onError: (e: any) => toast.error("Falha ao gerar fila: " + e.message),
  });

  const sincronizarOmie = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("omie-sync-status-produtos", {
        body: { empresa: EMPRESA },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success("Sincronização Omie disparada");
      qc.invalidateQueries({ queryKey: ["sku-status-omie-ultimo-sync"] });
    },
    onError: (e: any) => toast.error("Falha no sync: " + e.message),
  });

  const aplicarIds = useMutation({
    mutationFn: async (ids: number[]) => {
      const { data, error } = await supabase.functions.invoke("omie-aplicar-parametros", {
        body: { empresa: EMPRESA, ids },
      });
      if (error) throw error;
      return data as { sucessos: number; falhas: number };
    },
    onSuccess: (r) => {
      toast.success(`Aplicados: ${r.sucessos} | Falhas: ${r.falhas}`);
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ["fila-aplicacao"] });
      qc.invalidateQueries({ queryKey: ["fila-aplicacao-contadores"] });
    },
    onError: (e: any) => toast.error("Falha ao aplicar: " + e.message),
  });

  const desativarSku = useMutation({
    mutationFn: async (sku: string) => {
      const { error } = await supabase
        .from("sku_parametros")
        .update({ aplicar_no_omie: false })
        .eq("empresa", EMPRESA)
        .eq("sku_codigo_omie", Number(sku));
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("SKU descadastrado do módulo");
      qc.invalidateQueries({ queryKey: ["fila-aplicacao"] });
      qc.invalidateQueries({ queryKey: ["fila-aplicacao-contadores"] });
    },
  });

  const handleAplicarLote = (ids: number[]) => {
    if (hasBloqueados) {
      toast.error("Resolva primeiro os SKUs bloqueados antes de aplicar em lote.");
      return;
    }
    const itensSel = (filteredItens ?? []).filter((i) => ids.includes(i.id));
    const maxDelta = Math.max(0, ...itensSel.map((i) => i.delta_max_perc ?? 0));
    if (maxDelta > 50) {
      setConfirmLote({ ids, maxDelta });
      return;
    }
    aplicarIds.mutate(ids);
  };

  const toggleAll = () => {
    if (selected.size === filteredItens.length) setSelected(new Set());
    else setSelected(new Set(filteredItens.map((i) => i.id)));
  };

  return (
    <div className="container mx-auto py-6 space-y-6">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Aplicação no Omie</h1>
          <p className="text-sm text-muted-foreground">
            Gere e aplique parâmetros de reposição diretamente no ERP, com validação de prontidão.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="text-xs text-right">
            <div className="text-muted-foreground">Última sync Omie</div>
            <div
              className={
                syncDesatualizado ? "text-destructive font-medium" : "text-foreground font-medium"
              }
            >
              {ultimoSync
                ? formatDistanceToNow(new Date(ultimoSync), { addSuffix: true, locale: ptBR })
                : "nunca"}
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => sincronizarOmie.mutate()}
            disabled={sincronizarOmie.isPending}
          >
            <RefreshCw
              className={`h-4 w-4 mr-2 ${sincronizarOmie.isPending ? "animate-spin" : ""}`}
            />
            Sincronizar agora
          </Button>
          <Button onClick={() => gerarFila.mutate()} disabled={gerarFila.isPending}>
            <PlayCircle className="h-4 w-4 mr-2" />
            Gerar fila
          </Button>
        </div>
      </header>

      {syncDesatualizado && (
        <Card className="border-warning bg-warning/5">
          <CardContent className="py-3 flex items-center gap-2 text-sm">
            <AlertTriangle className="h-4 w-4 text-warning" />
            <span>
              Status Omie está desatualizado (&gt; 24h). Sincronize antes de aplicar para evitar
              sobrescrever alterações manuais.
            </span>
          </CardContent>
        </Card>
      )}

      <Tabs value={tab} onValueChange={(v) => { setTab(v); setSelected(new Set()); }}>
        <TabsList className="w-full justify-start">
          <TabsTrigger value="pronto" className="data-[state=active]:bg-success/10">
            <CheckCircle2 className="h-4 w-4 mr-2 text-success" />
            Prontos para aplicar
            {!!contadores?.pronto && (
              <Badge className="ml-2 bg-success/20 text-success">{contadores.pronto}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="inativo" className="data-[state=active]:bg-destructive/10">
            <XCircle className="h-4 w-4 mr-2 text-destructive" />
            Item inativo
            {!!contadores?.inativo && (
              <Badge className="ml-2 bg-destructive/20 text-destructive">
                {contadores.inativo}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="substituicao" className="data-[state=active]:bg-warning/10">
            <AlertTriangle className="h-4 w-4 mr-2 text-warning" />
            Substituição pendente
            {!!contadores?.substituicao && (
              <Badge className="ml-2 bg-warning/20 text-warning-foreground">
                {contadores.substituicao}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="aplicado">
            <Clock className="h-4 w-4 mr-2" />
            Aplicados (30d)
            {!!contadores?.aplicado && <Badge className="ml-2">{contadores.aplicado}</Badge>}
          </TabsTrigger>
        </TabsList>

        {/* ABA 1: PRONTOS */}
        <TabsContent value="pronto" className="space-y-3">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2 flex-wrap">
                <div className="relative">
                  <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    className="pl-8 w-64"
                    placeholder="Buscar SKU ou descrição"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                <Select value={deltaFilter} onValueChange={setDeltaFilter}>
                  <SelectTrigger className="w-44">
                    <SelectValue placeholder="Filtrar por delta" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todos os deltas</SelectItem>
                    <SelectItem value="<10">&lt; 10%</SelectItem>
                    <SelectItem value="10-25">10–25%</SelectItem>
                    <SelectItem value="25-50">25–50%</SelectItem>
                    <SelectItem value=">50">&gt; 50%</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button
                disabled={selected.size === 0 || aplicarIds.isPending || hasBloqueados}
                onClick={() => handleAplicarLote(Array.from(selected))}
              >
                Aplicar selecionados ({selected.size})
              </Button>
            </CardHeader>
            <CardContent>
              {hasBloqueados && (
                <div className="mb-3 rounded-md border border-warning bg-warning/5 px-3 py-2 text-xs">
                  Há SKUs bloqueados. Aplicação em lote desabilitada — triê-los primeiro.
                </div>
              )}
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <Checkbox
                        checked={
                          filteredItens.length > 0 && selected.size === filteredItens.length
                        }
                        onCheckedChange={toggleAll}
                      />
                    </TableHead>
                    <TableHead>SKU</TableHead>
                    <TableHead>Descrição</TableHead>
                    <TableHead>EM (atual → novo)</TableHead>
                    <TableHead>PP (atual → novo)</TableHead>
                    <TableHead>Emax (atual → novo)</TableHead>
                    <TableHead>Δ máx</TableHead>
                    <TableHead className="text-right">Ação</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading && (
                    <TableRow>
                      <TableCell colSpan={8} className="text-center py-6">
                        Carregando…
                      </TableCell>
                    </TableRow>
                  )}
                  {!isLoading && filteredItens.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={8} className="text-center py-6 text-muted-foreground">
                        Nenhum SKU pronto. Clique em "Gerar fila".
                      </TableCell>
                    </TableRow>
                  )}
                  {filteredItens.map((it) => (
                    <TableRow key={it.id}>
                      <TableCell>
                        <Checkbox
                          checked={selected.has(it.id)}
                          onCheckedChange={(v) => {
                            const n = new Set(selected);
                            v ? n.add(it.id) : n.delete(it.id);
                            setSelected(n);
                          }}
                        />
                      </TableCell>
                      <TableCell className="font-mono text-xs">{it.sku_codigo_omie}</TableCell>
                      <TableCell className="max-w-xs truncate">{it.sku_descricao}</TableCell>
                      <TableCell>
                        <DeltaArrow
                          novo={it.estoque_minimo_novo}
                          atual={it.estoque_minimo_omie_atual}
                        />
                      </TableCell>
                      <TableCell>
                        <DeltaArrow
                          novo={it.ponto_pedido_novo}
                          atual={it.ponto_pedido_omie_atual}
                        />
                      </TableCell>
                      <TableCell>
                        <DeltaArrow
                          novo={it.estoque_maximo_novo}
                          atual={it.estoque_maximo_omie_atual}
                        />
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            (it.delta_max_perc ?? 0) > 50
                              ? "destructive"
                              : (it.delta_max_perc ?? 0) > 25
                              ? "secondary"
                              : "outline"
                          }
                        >
                          {(it.delta_max_perc ?? 0).toFixed(0)}%
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setConfirmIndividual(it)}
                        >
                          Aplicar
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ABA 2: INATIVOS */}
        <TabsContent value="inativo" className="space-y-3">
          {isLoading && <p className="text-sm text-muted-foreground">Carregando…</p>}
          {!isLoading && (filteredItens?.length ?? 0) === 0 && (
            <p className="text-sm text-muted-foreground py-6 text-center">
              Nenhum SKU bloqueado por inativação. 🎉
            </p>
          )}
          {filteredItens.map((it) => (
            <Card key={it.id} className="border-destructive/30">
              <CardContent className="py-4 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-mono text-sm">{it.sku_codigo_omie}</div>
                    <div className="font-medium">{it.sku_descricao}</div>
                    <div className="text-xs text-muted-foreground mt-1">
                      Mensagem: {it.mensagem_bloqueio ?? "—"}
                    </div>
                  </div>
                  <Badge variant="destructive">Item inativo</Badge>
                </div>
                <div className="flex gap-2 flex-wrap">
                  <Button size="sm" onClick={() => setSubstituicaoOpen(it)}>
                    Registrar substituição
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => desativarSku.mutate(it.sku_codigo_omie)}
                  >
                    Descadastrar do módulo
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      toast.info(
                        "Marcado como reativação manual — aguardando próximo sync para revalidar."
                      )
                    }
                  >
                    Reativar manualmente
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </TabsContent>

        {/* ABA 3: SUBSTITUIÇÃO */}
        <TabsContent value="substituicao" className="space-y-3">
          {isLoading && <p className="text-sm text-muted-foreground">Carregando…</p>}
          {!isLoading && (filteredItens?.length ?? 0) === 0 && (
            <p className="text-sm text-muted-foreground py-6 text-center">
              Nenhuma substituição pendente.
            </p>
          )}
          {filteredItens.map((it) => (
            <SubstituicaoPendenteCard key={it.id} item={it} onChange={() => qc.invalidateQueries()} />
          ))}
        </TabsContent>

        {/* ABA 4: APLICADOS */}
        <TabsContent value="aplicado">
          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Aplicado em</TableHead>
                    <TableHead>SKU</TableHead>
                    <TableHead>Descrição</TableHead>
                    <TableHead>EM</TableHead>
                    <TableHead>PP</TableHead>
                    <TableHead>Resultado</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredItens.map((it) => (
                    <TableRow key={it.id}>
                      <TableCell className="text-xs">
                        {it.aplicado_em
                          ? format(new Date(it.aplicado_em), "dd/MM/yyyy HH:mm", { locale: ptBR })
                          : "—"}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{it.sku_codigo_omie}</TableCell>
                      <TableCell className="max-w-xs truncate">{it.sku_descricao}</TableCell>
                      <TableCell>{it.estoque_minimo_novo}</TableCell>
                      <TableCell>{it.ponto_pedido_novo}</TableCell>
                      <TableCell>
                        {it.erro_omie ? (
                          <Badge variant="destructive" title={it.erro_omie}>
                            Erro
                          </Badge>
                        ) : (
                          <Badge className="bg-success/20 text-success">OK</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {filteredItens.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center py-6 text-muted-foreground">
                        Sem aplicações nos últimos 30 dias.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Modal substituição */}
      {substituicaoOpen && (
        <SubstituicaoModal
          item={substituicaoOpen}
          onClose={() => setSubstituicaoOpen(null)}
          onDone={() => {
            setSubstituicaoOpen(null);
            qc.invalidateQueries({ queryKey: ["fila-aplicacao"] });
            qc.invalidateQueries({ queryKey: ["fila-aplicacao-contadores"] });
          }}
        />
      )}

      {/* Confirmação lote com delta > 50% */}
      <AlertDialog open={!!confirmLote} onOpenChange={(o) => !o && setConfirmLote(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delta elevado detectado</AlertDialogTitle>
            <AlertDialogDescription>
              Há SKUs com delta acima de 50% (máximo: {confirmLote?.maxDelta.toFixed(0)}%). Tem
              certeza de que quer aplicar este lote no Omie?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmLote) aplicarIds.mutate(confirmLote.ids);
                setConfirmLote(null);
              }}
            >
              Confirmar aplicação
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Confirmação individual */}
      <AlertDialog
        open={!!confirmIndividual}
        onOpenChange={(o) => !o && setConfirmIndividual(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Aplicar parâmetros no Omie?</AlertDialogTitle>
            <AlertDialogDescription>
              SKU {confirmIndividual?.sku_codigo_omie} — {confirmIndividual?.sku_descricao}.
              <br />
              EM: {confirmIndividual?.estoque_minimo_omie_atual ?? "—"} →{" "}
              {confirmIndividual?.estoque_minimo_novo}
              <br />
              PP: {confirmIndividual?.ponto_pedido_omie_atual ?? "—"} →{" "}
              {confirmIndividual?.ponto_pedido_novo}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmIndividual) aplicarIds.mutate([confirmIndividual.id]);
                setConfirmIndividual(null);
              }}
            >
              Aplicar agora
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/* ============ Componentes auxiliares ============ */

function SubstituicaoPendenteCard({
  item,
  onChange,
}: {
  item: FilaItem;
  onChange: () => void;
}) {
  const { data: subst } = useQuery({
    queryKey: ["sku-substituicao", item.empresa, item.sku_codigo_omie],
    queryFn: async () => {
      const { data } = await supabase
        .from("sku_substituicao")
        .select("*")
        .eq("empresa", item.empresa)
        .eq("sku_codigo_antigo", item.sku_codigo_omie)
        .eq("status", "pendente")
        .maybeSingle();
      return data;
    },
  });

  const cancelarSubst = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("sku_substituicao")
        .update({ status: "cancelada" } as any)
        .eq("id", subst!.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Substituição cancelada");
      onChange();
    },
  });

  const aplicarSubst = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("sku_substituicao")
        .update({ status: "aplicada", aplicado_em: new Date().toISOString() } as any)
        .eq("id", subst!.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Substituição aplicada. Regere a fila para revalidar.");
      onChange();
    },
  });

  return (
    <Card className="border-warning/40">
      <CardContent className="py-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-mono text-sm">{item.sku_codigo_omie} (antigo)</div>
            <div className="font-medium">{item.sku_descricao}</div>
            {subst && (
              <div className="mt-2 text-xs">
                <div>
                  <span className="text-muted-foreground">SKU novo: </span>
                  <span className="font-mono">{subst.sku_codigo_novo}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Ação: </span>
                  <Badge variant="outline">{subst.acao_parametros}</Badge>
                </div>
                <div className="text-muted-foreground mt-1">
                  Motivo: {subst.motivo ?? "—"}
                </div>
              </div>
            )}
          </div>
          <Badge className="bg-warning/20 text-warning-foreground">Substituição pendente</Badge>
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => aplicarSubst.mutate()} disabled={!subst}>
            Aplicar substituição
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => cancelarSubst.mutate()}
            disabled={!subst}
          >
            Cancelar substituição
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function SubstituicaoModal({
  item,
  onClose,
  onDone,
}: {
  item: FilaItem;
  onClose: () => void;
  onDone: () => void;
}) {
  const [skuNovo, setSkuNovo] = useState("");
  const [busca, setBusca] = useState("");
  const [acao, setAcao] = useState("transferir");
  const [motivo, setMotivo] = useState("");

  const { data: opcoes } = useQuery({
    queryKey: ["sku-busca", busca],
    queryFn: async () => {
      if (!busca || busca.length < 2) return [];
      const { data } = await supabase
        .from("sku_parametros")
        .select("sku_codigo_omie, sku_descricao")
        .eq("empresa", EMPRESA)
        .or(`sku_codigo_omie.eq.${Number(busca) || 0},sku_descricao.ilike.%${busca}%`)
        .limit(20);
      return data ?? [];
    },
    enabled: busca.length >= 2,
  });

  const registrar = useMutation({
    mutationFn: async () => {
      if (!skuNovo) throw new Error("Selecione o SKU novo");
      if (!motivo.trim()) throw new Error("Motivo é obrigatório");
      const { data: { user } } = await supabase.auth.getUser();
      const { data, error } = await supabase.rpc("registrar_substituicao_sku" as any, {
        p_empresa: item.empresa,
        p_codigo_antigo: item.sku_codigo_omie,
        p_codigo_novo: skuNovo,
        p_acao_parametros: acao,
        p_motivo: motivo,
        p_usuario: user?.email ?? "sistema",
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      return data;
    },
    onSuccess: () => {
      toast.success("Substituição registrada");
      onDone();
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Registrar substituição</DialogTitle>
          <DialogDescription>
            SKU antigo: <span className="font-mono">{item.sku_codigo_omie}</span> —{" "}
            {item.sku_descricao}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>SKU novo</Label>
            <Input
              placeholder="Buscar por código ou descrição"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
            />
            {opcoes && opcoes.length > 0 && (
              <div className="mt-2 border rounded max-h-44 overflow-auto text-sm">
                {opcoes.map((o: any) => (
                  <button
                    key={o.sku_codigo_omie}
                    type="button"
                    onClick={() => {
                      setSkuNovo(String(o.sku_codigo_omie));
                      setBusca(`${o.sku_codigo_omie} — ${o.sku_descricao}`);
                    }}
                    className={`block w-full text-left px-3 py-1.5 hover:bg-muted ${
                      skuNovo === String(o.sku_codigo_omie) ? "bg-muted" : ""
                    }`}
                  >
                    <span className="font-mono">{o.sku_codigo_omie}</span> — {o.sku_descricao}
                  </button>
                ))}
              </div>
            )}
            {skuNovo && (
              <p className="text-xs text-muted-foreground mt-1">Selecionado: {skuNovo}</p>
            )}
          </div>

          <div>
            <Label>Ação sobre parâmetros</Label>
            <RadioGroup value={acao} onValueChange={setAcao} className="mt-2">
              <div className="flex items-start gap-2">
                <RadioGroupItem value="transferir" id="r1" className="mt-1" />
                <Label htmlFor="r1" className="font-normal">
                  <span className="font-medium">Transferir</span> — copia parâmetros do antigo para
                  o novo e aprova o novo.
                </Label>
              </div>
              <div className="flex items-start gap-2">
                <RadioGroupItem value="recalcular_do_zero" id="r2" className="mt-1" />
                <Label htmlFor="r2" className="font-normal">
                  <span className="font-medium">Recalcular do zero</span> — sistema calcula a
                  partir do histórico do novo SKU.
                </Label>
              </div>
              <div className="flex items-start gap-2">
                <RadioGroupItem value="manter_ambos" id="r3" className="mt-1" />
                <Label htmlFor="r3" className="font-normal">
                  <span className="font-medium">Manter ambos</span> — registra mas não desativa o
                  antigo.
                </Label>
              </div>
            </RadioGroup>
          </div>

          <div>
            <Label>Motivo *</Label>
            <Textarea
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              placeholder="Ex.: descontinuação do fornecedor, troca de embalagem, etc."
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => registrar.mutate()} disabled={registrar.isPending}>
            Confirmar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
