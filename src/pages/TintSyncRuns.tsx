import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { History, CheckCircle, XCircle, Loader2, Clock } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";

type TintSyncRun = Tables<"tint_sync_runs">;
type TintSyncError = Tables<"tint_sync_errors">;
type TintKeysSnapshotLinha = Pick<
  Tables<"tint_keys_snapshots">,
  "snapshot_id" | "generated_at" | "total_chunks" | "created_at" | "aplicacao_status" | "aplicacao_tentativas" | "aplicacao_erro" | "aplicado_em"
>;

const statusConfig: Record<string, { label: string; color: string; icon: typeof CheckCircle }> = {
  complete: { label: "Completo", color: "bg-status-success-bg text-status-success", icon: CheckCircle },
  error: { label: "Erro", color: "bg-destructive/10 text-destructive", icon: XCircle },
  running: { label: "Executando", color: "bg-status-info-bg text-status-info", icon: Loader2 },
  partial: { label: "Parcial", color: "bg-status-warning-bg text-status-warning", icon: Clock },
};

// Fila de promoção (migration 20260925210000): a edge grava o staging e responde; o cron
// tint-promocao-tick promove depois. `status` é a INGESTÃO; isto é a PROMOÇÃO ao catálogo.
// NULL = run anterior à fila (promovido dentro do HTTP) ou modo não-automático.
const promocaoConfig: Record<string, { label: string; color: string }> = {
  pendente: { label: "Pendente", color: "bg-status-info-bg text-status-info" },
  promovido: { label: "Promovido", color: "bg-status-success-bg text-status-success" },
  aplicado: { label: "Aplicado", color: "bg-status-success-bg text-status-success" },
  erro: { label: "Erro", color: "bg-destructive/10 text-destructive" },
  descartado: { label: "Descartado", color: "bg-muted text-muted-foreground" },
};

function PromocaoBadge({ status, tentativas, erro }: { status: string | null; tentativas: number; erro: string | null }) {
  if (!status) return <span className="text-muted-foreground">—</span>;
  const pc = promocaoConfig[status] ?? { label: status, color: "bg-muted text-muted-foreground" };
  return (
    <span className="inline-flex items-center gap-1" title={erro ?? undefined}>
      <Badge className={pc.color}>{pc.label}</Badge>
      {tentativas > 1 || (status === "pendente" && tentativas > 0) ? (
        <span className="text-xs text-muted-foreground">tent. {tentativas}</span>
      ) : null}
    </span>
  );
}

