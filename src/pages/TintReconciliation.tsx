import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { GitCompare, AlertTriangle, CheckCircle, MinusCircle } from "lucide-react";

const diffTypeLabels: Record<string, { label: string; color: string; icon: typeof AlertTriangle }> = {
  match: { label: "Igual", color: "bg-green-100 text-green-800", icon: CheckCircle },
  divergence: { label: "Divergência", color: "bg-yellow-100 text-yellow-800", icon: AlertTriangle },
  only_csv: { label: "Só CSV", color: "bg-blue-100 text-blue-800", icon: MinusCircle },
  only_sync: { label: "Só Sync", color: "bg-purple-100 text-purple-800", icon: MinusCircle },
};

export default function TintReconciliation() {
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [entityFilter, setEntityFilter] = useState<string>("all");
  const [diffFilter, setDiffFilter] = useState<string>("all");
  const [search, setSearch] = useState("");

  const { data: runs = [] } = useQuery({
    queryKey: ["tint-reconciliation-runs"],
    queryFn: async () => {
      const { data } = await supabase
        .from("tint_reconciliation_runs")
        .select("*")
        .order("started_at", { ascending: false })
        .limit(50);
      return data || [];
    },
  });

  const { data: items = [], isLoading: itemsLoading } = useQuery({
    queryKey: ["tint-reconciliation-items", selectedRun],
    enabled: !!selectedRun,
    queryFn: async () => {
      const { data } = await supabase
        .from("tint_reconciliation_items")
        .select("*")
        .eq("reconciliation_run_id", selectedRun!)
        .order("created_at", { ascending: false })
        .limit(500);
      return data || [];
    },
  });

  const filtered = items.filter((i: any) => {
    if (entityFilter !== "all" && i.entity_type !== entityFilter) return false;
    if (diffFilter !== "all" && i.diff_type !== diffFilter) return false;
    if (search && !i.entity_key.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const entityTypes = [...new Set(items.map((i: any) => i.entity_type))];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <GitCompare className="h-6 w-6" />
          Reconciliação CSV × Automático
        </h1>
        <p className="text-sm text-muted-foreground">Compare dados importados por CSV com dados sincronizados automaticamente</p>
      </div>

      {/* Summary cards */}
      {selectedRun && runs.length > 0 && (() => {
        const run = runs.find((r: any) => r.id === selectedRun);
        if (!run) return null;
        return (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Card><CardContent className="p-4 text-center"><p className="text-2xl font-bold">{run.total_compared}</p><p className="text-xs text-muted-foreground">Comparados</p></CardContent></Card>
            <Card><CardContent className="p-4 text-center"><p className="text-2xl font-bold text-green-600">{run.matches}</p><p className="text-xs text-muted-foreground">Iguais</p></CardContent></Card>
            <Card><CardContent className="p-4 text-center"><p className="text-2xl font-bold text-yellow-600">{run.divergences}</p><p className="text-xs text-muted-foreground">Divergências</p></CardContent></Card>
            <Card><CardContent className="p-4 text-center"><p className="text-2xl font-bold text-blue-600">{run.only_csv}</p><p className="text-xs text-muted-foreground">Só CSV</p></CardContent></Card>
            <Card><CardContent className="p-4 text-center"><p className="text-2xl font-bold text-purple-600">{run.only_sync}</p><p className="text-xs text-muted-foreground">Só Sync</p></CardContent></Card>
          </div>
        );
      })()}

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <Select value={selectedRun || ""} onValueChange={setSelectedRun}>
          <SelectTrigger className="w-72"><SelectValue placeholder="Selecione uma execução" /></SelectTrigger>
          <SelectContent>
            {runs.map((r: any) => (
              <SelectItem key={r.id} value={r.id}>
                {r.store_code} — {new Date(r.started_at).toLocaleDateString("pt-BR")} ({r.status})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={entityFilter} onValueChange={setEntityFilter}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos tipos</SelectItem>
            {entityTypes.map((t: string) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={diffFilter} onValueChange={setDiffFilter}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos status</SelectItem>
            <SelectItem value="match">Igual</SelectItem>
            <SelectItem value="divergence">Divergência</SelectItem>
            <SelectItem value="only_csv">Só CSV</SelectItem>
            <SelectItem value="only_sync">Só Sync</SelectItem>
          </SelectContent>
        </Select>
        <Input placeholder="Buscar por chave..." value={search} onChange={(e) => setSearch(e.target.value)} className="w-48" />
      </div>

      {/* Results table */}
      {!selectedRun ? (
        <Card><CardContent className="p-8 text-center text-muted-foreground">Selecione uma execução de reconciliação para ver os resultados.</CardContent></Card>
      ) : itemsLoading ? (
        <p className="text-muted-foreground">Carregando...</p>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tipo</TableHead>
                  <TableHead>Chave</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Campos divergentes</TableHead>
                  <TableHead>Resolvido</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 ? (
                  <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-8">Nenhum item encontrado</TableCell></TableRow>
                ) : filtered.map((item: any) => {
                  const dt = diffTypeLabels[item.diff_type] || diffTypeLabels.divergence;
                  return (
                    <TableRow key={item.id}>
                      <TableCell><Badge variant="outline">{item.entity_type}</Badge></TableCell>
                      <TableCell className="font-mono text-xs">{item.entity_key}</TableCell>
                      <TableCell><Badge className={dt.color}>{dt.label}</Badge></TableCell>
                      <TableCell className="text-xs">{item.diff_fields?.join(", ") || "—"}</TableCell>
                      <TableCell>{item.resolved ? <CheckCircle className="h-4 w-4 text-green-500" /> : "—"}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
