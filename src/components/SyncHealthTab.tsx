import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Activity, RefreshCw, CheckCircle, AlertCircle, Clock, Loader2, ShieldCheck,
  BarChart3, AlertTriangle, Wrench, Save
} from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";

interface ReprocessLog {
  id: string;
  entity_type: string;
  account: string;
  reprocess_type: string;
  window_start: string;
  window_end: string;
  status: string;
  upserts_count: number;
  divergences_found: number;
  corrections_applied: number;
  duration_ms: number;
  error_message: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

interface ReprocessConfig {
  id: string;
  key: string;
  value: number;
  description: string;
}

interface HealthData {
  recent_logs: ReprocessLog[];
  config: ReprocessConfig[];
  last_operational: ReprocessLog | null;
  last_strategic: ReprocessLog | null;
  divergence_summary: ReprocessLog[];
}

export function SyncHealthTab() {
  const [selectedAccount, setSelectedAccount] = useState<string>("oben");
  const queryClient = useQueryClient();
  const [editingConfig, setEditingConfig] = useState<Record<string, string>>({});

  const { data: healthData, isLoading } = useQuery({
    queryKey: ["sync-health"],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("sync-reprocess", {
        body: { action: "get_health" },
      });
      if (error) throw error;
      return data?.data as HealthData;
    },
    refetchInterval: 10000,
  });

