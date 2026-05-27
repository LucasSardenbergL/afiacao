import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { GitCompare, AlertTriangle, CheckCircle, MinusCircle, FlaskConical } from "lucide-react";

const SYNTHETIC_PREFIXES = ["SIM-", "MOCK-", "TEST-", "FAKE-"];

type ReconciliationRun = Tables<"tint_reconciliation_runs">;
type ReconciliationItem = Tables<"tint_reconciliation_items">;
type ClassifiedItem = ReconciliationItem & { _isSynthetic: boolean };

function isSyntheticRecord(item: Pick<ReconciliationItem, "entity_key" | "sync_value">): boolean {
  const key = (item.entity_key || "").toUpperCase();
  if (SYNTHETIC_PREFIXES.some((p) => key.includes(p))) return true;
  const syncVal = item.sync_value;
  if (syncVal) {
    const obj = typeof syncVal === "string" ? JSON.parse(syncVal) : syncVal;
    const vals = Object.values(obj as Record<string, unknown>).map((v) => String(v ?? "").toUpperCase());
    if (vals.some((v) => SYNTHETIC_PREFIXES.some((p) => v.includes(p)))) return true;
  }
  return false;
}

const diffTypeLabels: Record<string, { label: string; color: string; icon: typeof AlertTriangle }> = {
  match: { label: "Igual", color: "bg-status-success-bg text-status-success", icon: CheckCircle },
  divergence: { label: "Divergência", color: "bg-status-warning-bg text-status-warning", icon: AlertTriangle },
  only_csv: { label: "Só CSV", color: "bg-status-info-bg text-status-info", icon: MinusCircle },
  only_sync: { label: "Só Sync", color: "bg-status-purple-bg text-status-purple", icon: MinusCircle },
};

function ValueDisplay({ label, value }: { label: string; value: unknown }) {
  if (!value) return null;
  const obj = typeof value === "string" ? JSON.parse(value) : value;
  return (
    <div className="text-xs space-y-0.5">
      <span className="font-semibold text-muted-foreground">{label}:</span>
      {Object.entries(obj).map(([k, v]) => (
        <div key={k} className="ml-2"><span className="text-muted-foreground">{k}:</span> <span className="font-mono">{String(v ?? "—")}</span></div>
      ))}
    </div>
  );
}

