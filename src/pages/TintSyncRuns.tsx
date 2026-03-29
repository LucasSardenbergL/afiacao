import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { History, CheckCircle, XCircle, Loader2, Clock } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";

const statusConfig: Record<string, { label: string; color: string; icon: typeof CheckCircle }> = {
  complete: { label: "Completo", color: "bg-green-100 text-green-800", icon: CheckCircle },
  error: { label: "Erro", color: "bg-destructive/10 text-destructive", icon: XCircle },
  running: { label: "Executando", color: "bg-blue-100 text-blue-800", icon: Loader2 },
  partial: { label: "Parcial", color: "bg-yellow-100 text-yellow-800", icon: Clock },
};

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

  const stores = [...new Set(runs.map((r: any) => r.store_code))];

  const filtered = runs.filter((r: any) => {
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
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card><CardContent className="p-4 text-center"><p className="text-2xl font-bold">{runs.length}</p><p className="text-xs text-muted-foreground">Total</p></CardContent></Card>
        <Card><CardContent className="p-4 text-center"><p className="text-2xl font-bold text-green-600">{runs.filter((r: any) => r.status === "complete").length}</p><p className="text-xs text-muted-foreground">Completos</p></CardContent></Card>
        <Card><CardContent className="p-4 text-center"><p className="text-2xl font-bold text-destructive">{runs.filter((r: any) => r.status === "error").length}</p><p className="text-xs text-muted-foreground">Erros</p></CardContent></Card>
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
                <TableRow><TableCell colSpan={9} className="text-center py-8">Carregando...</TableCell></TableRow>
              ) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground py-8">Nenhuma execução encontrada</TableCell></TableRow>
              ) : filtered.map((r: any) => {
                const sc = statusConfig[r.status] || statusConfig.running;
                return (
                  <TableRow key={r.id} className="cursor-pointer hover:bg-muted/50" onClick={() => setSelectedRun(r.id)}>
                    <TableCell className="font-medium">{r.store_code}</TableCell>
                    <TableCell><Badge variant="outline">{r.sync_type}</Badge></TableCell>
                    <TableCell><Badge className={sc.color}>{sc.label}</Badge></TableCell>
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

      {/* Error detail sheet */}
      <Sheet open={!!selectedRun} onOpenChange={() => setSelectedRun(null)}>
        <SheetContent side="bottom" className="h-[60vh]">
          <SheetHeader><SheetTitle>Erros da Execução</SheetTitle></SheetHeader>
          <div className="overflow-auto mt-4">
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
                  {errors.map((e: any) => (
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
