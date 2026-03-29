import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Plus, Copy, RefreshCw, Wifi, WifiOff, Eye, EyeOff, Settings2 } from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";

type IntegrationMode = "csv_only" | "shadow_mode" | "automatic_primary";

const modeLabels: Record<IntegrationMode, string> = {
  csv_only: "CSV Only",
  shadow_mode: "Shadow Mode",
  automatic_primary: "Automático",
};
const modeColors: Record<IntegrationMode, string> = {
  csv_only: "bg-muted text-muted-foreground",
  shadow_mode: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
  automatic_primary: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
};

export default function TintIntegrations() {
  const qc = useQueryClient();
  const [showDialog, setShowDialog] = useState(false);
  const [newStore, setNewStore] = useState({ store_code: "", store_name: "", account: "oben" });
  const [visibleTokens, setVisibleTokens] = useState<Record<string, boolean>>({});

  const { data: settings = [], isLoading } = useQuery({
    queryKey: ["tint-integration-settings"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tint_integration_settings")
        .select("*")
        .order("created_at", { ascending: true });
      if (error) throw error;
      return data || [];
    },
  });

  const { data: recentRuns = [] } = useQuery({
    queryKey: ["tint-sync-runs-recent"],
    queryFn: async () => {
      const { data } = await supabase
        .from("tint_sync_runs")
        .select("*")
        .order("started_at", { ascending: false })
        .limit(50);
      return data || [];
    },
  });

  const createMutation = useMutation({
    mutationFn: async (store: typeof newStore) => {
      const { error } = await supabase.from("tint_integration_settings").insert({
        account: store.account,
        store_code: store.store_code,
        store_name: store.store_name,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Loja adicionada");
      qc.invalidateQueries({ queryKey: ["tint-integration-settings"] });
      setShowDialog(false);
      setNewStore({ store_code: "", store_name: "", account: "oben" });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const updateModeMutation = useMutation({
    mutationFn: async ({ id, mode }: { id: string; mode: IntegrationMode }) => {
      const { error } = await supabase
        .from("tint_integration_settings")
        .update({ integration_mode: mode })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Modo atualizado");
      qc.invalidateQueries({ queryKey: ["tint-integration-settings"] });
    },
  });

  const toggleSyncMutation = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      const { error } = await supabase
        .from("tint_integration_settings")
        .update({ sync_enabled: enabled })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Sincronização atualizada");
      qc.invalidateQueries({ queryKey: ["tint-integration-settings"] });
    },
  });

  function getStoreRuns(storeCode: string) {
    return recentRuns.filter((r: any) => r.store_code === storeCode);
  }

  function getHealthStatus(setting: any) {
    if (!setting.sync_enabled) return { label: "Desabilitado", color: "text-muted-foreground" };
    if (!setting.last_heartbeat_at) return { label: "Sem heartbeat", color: "text-yellow-500" };
    const diff = Date.now() - new Date(setting.last_heartbeat_at).getTime();
    if (diff < 5 * 60 * 1000) return { label: "Online", color: "text-green-500" };
    if (diff < 30 * 60 * 1000) return { label: "Lento", color: "text-yellow-500" };
    return { label: "Offline", color: "text-destructive" };
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Integrações Tintométricas</h1>
          <p className="text-sm text-muted-foreground">Gerencie os conectores por loja/unidade</p>
        </div>
        <Dialog open={showDialog} onOpenChange={setShowDialog}>
          <DialogTrigger asChild>
            <Button><Plus className="h-4 w-4 mr-2" />Nova Loja</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>Adicionar Loja</DialogTitle></DialogHeader>
            <div className="space-y-4">
              <div>
                <Label>Código da Loja</Label>
                <Input value={newStore.store_code} onChange={(e) => setNewStore(s => ({ ...s, store_code: e.target.value }))} placeholder="loja-01" />
              </div>
              <div>
                <Label>Nome da Loja</Label>
                <Input value={newStore.store_name} onChange={(e) => setNewStore(s => ({ ...s, store_name: e.target.value }))} placeholder="Loja Centro" />
              </div>
              <Button onClick={() => createMutation.mutate(newStore)} disabled={!newStore.store_code || createMutation.isPending}>
                Criar
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <p className="text-muted-foreground">Carregando...</p>
      ) : settings.length === 0 ? (
        <Card><CardContent className="p-8 text-center text-muted-foreground">Nenhuma loja configurada. Adicione uma loja para começar.</CardContent></Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {settings.map((s: any) => {
            const health = getHealthStatus(s);
            const runs = getStoreRuns(s.store_code);
            const lastSuccess = runs.find((r: any) => r.status === "complete");
            const lastError = runs.find((r: any) => r.status === "error");

            return (
              <Card key={s.id}>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-lg flex items-center gap-2">
                      {health.label === "Online" ? <Wifi className={`h-4 w-4 ${health.color}`} /> : <WifiOff className={`h-4 w-4 ${health.color}`} />}
                      {s.store_name || s.store_code}
                    </CardTitle>
                    <Badge className={modeColors[s.integration_mode as IntegrationMode]}>
                      {modeLabels[s.integration_mode as IntegrationMode]}
                    </Badge>
                  </div>
                  <CardDescription>Código: {s.store_code} · Conta: {s.account}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div><span className="text-muted-foreground">Saúde:</span> <span className={health.color}>{health.label}</span></div>
                    <div><span className="text-muted-foreground">Sync:</span> {s.sync_enabled ? "Habilitado" : "Desabilitado"}</div>
                    <div><span className="text-muted-foreground">Último heartbeat:</span> {s.last_heartbeat_at ? formatDistanceToNow(new Date(s.last_heartbeat_at), { addSuffix: true, locale: ptBR }) : "—"}</div>
                    <div><span className="text-muted-foreground">Versão agent:</span> {s.agent_version || "—"}</div>
                    <div><span className="text-muted-foreground">Último sync OK:</span> {lastSuccess ? formatDistanceToNow(new Date(lastSuccess.started_at), { addSuffix: true, locale: ptBR }) : "—"}</div>
                    <div><span className="text-muted-foreground">Última falha:</span> {lastError ? formatDistanceToNow(new Date(lastError.started_at), { addSuffix: true, locale: ptBR }) : "—"}</div>
                  </div>

                  {/* Token */}
                  <div className="flex items-center gap-2">
                    <Input
                      readOnly
                      type={visibleTokens[s.id] ? "text" : "password"}
                      value={s.sync_token}
                      className="font-mono text-xs"
                    />
                    <Button size="icon" variant="ghost" onClick={() => setVisibleTokens(v => ({ ...v, [s.id]: !v[s.id] }))}>
                      {visibleTokens[s.id] ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                    <Button size="icon" variant="ghost" onClick={() => { navigator.clipboard.writeText(s.sync_token); toast.success("Token copiado"); }}>
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>

                  {/* Controls */}
                  <div className="flex gap-2 flex-wrap">
                    <Select
                      value={s.integration_mode}
                      onValueChange={(v) => updateModeMutation.mutate({ id: s.id, mode: v as IntegrationMode })}
                    >
                      <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="csv_only">CSV Only</SelectItem>
                        <SelectItem value="shadow_mode">Shadow Mode</SelectItem>
                        <SelectItem value="automatic_primary">Automático</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      variant={s.sync_enabled ? "destructive" : "default"}
                      size="sm"
                      onClick={() => toggleSyncMutation.mutate({ id: s.id, enabled: !s.sync_enabled })}
                    >
                      {s.sync_enabled ? "Desabilitar" : "Habilitar"} Sync
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
