import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RefreshCw, Database, Package, ShoppingCart, Warehouse, Calculator, Play, CheckCircle, AlertCircle, Clock, Loader2, Save, GitBranch, Sparkles, FlaskConical, Settings, ShieldCheck, Users } from "lucide-react";
import { toast } from "sonner";
import { SyncHealthTab } from "@/components/SyncHealthTab";

type SyncEntity = "customers" | "products" | "orders" | "inventory";
type OmieAccount = "vendas" | "servicos";

interface SyncState {
  id: string;
  entity_type: string;
  account: string;
  last_sync_at: string | null;
  total_synced: number;
  status: string;
  error_message: string | null;
  updated_at: string;
}

const ENTITY_CONFIG: Record<SyncEntity, { label: string; icon: typeof Database; description: string }> = {
  customers: { label: "Clientes", icon: Database, description: "Sincronizar clientes e mapear com perfis locais" },
  products: { label: "Produtos", icon: Package, description: "Catálogo de produtos com família e subfamília" },
  orders: { label: "Pedidos", icon: ShoppingCart, description: "Sync incremental com janela de 24h" },
  inventory: { label: "Estoque", icon: Warehouse, description: "Posição de estoque + CMC para custo" },
};

const STATUS_MAP: Record<string, { variant: "default" | "secondary" | "destructive" | "outline"; icon: typeof Clock }> = {
  idle: { variant: "secondary", icon: Clock },
  running: { variant: "default", icon: Loader2 },
  complete: { variant: "outline", icon: CheckCircle },
  error: { variant: "destructive", icon: AlertCircle },
};