export default function TintReconciliation() {
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [entityFilter, setEntityFilter] = useState<string>("all");
  const [diffFilter, setDiffFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [detailItem, setDetailItem] = useState<ClassifiedItem | null>(null);
  const [hideSynthetic, setHideSynthetic] = useState(true);

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
        .order("diff_type", { ascending: true })
        .limit(500);
      return data || [];
    },
  });

  // Classify items
  const classifiedItems: ClassifiedItem[] = items.map((i) => ({ ...i, _isSynthetic: isSyntheticRecord(i) }));
  const syntheticCount = classifiedItems.filter((i) => i._isSynthetic).length;
  const realCount = classifiedItems.length - syntheticCount;

  const filtered = classifiedItems.filter((i) => {
    if (hideSynthetic && i._isSynthetic) return false;
    if (entityFilter !== "all" && i.entity_type !== entityFilter) return false;
    if (diffFilter !== "all" && i.diff_type !== diffFilter) return false;
    if (search && !i.entity_key.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const entityTypes = [...new Set(items.map((i) => i.entity_type))];

  // Counts for visible items only
  const visibleItems = classifiedItems.filter((i) => !(hideSynthetic && i._isSynthetic));
  const counts = visibleItems.reduce<Record<string, number>>((acc, i) => {
    acc[i.diff_type] = (acc[i.diff_type] || 0) + 1;
    return acc;
  }, {});

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
      {selectedRun && (
        <>
          {/* Synthetic toggle + info */}
          <div className="flex items-center justify-between bg-muted/50 border rounded-lg p-3">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <Switch id="hide-synthetic" checked={hideSynthetic} onCheckedChange={setHideSynthetic} />
                <Label htmlFor="hide-synthetic" className="text-sm cursor-pointer">Ocultar dados sintéticos/mock</Label>
              </div>
              {syntheticCount > 0 && (
                <Badge variant="outline" className="gap-1">
                  <FlaskConical className="h-3 w-3" />
                  {syntheticCount} sintético{syntheticCount !== 1 ? "s" : ""}
                </Badge>
              )}
            </div>
            <div className="text-xs text-muted-foreground">
              {hideSynthetic
                ? `Exibindo ${realCount} registros reais`
                : `Exibindo todos: ${realCount} reais + ${syntheticCount} sintéticos`}
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Card><CardContent className="p-4 text-center"><p className="text-2xl font-bold">{visibleItems.length}</p><p className="text-xs text-muted-foreground">Comparados</p></CardContent></Card>
            <Card><CardContent className="p-4 text-center"><p className="text-2xl font-bold text-status-success">{counts.match || 0}</p><p className="text-xs text-muted-foreground">Iguais</p></CardContent></Card>
            <Card><CardContent className="p-4 text-center"><p className="text-2xl font-bold text-status-warning">{counts.divergence || 0}</p><p className="text-xs text-muted-foreground">Divergências</p></CardContent></Card>
            <Card><CardContent className="p-4 text-center"><p className="text-2xl font-bold text-status-info">{counts.only_csv || 0}</p><p className="text-xs text-muted-foreground">Só CSV</p></CardContent></Card>
            <Card><CardContent className="p-4 text-center"><p className="text-2xl font-bold text-status-purple">{counts.only_sync || 0}</p><p className="text-xs text-muted-foreground">Só Sync</p></CardContent></Card>
          </div>
        </>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <Select value={selectedRun || ""} onValueChange={setSelectedRun}>
          <SelectTrigger className="w-72"><SelectValue placeholder="Selecione uma execução" /></SelectTrigger>
          <SelectContent>
            {runs.map((r: ReconciliationRun) => (
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
                  <TableHead>Chave Lógica</TableHead>
                  <TableHead>Origem</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Campos divergentes</TableHead>
                  <TableHead>Valor CSV</TableHead>
                  <TableHead>Valor Sync</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 ? (
                  <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">Nenhum item encontrado</TableCell></TableRow>
                ) : filtered.map((item) => {
                  const dt = diffTypeLabels[item.diff_type] || diffTypeLabels.divergence;
                  const csvVal = item.csv_value ? (typeof item.csv_value === "string" ? JSON.parse(item.csv_value) : item.csv_value) as Record<string, unknown> : null;
                  const syncVal = item.sync_value ? (typeof item.sync_value === "string" ? JSON.parse(item.sync_value) : item.sync_value) as Record<string, unknown> : null;
                  return (
                    <TableRow key={item.id} className={`cursor-pointer hover:bg-muted/50 ${item._isSynthetic ? "opacity-60" : ""}`} onClick={() => setDetailItem(item)}>
                      <TableCell><Badge variant="outline">{item.entity_type}</Badge></TableCell>
                      <TableCell className="font-mono text-xs max-w-[200px] truncate" title={item.entity_key}>{item.entity_key}</TableCell>
                      <TableCell>
                        {item._isSynthetic ? (
                          <Badge variant="outline" className="gap-1 border-dashed text-xs">
                            <FlaskConical className="h-3 w-3" /> Mock
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="text-xs">Real</Badge>
                        )}
                      </TableCell>
                      <TableCell><Badge className={dt.color}>{dt.label}</Badge></TableCell>
                      <TableCell className="text-xs">{item.diff_fields?.join(", ") || "—"}</TableCell>
                      <TableCell className="text-xs max-w-[150px]">
                        {csvVal ? Object.entries(csvVal).map(([k, v]) => <div key={k}><span className="text-muted-foreground">{k}:</span> {String(v ?? "—")}</div>) : "—"}
                      </TableCell>
                      <TableCell className="text-xs max-w-[150px]">
                        {syncVal ? Object.entries(syncVal).map(([k, v]) => <div key={k}><span className="text-muted-foreground">{k}:</span> {String(v ?? "—")}</div>) : "—"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Detail dialog */}
      <Dialog open={!!detailItem} onOpenChange={() => setDetailItem(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Detalhe da Reconciliação</DialogTitle>
          </DialogHeader>
          {detailItem && (() => {
            const dt = diffTypeLabels[detailItem.diff_type] || diffTypeLabels.divergence;
            const csvVal = detailItem.csv_value ? (typeof detailItem.csv_value === "string" ? JSON.parse(detailItem.csv_value) : detailItem.csv_value) as Record<string, unknown> : null;
            const syncVal = detailItem.sync_value ? (typeof detailItem.sync_value === "string" ? JSON.parse(detailItem.sync_value) : detailItem.sync_value) as Record<string, unknown> : null;
            const synthetic = isSyntheticRecord(detailItem);
            
            let reason = "";
            if (detailItem.diff_type === "match") reason = "Todos os campos comparados são idênticos entre CSV e Sync.";
            else if (detailItem.diff_type === "divergence") reason = `Os campos [${detailItem.diff_fields?.join(", ") || "?"}] possuem valores diferentes entre CSV e Sync.`;
            else if (detailItem.diff_type === "only_sync") reason = "Este registro existe no staging (sync) mas NÃO foi encontrado na tabela oficial (CSV). A chave lógica não teve correspondência.";
            else if (detailItem.diff_type === "only_csv") reason = "Este registro existe na tabela oficial (CSV) mas NÃO apareceu no staging (sync).";

            return (
              <div className="space-y-4">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge className={dt.color}>{dt.label}</Badge>
                  <Badge variant="outline">{detailItem.entity_type}</Badge>
                  {synthetic && (
                    <Badge variant="outline" className="gap-1 border-dashed border-status-warning text-status-warning">
                      <FlaskConical className="h-3 w-3" /> Dado Sintético / Mock
                    </Badge>
                  )}
                </div>

                {synthetic && (
                  <div className="bg-status-warning-bg border border-status-warning/40 rounded-lg p-3 text-xs text-status-warning">
                    ⚠️ Este registro foi gerado pela simulação e não representa um dado operacional real. 
                    Ele serve apenas para validar o fluxo de sincronização e reconciliação.
                  </div>
                )}

                <div>
                  <p className="text-xs text-muted-foreground mb-1">Chave Lógica</p>
                  <p className="font-mono text-sm bg-muted p-2 rounded">{detailItem.entity_key}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {detailItem.entity_type === "formula" 
                      ? "Formato: cor_id | cod_produto | id_base | id_embalagem"
                      : "Formato: id_corante_sayersystem"}
                  </p>
                </div>

                <div>
                  <p className="text-xs text-muted-foreground mb-1 font-semibold">Por que este status?</p>
                  <p className="text-sm">{reason}</p>
                </div>

                {csvVal && <ValueDisplay label="Tabela oficial (CSV)" value={csvVal} />}
                {syncVal && <ValueDisplay label="Staging (Sync)" value={syncVal} />}

                {(detailItem.diff_fields?.length ?? 0) > 0 && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1 font-semibold">Campos divergentes</p>
                    <div className="space-y-1">
                      {(detailItem.diff_fields ?? []).map((field: string) => (
                        <div key={field} className="text-sm bg-muted p-2 rounded">
                          <span className="font-semibold">{field}:</span>
                          <span className="ml-2 text-primary">CSV: {String(csvVal?.[field] ?? "—")}</span>
                          <span className="ml-2 text-accent-foreground">Sync: {String(syncVal?.[field] ?? "—")}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>
    </div>
  );
}
