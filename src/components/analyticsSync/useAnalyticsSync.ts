// Lógica da tela de Sincronização & Analytics (queries, mutations, sync orquestrado).
// Extraída verbatim de src/pages/AdminAnalyticsSync.tsx (god-component split).
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import { OmieAccount, SyncState } from "./types";

export type RecConfigs = ReturnType<typeof useAnalyticsSync>["recConfigs"];

export function useAnalyticsSync() {
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

  const addressSyncMutation = useMutation({
    mutationFn: async () => {
      let totalSynced = 0;
      let totalSkipped = 0;
      let totalErrors = 0;
      let totalNeeding = 0;
      let hasMore = true;
      let iteration = 0;

      while (hasMore) {
        iteration++;
        setAddressSyncProgress(`Sincronizando endereços... (lote ${iteration}, ${totalSynced} criados)`);
        const { data, error } = await supabase.functions.invoke("omie-cliente", {
          body: { action: "sync_addresses", batch_size: 30 },
        });
        if (error) throw error;

        totalSynced += data?.synced || 0;
        totalSkipped += data?.skipped || 0;
        totalErrors += data?.errors || 0;
        totalNeeding = data?.totalNeeding || 0;
        hasMore = data?.hasMore || false;

        // Safety: if batch produced 0 synced AND 0 skipped AND 0 errors, stop to avoid infinite loop
        if ((data?.synced || 0) === 0 && (data?.skipped || 0) === 0 && (data?.errors || 0) === 0) {
          hasMore = false;
        }
      }

      setAddressSyncProgress(null);
      return { synced: totalSynced, skipped: totalSkipped, errors: totalErrors, totalNeeding };
    },
    onSuccess: (data) => {
      toast.success("Sincronização de endereços concluída", {
        description: `${data?.synced || 0} endereços criados, ${data?.skipped || 0} ignorados, ${data?.errors || 0} erros (de ${data?.totalNeeding || 0} pendentes)`,
        duration: 10000,
      });
    },
    onError: (error) => {
      setAddressSyncProgress(null);
      toast.error("Erro na sincronização de endereços", { description: String(error) });
    },
  });

  const [editingConfig, setEditingConfig] = useState<Record<string, string>>({});
  const [addressSyncProgress, setAddressSyncProgress] = useState<string | null>(null);
  const [ordersSyncProgress, setOrdersSyncProgress] = useState<string | null>(null);

  // Helper to format date as DD/MM/YYYY
  const formatOmieDate = (date: Date) => {
    const dd = String(date.getDate()).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const yyyy = date.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
  };

  const runOrdersSync = async (dateFrom?: string, dateTo?: string) => {
    const accounts: Array<{ name: string; account: string }> = [
      { name: "Oben", account: "oben" },
      { name: "Colacor", account: "colacor" },
    ];
    let grandTotalSynced = 0;
    let grandTotalItems = 0;
    let grandTotalSkipped = 0;

    for (const acc of accounts) {
      let startPage = 1;
      let complete = false;

      while (!complete) {
        setOrdersSyncProgress(`${acc.name}: página ${startPage}...`);
        const { data, error } = await supabase.functions.invoke("omie-vendas-sync", {
          body: {
            action: "sync_pedidos",
            account: acc.account,
            start_page: startPage,
            max_pages: 10,
            ...(dateFrom && { date_from: dateFrom }),
            ...(dateTo && { date_to: dateTo }),
          },
        });
        if (error) throw new Error(`${acc.name}: ${error.message}`);

        grandTotalSynced += data?.totalSynced || 0;
        grandTotalItems += data?.totalItems || 0;
        grandTotalSkipped += data?.skippedNoClient || 0;

        const lastPage = data?.lastPage || startPage;
        const totalPages = data?.totalPaginas || 1;
        setOrdersSyncProgress(`${acc.name}: pág ${lastPage}/${totalPages} — ${grandTotalSynced} pedidos importados`);

        if (data?.complete || !data?.nextPage) {
          complete = true;
        } else {
          startPage = data.nextPage;
        }
      }
    }

    // Refresh materialized view after import. Via o WRAPPER staff request_customer_metrics_refresh:
    // o primitive refresh_customer_metrics passou a ser service-only (cron/edge). supabase-js NÃO
    // lança → checar o erro (antes era engolido). O cron a cada 6h cobre o frescor de base.
    setOrdersSyncProgress("Atualizando métricas de clientes...");
    const { error: refreshError } = await supabase.rpc("request_customer_metrics_refresh");
    if (refreshError) throw new Error(`Falha ao atualizar métricas de clientes: ${refreshError.message}`);

    setOrdersSyncProgress(null);
    return { grandTotalSynced, grandTotalItems, grandTotalSkipped };
  };

  const bulkOrdersSyncMutation = useMutation({
    mutationFn: () => runOrdersSync(),
    onSuccess: (data) => {
      toast.success("Importação de pedidos concluída", {
        description: `${data.grandTotalSynced} pedidos, ${data.grandTotalItems} itens, ${data.grandTotalSkipped} sem cliente`,
        duration: 10000,
      });
      queryClient.invalidateQueries({ queryKey: ["sync-state"] });
    },
    onError: (error) => {
      setOrdersSyncProgress(null);
      toast.error("Erro na importação de pedidos", { description: String(error) });
    },
  });

  const recentOrdersSyncMutation = useMutation({
    mutationFn: () => {
      const now = new Date();
      const from = new Date(now);
      from.setDate(from.getDate() - 180);
      return runOrdersSync(formatOmieDate(from), formatOmieDate(now));
    },
    onSuccess: (data) => {
      toast.success("Importação recente concluída", {
        description: `${data.grandTotalSynced} pedidos, ${data.grandTotalItems} itens`,
        duration: 10000,
      });
      queryClient.invalidateQueries({ queryKey: ["sync-state"] });
    },
    onError: (error) => {
      setOrdersSyncProgress(null);
      toast.error("Erro na importação recente", { description: String(error) });
    },
  });

  const getStateFor = (entity: string, account: string) =>
    syncStates?.find((s) => s.entity_type === entity && s.account === account);

  const formatDate = (d: string | null) => {
    if (!d) return "Nunca";
    return new Date(d).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
  };

  const isRunning = syncMutation.isPending || computeCostsMutation.isPending || assocRulesMutation.isPending || bulkClientSyncMutation.isPending || bulkOrdersSyncMutation.isPending || recentOrdersSyncMutation.isPending || addressSyncMutation.isPending;

  const handleConfigSave = (id: string) => {
    const val = parseFloat(editingConfig[id]);
    if (!isNaN(val)) {
      updateConfigMutation.mutate({ id, value: val });
      setEditingConfig(prev => { const n = { ...prev }; delete n[id]; return n; });
    }
  };

  return {
    selectedAccount,
    setSelectedAccount,
    showSyncHealth,
    syncStates,
    isLoading,
    recConfigs,
    syncMutation,
    computeCostsMutation,
    assocRulesMutation,
    bulkClientSyncMutation,
    addressSyncMutation,
    bulkOrdersSyncMutation,
    recentOrdersSyncMutation,
    clientSyncProgress,
    addressSyncProgress,
    ordersSyncProgress,
    editingConfig,
    setEditingConfig,
    getStateFor,
    formatDate,
    isRunning,
    handleConfigSave,
  };
}