export default function TintSyncRuns() {
  const [storeFilter, setStoreFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [selectedRun, setSelectedRun] = useState<string | null>(null);

  const { data: runs = [], isLoading } = useQuery({
    queryKey: ["tint-sync-runs-all"],
    queryFn: async () => {
      const { data } = await supabase
        .from("tint_sync_runs")
        .select("*")
        .order("started_at", { ascending: false })
        .limit(200);
      return data || [];
    },
  });

  const { data: errors = [] } = useQuery({
    queryKey: ["tint-sync-errors", selectedRun],
    enabled: !!selectedRun,
    queryFn: async () => {
      const { data } = await supabase
        .from("tint_sync_errors")
        .select("*")
        .eq("sync_run_id", selectedRun!)
        .order("created_at", { ascending: false })
        .limit(100);
      return data || [];
    },
  });

  // Snapshots de chaves: N linhas-chunk por snapshot_id, com o MESMO estado de aplicação.
  // Nunca selecionar `keys` (até 50k chaves por chunk).
  const { data: snapshots = [] } = useQuery({
    queryKey: ["tint-keys-snapshots-fila"],
    queryFn: async () => {
      const { data } = await supabase
        .from("tint_keys_snapshots")
        .select("snapshot_id, generated_at, total_chunks, created_at, aplicacao_status, aplicacao_tentativas, aplicacao_erro, aplicado_em")
        .order("created_at", { ascending: false })
        .limit(100);
      const porSnapshot = new Map<string, TintKeysSnapshotLinha>();
      for (const linha of (data || []) as TintKeysSnapshotLinha[]) {
        if (!porSnapshot.has(linha.snapshot_id)) porSnapshot.set(linha.snapshot_id, linha);
      }
      return [...porSnapshot.values()].slice(0, 10);
    },
  });

  const stores = [...new Set(runs.map((r: TintSyncRun) => r.store_code))];
  const runSelecionado = runs.find((r: TintSyncRun) => r.id === selectedRun);

  const filtered = runs.filter((r: TintSyncRun) => {
    if (storeFilter !== "all" && r.store_code !== storeFilter) return false;
    if (statusFilter !== "all" && r.status !== statusFilter) return false;
    return true;
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <History className="h-6 w-6" />
          Histórico de Sincronizações
        </h1>
        <p className="text-sm text-muted-foreground">Execuções do agente local por loja</p>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <Card><CardContent className="p-4 text-center"><p className="text-2xl font-bold">{runs.length}</p><p className="text-xs text-muted-foreground">Total</p></CardContent></Card>
        <Card><CardContent className="p-4 text-center"><p className="text-2xl font-bold text-status-success">{runs.filter((r: TintSyncRun) => r.status === "complete").length}</p><p className="text-xs text-muted-foreground">Completos</p></CardContent></Card>
        <Card><CardContent className="p-4 text-center"><p className="text-2xl font-bold text-destructive">{runs.filter((r: TintSyncRun) => r.status === "error").length}</p><p className="text-xs text-muted-foreground">Erros</p></CardContent></Card>
        <Card><CardContent className="p-4 text-center"><p className="text-2xl font-bold text-status-info">{runs.filter((r: TintSyncRun) => r.promocao_status === "pendente").length}</p><p className="text-xs text-muted-foreground">Promoção pendente</p></CardContent></Card>
        <Card><CardContent className="p-4 text-center"><p className="text-2xl font-bold text-destructive">{runs.filter((r: TintSyncRun) => r.promocao_status === "erro").length}</p><p className="text-xs text-muted-foreground">Promoção com erro</p></CardContent></Card>
        <Card><CardContent className="p-4 text-center"><p className="text-2xl font-bold">{stores.length}</p><p className="text-xs text-muted-foreground">Lojas</p></CardContent></Card>
      </div>

      {/* Filters */}
      <div className="flex gap-3">
        <Select value={storeFilter} onValueChange={setStoreFilter}>
          <SelectTrigger className="w-40"><SelectValue placeholder="Loja" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas lojas</SelectItem>
            {stores.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos status</SelectItem>
            <SelectItem value="complete">Completo</SelectItem>
            <SelectItem value="error">Erro</SelectItem>
            <SelectItem value="running">Executando</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Loja</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Promoção</TableHead>
                <TableHead>Início</TableHead>
                <TableHead>Duração</TableHead>
                <TableHead className="text-right">Inserts</TableHead>
                <TableHead className="text-right">Updates</TableHead>
                <TableHead className="text-right">Erros</TableHead>
                <TableHead>Origem</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={10} className="text-center py-8">Carregando...</TableCell></TableRow>
              ) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={10} className="text-center text-muted-foreground py-8">Nenhuma execução encontrada</TableCell></TableRow>
              ) : filtered.map((r: TintSyncRun) => {
                const sc = statusConfig[r.status] || statusConfig.running;
                return (
                  <TableRow key={r.id} className="cursor-pointer hover:bg-muted/50" onClick={() => setSelectedRun(r.id)}>
                    <TableCell className="font-medium">{r.store_code}</TableCell>
                    <TableCell><Badge variant="outline">{r.sync_type}</Badge></TableCell>
                    <TableCell><Badge className={sc.color}>{sc.label}</Badge></TableCell>
                    <TableCell><PromocaoBadge status={r.promocao_status} tentativas={r.promocao_tentativas} erro={r.promocao_erro} /></TableCell>
                    <TableCell className="text-xs">{formatDistanceToNow(new Date(r.started_at), { addSuffix: true, locale: ptBR })}</TableCell>
                    <TableCell>{r.duration_ms ? `${(r.duration_ms / 1000).toFixed(1)}s` : "—"}</TableCell>
                    <TableCell className="text-right">{r.inserts ?? 0}</TableCell>
                    <TableCell className="text-right">{r.updates ?? 0}</TableCell>
                    <TableCell className="text-right">{r.errors ? <span className="text-destructive font-medium">{r.errors}</span> : 0}</TableCell>
                    <TableCell><Badge variant="secondary">{r.source}</Badge></TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Fila de aplicação dos snapshots de chaves (desativação por ausência na fonte) */}
      {snapshots.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <div className="px-4 pt-4 pb-2">
              <h2 className="text-sm font-semibold">Snapshots de chaves</h2>
              <p className="text-xs text-muted-foreground">Aplicados pela mesma fila da promoção, na ordem de chegada</p>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Gerado</TableHead>
                  <TableHead>Chunks</TableHead>
                  <TableHead>Aplicação</TableHead>
                  <TableHead>Aplicado</TableHead>
                  <TableHead>Erro</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {snapshots.map((snap) => (
                  <TableRow key={snap.snapshot_id}>
                    <TableCell className="text-xs">{formatDistanceToNow(new Date(snap.generated_at), { addSuffix: true, locale: ptBR })}</TableCell>
                    <TableCell>{snap.total_chunks}</TableCell>
                    <TableCell><PromocaoBadge status={snap.aplicacao_status} tentativas={snap.aplicacao_tentativas} erro={snap.aplicacao_erro} /></TableCell>
                    <TableCell className="text-xs">{snap.aplicado_em ? formatDistanceToNow(new Date(snap.aplicado_em), { addSuffix: true, locale: ptBR }) : "—"}</TableCell>
                    <TableCell className="text-xs max-w-xs truncate" title={snap.aplicacao_erro ?? undefined}>{snap.aplicacao_erro || "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Error detail sheet */}
      <Sheet open={!!selectedRun} onOpenChange={() => setSelectedRun(null)}>
        <SheetContent side="bottom" className="h-[60vh]">
          <SheetHeader><SheetTitle>Erros da Execução</SheetTitle></SheetHeader>
          <div className="overflow-auto mt-4">
            {runSelecionado?.promocao_erro && (
              <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
                <p className="font-medium text-destructive">
                  Promoção {runSelecionado.promocao_status === "erro" ? "em erro" : "com falha"} · tentativa {runSelecionado.promocao_tentativas}
                </p>
                <p className="mt-1 font-mono text-xs break-all">{runSelecionado.promocao_erro}</p>
              </div>
            )}
            {errors.length === 0 ? (
              <p className="text-muted-foreground text-center py-8">Nenhum erro registrado nesta execução.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Entidade</TableHead>
                    <TableHead>ID</TableHead>
                    <TableHead>Mensagem</TableHead>
                    <TableHead>Detalhes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {errors.map((e: TintSyncError) => (
                    <TableRow key={e.id}>
                      <TableCell><Badge variant="outline">{e.entity_type}</Badge></TableCell>
                      <TableCell className="font-mono text-xs">{e.entity_id || "—"}</TableCell>
                      <TableCell className="text-sm">{e.error_message}</TableCell>
                      <TableCell className="text-xs max-w-xs truncate">{e.error_details ? JSON.stringify(e.error_details) : "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
