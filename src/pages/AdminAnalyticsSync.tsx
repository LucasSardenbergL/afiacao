import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Play, Loader2 } from "lucide-react";
import { type OmieAccount } from "@/components/analyticsSync/types";
import { useAnalyticsSync } from "@/components/analyticsSync/useAnalyticsSync";
import { SyncEntitiesGrid } from "@/components/analyticsSync/SyncEntitiesGrid";
import { ImportClientesCard, ImportEnderecosCard, ImportPedidosCard } from "@/components/analyticsSync/ImportCards";
import { CostEngineCard, AssociationRulesCard } from "@/components/analyticsSync/EngineCards";
import { EngineConfigCard } from "@/components/analyticsSync/EngineConfigCard";
import { ACOES_ANALYTICS_SYNC } from "@/components/analyticsSync/acoes";
import { UltimaExecucao } from "@/components/execucoes/UltimaExecucao";
import { CarteiraSaudePanel } from "@/components/carteira/CarteiraSaudePanel";

export default function AdminAnalyticsSync() {
  const {
    selectedAccount,
    setSelectedAccount,
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
  } = useAnalyticsSync();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Sincronização & Analytics</h1>
          <p className="text-sm text-muted-foreground">
            Pipeline de dados Omie → Banco interno → Motor de recomendação
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
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
          <UltimaExecucao acao={ACOES_ANALYTICS_SYNC.syncCompleto} />
        </div>
      </div>

      {/* Saúde da carteira (observabilidade — semáforo) */}
      <CarteiraSaudePanel />

      {/* Sync Entities */}
      <SyncEntitiesGrid
        selectedAccount={selectedAccount}
        getStateFor={getStateFor}
        formatDate={formatDate}
        isRunning={isRunning}
        onSync={(entity) => syncMutation.mutate({ action: `sync_${entity}`, account: selectedAccount })}
      />

      {/* Bulk Client Import */}
      <ImportClientesCard
        isRunning={isRunning}
        pending={bulkClientSyncMutation.isPending}
        progress={clientSyncProgress}
        onImport={() => bulkClientSyncMutation.mutate()}
      />

      {/* Address Sync from Omie */}
      <ImportEnderecosCard
        isRunning={isRunning}
        pending={addressSyncMutation.isPending}
        progress={addressSyncProgress}
        onSync={() => addressSyncMutation.mutate()}
      />

      <ImportPedidosCard
        isRunning={isRunning}
        recentPending={recentOrdersSyncMutation.isPending}
        bulkPending={bulkOrdersSyncMutation.isPending}
        progress={ordersSyncProgress}
        onImportRecent={() => recentOrdersSyncMutation.mutate()}
        onImportAll={() => bulkOrdersSyncMutation.mutate()}
      />

      {/* Cost Engine */}
      <CostEngineCard
        isRunning={isRunning}
        pending={computeCostsMutation.isPending}
        recConfigs={recConfigs}
        onRecalcular={() => computeCostsMutation.mutate()}
      />

      {/* Association Rules */}
      <AssociationRulesCard
        isRunning={isRunning}
        pending={assocRulesMutation.isPending}
        recConfigs={recConfigs}
        onRecalcular={() => assocRulesMutation.mutate()}
      />

      {/* Engine Config (Editable) */}
      <EngineConfigCard
        isLoading={isLoading}
        recConfigs={recConfigs}
        editingConfig={editingConfig}
        setEditingConfig={setEditingConfig}
        onSave={handleConfigSave}
      />
    </div>
  );
}