  const reprocessMutation = useMutation({
    mutationFn: async ({ action, account }: { action: string; account: string }) => {
      const { data, error } = await supabase.functions.invoke("sync-reprocess", {
        body: { action, account },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (data, variables) => {
      toast.success(`Reprocessamento concluído`, {
        description: `${variables.action} - ${JSON.stringify(data?.data || {}).substring(0, 120)}`,
      });
      queryClient.invalidateQueries({ queryKey: ["sync-health"] });
    },
    onError: (error) => {
      toast.error("Erro no reprocessamento", { description: String(error) });
    },
  });

  const updateConfigMutation = useMutation({
    mutationFn: async ({ id, value }: { id: string; value: number }) => {
      const { error } = await supabase
        .from("sync_reprocess_config" as any)
        .update({ value, updated_at: new Date().toISOString() } as any)
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Configuração atualizada");
      queryClient.invalidateQueries({ queryKey: ["sync-health"] });
    },
    onError: (error) => {
      toast.error("Erro ao salvar", { description: String(error) });
    },
  });

  const isRunning = reprocessMutation.isPending;

  const formatDate = (d: string | null) => {
    if (!d) return "Nunca";
    return format(new Date(d), "dd/MM/yyyy HH:mm", { locale: ptBR });
  };

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}min`;
  };

  const getStatusBadge = (status: string) => {
    const map: Record<string, { variant: "default" | "secondary" | "destructive" | "outline"; icon: typeof Clock }> = {
      running: { variant: "default", icon: Loader2 },
      complete: { variant: "outline", icon: CheckCircle },
      error: { variant: "destructive", icon: AlertCircle },
    };
    const cfg = map[status] || map.running;
    const Icon = cfg.icon;
    return (
      <Badge variant={cfg.variant}>
        <Icon className={`h-3 w-3 mr-1 ${status === "running" ? "animate-spin" : ""}`} />
        {status}
      </Badge>
    );
  };

  const totalDivergences = healthData?.divergence_summary?.reduce((sum, l) => sum + (l.divergences_found || 0), 0) || 0;
  const totalCorrections = healthData?.divergence_summary?.reduce((sum, l) => sum + (l.corrections_applied || 0), 0) || 0;

  const handleConfigSave = (id: string) => {
    const val = parseInt(editingConfig[id]);
    if (!isNaN(val)) {
      updateConfigMutation.mutate({ id, value: val });
      setEditingConfig(prev => { const n = { ...prev }; delete n[id]; return n; });
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">Saúde do Sync — Janela Móvel</h2>
        </div>
        <div className="flex items-center gap-3">
          <Select value={selectedAccount} onValueChange={setSelectedAccount}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="oben">Oben</SelectItem>
              <SelectItem value="colacor">Colacor</SelectItem>
            </SelectContent>
          </Select>
          <Button
            size="sm"
            disabled={isRunning}
            onClick={() => reprocessMutation.mutate({ action: "reprocess_all", account: selectedAccount })}
          >
            {isRunning ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RefreshCw className="h-4 w-4 mr-2" />}
            Reprocessar Tudo
          </Button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardContent className="pt-4 text-center">
            <Activity className="h-8 w-8 mx-auto mb-2 text-blue-500" />
            <p className="text-2xl font-bold">{formatDate(healthData?.last_operational?.created_at || null)}</p>
            <p className="text-xs text-muted-foreground">Último Operacional (7d)</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 text-center">
            <BarChart3 className="h-8 w-8 mx-auto mb-2 text-purple-500" />
            <p className="text-2xl font-bold">{formatDate(healthData?.last_strategic?.created_at || null)}</p>
            <p className="text-xs text-muted-foreground">Último Estratégico (30d)</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 text-center">
            <AlertTriangle className="h-8 w-8 mx-auto mb-2 text-amber-500" />
            <p className="text-2xl font-bold">{totalDivergences}</p>
            <p className="text-xs text-muted-foreground">Divergências (30d)</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 text-center">
            <Wrench className="h-8 w-8 mx-auto mb-2 text-emerald-500" />
            <p className="text-2xl font-bold">{totalCorrections}</p>
            <p className="text-xs text-muted-foreground">Correções (30d)</p>
          </CardContent>
        </Card>
      </div>

      {/* Action Buttons */}
      <div className="grid gap-3 md:grid-cols-3">
        <Button
          variant="outline"
          className="w-full"
          disabled={isRunning}
          onClick={() => reprocessMutation.mutate({ action: "reprocess_operational", account: selectedAccount })}
        >
          <Activity className="h-4 w-4 mr-2" />
          Operacional (7d)
        </Button>
        <Button
          variant="outline"
          className="w-full"
          disabled={isRunning}
          onClick={() => reprocessMutation.mutate({ action: "reprocess_strategic", account: selectedAccount })}
        >
          <BarChart3 className="h-4 w-4 mr-2" />
          Estratégico (30d)
        </Button>
        <Button
          variant="outline"
          className="w-full"
          disabled={isRunning}
          onClick={() => reprocessMutation.mutate({ action: "reprocess_inventory", account: selectedAccount })}
        >
          <RefreshCw className="h-4 w-4 mr-2" />
          Apenas Estoque
        </Button>
      </div>

      {/* Config */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Configuração das Janelas</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2">
            {(healthData?.config || []).map((cfg) => {
              const isEditing = editingConfig[cfg.id] !== undefined;
              return (
                <div key={cfg.id} className="p-3 rounded border text-sm space-y-1">
                  <Label className="font-mono text-xs">{cfg.key}</Label>
                  <p className="text-xs text-muted-foreground">{cfg.description}</p>
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      className="h-8 text-sm font-semibold"
                      value={isEditing ? editingConfig[cfg.id] : cfg.value}
                      onChange={(e) => setEditingConfig(prev => ({ ...prev, [cfg.id]: e.target.value }))}
                    />
                    {isEditing && (
                      <Button size="sm" className="h-8 w-8 p-0" onClick={() => handleConfigSave(cfg.id)}>
                        <Save className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Recent Logs */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Histórico de Reprocessamento</CardTitle>
        </CardHeader>
        <CardContent>
          {!healthData?.recent_logs?.length ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              Nenhum reprocessamento executado ainda.
            </p>
          ) : (
            <div className="space-y-2 max-h-96 overflow-y-auto">
              {healthData.recent_logs.map((log) => (
                <div key={log.id} className="p-3 rounded border text-sm flex items-center justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      {getStatusBadge(log.status)}
                      <Badge variant="secondary" className="text-xs">{log.entity_type}</Badge>
                      <Badge variant="outline" className="text-xs">{log.reprocess_type}</Badge>
                      <span className="text-xs text-muted-foreground">{log.account}</span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span>📅 {formatDate(log.created_at)}</span>
                      <span>⏱ {formatDuration(log.duration_ms)}</span>
                      <span>📝 {log.upserts_count} upserts</span>
                      {log.divergences_found > 0 && (
                        <span className="text-amber-600">⚠ {log.divergences_found} diverg.</span>
                      )}
                      {log.corrections_applied > 0 && (
                        <span className="text-emerald-600">✅ {log.corrections_applied} corrig.</span>
                      )}
                    </div>
                    {log.error_message && (
                      <p className="text-xs text-destructive mt-1 truncate">{log.error_message}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
