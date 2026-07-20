// Cards de importação em massa: clientes, endereços e pedidos (Omie).
// Extraídos verbatim de src/pages/AdminAnalyticsSync.tsx (god-component split).
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { RefreshCw, Loader2, Sparkles, ShoppingCart, Users, MapPin } from "lucide-react";
import { UltimaExecucao } from "@/components/execucoes/UltimaExecucao";
import { ACOES_ANALYTICS_SYNC } from "./acoes";

export function ImportClientesCard({
  isRunning,
  pending,
  progress,
  onImport,
}: {
  isRunning: boolean;
  pending: boolean;
  progress: string | null;
  onImport: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Users className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-base">Importar Clientes (3 Contas Omie)</CardTitle>
          </div>
          <Button variant="outline" size="sm" disabled={isRunning} onClick={onImport}>
            {pending ? (
              <Loader2 className="h-3 w-3 mr-2 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3 mr-2" />
            )}
            Importar Todos
          </Button>
        </div>
        <UltimaExecucao acao={ACOES_ANALYTICS_SYNC.importarClientes} />
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground">
          Importa todos os clientes das 3 contas Omie (Colacor Afiação, Oben Vendas, Colacor Vendas),
          criando perfis placeholder e mapeamentos em{' '}
          <code className="font-mono">omie_customer_account_map</code> (identidade por conta) e{' '}
          <code className="font-mono">carteira_membership_ledger</code> (membership da carteira).
          Pré-requisito para rodar os motores de inteligência (calculate-scores, algorithm-a-audit).
        </p>
        {progress && (
          <div className="mt-3 flex items-center gap-2 text-xs text-primary font-medium">
            <Loader2 className="h-3 w-3 animate-spin" />
            {progress}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function ImportEnderecosCard({
  isRunning,
  pending,
  progress,
  onSync,
}: {
  isRunning: boolean;
  pending: boolean;
  progress: string | null;
  onSync: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <MapPin className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-base">Sincronizar Endereços do Omie</CardTitle>
          </div>
          <Button variant="outline" size="sm" disabled={isRunning} onClick={onSync}>
            {pending ? (
              <Loader2 className="h-3 w-3 mr-2 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3 mr-2" />
            )}
            Sincronizar Endereços
          </Button>
        </div>
        <UltimaExecucao acao={ACOES_ANALYTICS_SYNC.sincronizarEnderecos} />
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground">
          Busca endereços dos clientes no Omie e popula a tabela <code className="font-mono">addresses</code>.
          Pré-requisito para o roteirizador e funcionalidades que dependem de localização.
        </p>
        {progress && (
          <div className="mt-3 flex items-center gap-2 text-xs text-primary font-medium">
            <Loader2 className="h-3 w-3 animate-spin" />
            {progress}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function ImportPedidosCard({
  isRunning,
  recentPending,
  bulkPending,
  progress,
  onImportRecent,
  onImportAll,
}: {
  isRunning: boolean;
  recentPending: boolean;
  bulkPending: boolean;
  progress: string | null;
  onImportRecent: () => void;
  onImportAll: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShoppingCart className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-base">Importar Pedidos (Oben + Colacor)</CardTitle>
          </div>
          <div className="flex gap-2">
            <Button variant="default" size="sm" disabled={isRunning} onClick={onImportRecent}>
              {recentPending ? (
                <Loader2 className="h-3 w-3 mr-2 animate-spin" />
              ) : (
                <Sparkles className="h-3 w-3 mr-2" />
              )}
              Importar Recentes (180d)
            </Button>
            <Button variant="outline" size="sm" disabled={isRunning} onClick={onImportAll}>
              {bulkPending ? (
                <Loader2 className="h-3 w-3 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3 mr-2" />
              )}
              Importar Todos
            </Button>
          </div>
        </div>
        <UltimaExecucao
          acao={[ACOES_ANALYTICS_SYNC.importarPedidosRecentes, ACOES_ANALYTICS_SYNC.importarPedidosTodos]}
        />
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground">
          <strong>Importar Recentes:</strong> busca apenas pedidos dos últimos 180 dias (rápido, ~2 min).
          <br />
          <strong>Importar Todos:</strong> varre todo o histórico (~425 páginas, pode levar 30+ min).
        </p>
        {progress && (
          <div className="mt-3 flex items-center gap-2 text-xs text-primary font-medium">
            <Loader2 className="h-3 w-3 animate-spin" />
            {progress}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
