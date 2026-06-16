// Grade de cards de sincronização por entidade (clientes/produtos/pedidos/estoque).
// Extraída verbatim de src/pages/AdminAnalyticsSync.tsx (god-component split).
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RefreshCw, Clock } from "lucide-react";
import { ENTITY_CONFIG, STATUS_MAP, type SyncEntity, type SyncState } from "./types";

interface SyncEntitiesGridProps {
  selectedAccount: string;
  getStateFor: (entity: string, account: string) => SyncState | undefined;
  formatDate: (d: string | null) => string;
  isRunning: boolean;
  onSync: (entity: SyncEntity) => void;
}

export function SyncEntitiesGrid({ selectedAccount, getStateFor, formatDate, isRunning, onSync }: SyncEntitiesGridProps) {
  return (
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
                  onClick={() => onSync(entity)}
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
  );
}