export default function AdminAnalyticsSync() {
  const [selectedAccount, setSelectedAccount] = useState<OmieAccount>("vendas");
  const { user } = useAuth();
  const queryClient = useQueryClient();

  // Check if user has the master CPF for sync health access
  const { data: profileData } = useQuery({
    queryKey: ["profile-doc", user?.id],
    queryFn: async () => {
      if (!user?.id) return null;
      const { data } = await supabase
        .from("profiles")
        .select("document")
        .eq("user_id", user.id)
        .maybeSingle();
      return data;
    },
    enabled: !!user?.id,
  });

  const userDoc = (profileData?.document || "").replace(/\D/g, "");
  const showSyncHealth = userDoc === "01363383647";

  const { data: syncStates, isLoading } = useQuery({
    queryKey: ["sync-state"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sync_state")
        .select("*")
        .order("entity_type");
      if (error) throw error;
      return data as SyncState[];
    },
    refetchInterval: 5000,
  });

  const { data: recConfigs } = useQuery({
    queryKey: ["recommendation-config"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("recommendation_config")
        .select("*")
        .order("key");
      if (error) throw error;
      return data;
    },
  });

  const syncMutation = useMutation({
    mutationFn: async ({ action, account }: { action: string; account: OmieAccount }) => {
      const { data, error } = await supabase.functions.invoke("omie-analytics-sync", {
        body: { action, account },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (data, variables) => {
      toast.success(`Sync ${variables.action} concluído`, {
        description: JSON.stringify(data?.data || {}).substring(0, 100),
      });
      queryClient.invalidateQueries({ queryKey: ["sync-state"] });
    },
    onError: (error) => {
      toast.error("Erro no sync", { description: String(error) });
    },
  });

  const computeCostsMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("omie-analytics-sync", {
        body: { action: "compute_costs" },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      toast.success("Custos recalculados", {
        description: `${data?.data?.updated || 0} produtos atualizados`,
      });
    },
    onError: (error) => {
      toast.error("Erro ao calcular custos", { description: String(error) });
    },
  });

  const assocRulesMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("omie-analytics-sync", {
        body: { action: "compute_association_rules" },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      toast.success("Regras de associação geradas", {
        description: `${data?.data?.rules_generated || 0} regras a partir de ${data?.data?.total_transactions || 0} transações`,
      });
    },
    onError: (error) => {
      toast.error("Erro ao gerar regras", { description: String(error) });
    },
  });

  const updateConfigMutation = useMutation({
    mutationFn: async ({ id, value }: { id: string; value: number }) => {
      const { error } = await supabase
        .from("recommendation_config")
        .update({ value, updated_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Parâmetro atualizado");
      queryClient.invalidateQueries({ queryKey: ["recommendation-config"] });
    },
    onError: (error) => {
      toast.error("Erro ao atualizar", { description: String(error) });
    },
  });

  const [clientSyncProgress, setClientSyncProgress] = useState<string | null>(null);

  const bulkClientSyncMutation = useMutation({
    mutationFn: async () => {
      let accountIndex = 0;
      let startPage = 1;
      let totalImported = 0;
      let totalSkipped = 0;
      let totalErrors = 0;

      while (true) {
        setClientSyncProgress(`Conta ${accountIndex + 1}/3 — página ${startPage}...`);
        const { data, error } = await supabase.functions.invoke("omie-cliente", {
          body: { action: "sync_all_clients", account_index: accountIndex, start_page: startPage },
        });
        if (error) throw error;

        totalImported += data?.imported || 0;
        totalSkipped += data?.skipped || 0;
        totalErrors += data?.errors || 0;

        if (data?.account) {
          setClientSyncProgress(`${data.account}: +${data.imported} importados (pág ${data.lastPage}/${data.totalPages})`);
        }

        if (!data?.hasMore) break;
        accountIndex = data.next.account_index;
        startPage = data.next.start_page;
      }

      setClientSyncProgress(null);
      return { totalImported, totalSkipped, totalErrors };
    },
    onSuccess: (data) => {
      toast.success("Importação de clientes concluída", {
        description: `${data.totalImported} importados, ${data.totalSkipped} já existiam, ${data.totalErrors} erros`,
        duration: 10000,
      });
    },
    onError: (error) => {
      setClientSyncProgress(null);
      toast.error("Erro na importação de clientes", { description: String(error) });
    },
  });

  const [editingConfig, setEditingConfig] = useState<Record<string, string>>({});

  const getStateFor = (entity: string, account: string) =>
    syncStates?.find((s) => s.entity_type === entity && s.account === account);

  const formatDate = (d: string | null) => {
    if (!d) return "Nunca";
    return new Date(d).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
  };

  const isRunning = syncMutation.isPending || computeCostsMutation.isPending || assocRulesMutation.isPending || bulkClientSyncMutation.isPending;

  const handleConfigSave = (id: string) => {
    const val = parseFloat(editingConfig[id]);
    if (!isNaN(val)) {
      updateConfigMutation.mutate({ id, value: val });
      setEditingConfig(prev => { const n = { ...prev }; delete n[id]; return n; });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Sincronização & Analytics</h1>
          <p className="text-sm text-muted-foreground">
            Pipeline de dados Omie → Banco interno → Motor de recomendação
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Select value={selectedAccount} onValueChange={(v) => setSelectedAccount(v as OmieAccount)}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="vendas">Vendas (Oben)</SelectItem>
              <SelectItem value="servicos">Serviços</SelectItem>
            </SelectContent>
          </Select>
          <Button
            onClick={() => syncMutation.mutate({ action: "sync_all", account: selectedAccount })}
            disabled={isRunning}
          >
            {isRunning ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Play className="h-4 w-4 mr-2" />}
            Sync Completo
          </Button>
        </div>
      </div>

      {/* Sync Entities */}
      <div className="grid gap-4 md:grid-cols-2">
        {(Object.entries(ENTITY_CONFIG) as [SyncEntity, typeof ENTITY_CONFIG[SyncEntity]][]).map(
          ([entity, config]) => {
            const state = getStateFor(entity, selectedAccount);
            const statusCfg = STATUS_MAP[state?.status || "idle"];
            const StatusIcon = statusCfg?.icon || Clock;

            return (
              <Card key={entity}>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <config.icon className="h-5 w-5 text-muted-foreground" />
                      <CardTitle className="text-base">{config.label}</CardTitle>
                    </div>
                    <Badge variant={statusCfg?.variant || "secondary"}>
                      <StatusIcon className={`h-3 w-3 mr-1 ${state?.status === "running" ? "animate-spin" : ""}`} />
                      {state?.status || "idle"}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-xs text-muted-foreground">{config.description}</p>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div>
                      <span className="text-muted-foreground">Último sync:</span>
                      <br />
                      <span className="font-medium">{formatDate(state?.last_sync_at || null)}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Registros:</span>
                      <br />
                      <span className="font-medium">{state?.total_synced || 0}</span>
                    </div>
                  </div>
                  {state?.error_message && (
                    <p className="text-xs text-destructive bg-destructive/10 p-2 rounded">
                      {state.error_message.substring(0, 150)}
                    </p>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    disabled={isRunning}
                    onClick={() =>
                      syncMutation.mutate({ action: `sync_${entity}`, account: selectedAccount })
                    }
                  >
                    <RefreshCw className={`h-3 w-3 mr-2 ${isRunning ? "animate-spin" : ""}`} />
                    Sincronizar {config.label}
                  </Button>
                </CardContent>
              </Card>
            );
          }
        )}
      </div>

      {/* Bulk Client Import */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Users className="h-5 w-5 text-muted-foreground" />
              <CardTitle className="text-base">Importar Clientes (3 Contas Omie)</CardTitle>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={isRunning}
              onClick={() => bulkClientSyncMutation.mutate()}
            >
              {bulkClientSyncMutation.isPending ? (
                <Loader2 className="h-3 w-3 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3 mr-2" />
              )}
              Importar Todos
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">
            Importa todos os clientes das 3 contas Omie (Colacor Afiação, Oben Vendas, Colacor Vendas), 
            criando perfis placeholder e mapeamentos em <code className="font-mono">omie_clientes</code>. 
            Pré-requisito para rodar os motores de inteligência (calculate-scores, algorithm-a-audit).
          </p>
          {clientSyncProgress && (
            <div className="mt-3 flex items-center gap-2 text-xs text-primary font-medium">
              <Loader2 className="h-3 w-3 animate-spin" />
              {clientSyncProgress}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Cost Engine */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Calculator className="h-5 w-5 text-muted-foreground" />
              <CardTitle className="text-base">Motor de Custo (Fallback Inteligente)</CardTitle>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={isRunning}
              onClick={() => computeCostsMutation.mutate()}
            >
              <RefreshCw className={`h-3 w-3 mr-2 ${computeCostsMutation.isPending ? "animate-spin" : ""}`} />
              Recalcular Custos
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground mb-3">
            Hierarquia: Custo Produto → CMC (Estoque) → Proxy Família → Proxy Default.
            Divergência {">"} {((recConfigs?.find(c => c.key === "divergence_threshold")?.value || 0.2) * 100).toFixed(0)}%
            aplica heurística estoque vs encomenda.
          </p>
          <div className="grid grid-cols-4 gap-3 text-center text-xs">
            {["PRODUCT_COST", "CMC", "FAMILY_MARGIN_PROXY", "DEFAULT_PROXY"].map((source) => (
              <div key={source} className="p-2 rounded bg-muted">
                <div className="font-medium">{source.replace(/_/g, " ")}</div>
                <div className="text-muted-foreground mt-1">
                  Confiança: {source === "PRODUCT_COST" ? "95%" : source === "CMC" ? "80%" : source === "FAMILY_MARGIN_PROXY" ? "50%" : "25%"}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Association Rules */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <GitBranch className="h-5 w-5 text-muted-foreground" />
              <CardTitle className="text-base">Regras de Associação (Apriori)</CardTitle>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={isRunning}
              onClick={() => assocRulesMutation.mutate()}
            >
              <RefreshCw className={`h-3 w-3 mr-2 ${assocRulesMutation.isPending ? "animate-spin" : ""}`} />
              Recalcular Regras
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">
            Analisa co-ocorrências em pedidos para gerar regras do tipo "quem comprou A também comprou B".
            Filtros: lift ≥ {recConfigs?.find(c => c.key === "l_min")?.value ?? 1.2}, support ≥ {recConfigs?.find(c => c.key === "s_min")?.value ?? 0.01}.
            As regras alimentam o score Assoc(j|B) do motor de recomendação.
          </p>
        </CardContent>
      </Card>

      {/* Engine Config (Editable) */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Settings className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-base">Parâmetros do Motor</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              {(recConfigs || []).map((config) => {
                const isEditing = editingConfig[config.id] !== undefined;
                return (
                  <div key={config.id} className="p-3 rounded border text-sm space-y-2">
                    <div className="font-mono font-medium text-xs">{config.key}</div>
                    <div className="text-xs text-muted-foreground">{config.description}</div>
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        step="0.01"
                        className="h-8 text-sm font-semibold"
                        value={isEditing ? editingConfig[config.id] : config.value}
                        onChange={(e) => setEditingConfig(prev => ({ ...prev, [config.id]: e.target.value }))}
                      />
                      {isEditing && (
                        <Button size="sm" className="h-8 w-8 p-0" onClick={() => handleConfigSave(config.id)}>
                          <Save className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Sync Health Tab - restricted to master CPF */}
      {showSyncHealth && (
        <div className="border-t pt-6 mt-6">
          <SyncHealthTab />
        </div>
      )}
    </div>
  );
}
