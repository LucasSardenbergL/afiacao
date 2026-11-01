// Cards de importação em massa: clientes, endereços e pedidos (Omie).
// Extraídos verbatim de src/pages/AdminAnalyticsSync.tsx (god-component split).
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { RefreshCw, Loader2, Sparkles, ShoppingCart, Users, MapPin, CheckCircle2, Clock, AlertTriangle, XCircle, RotateCcw } from "lucide-react";
import { UltimaExecucao } from "@/components/execucoes/UltimaExecucao";
import { ACOES_ANALYTICS_SYNC } from "./acoes";
import type { StatusJanelaConta } from "./janelas";
import type { EstadoRodada, StatusRodada } from "./rodadaClientes";

const RODADA_ICON: Record<EstadoRodada, typeof Clock> = {
  executando: Loader2,
  aguardando: Clock,
  atrasada: AlertTriangle,
  falhou: XCircle,
  parcial: AlertTriangle,
  concluida: CheckCircle2,
};
const RODADA_COR: Record<EstadoRodada, string> = {
  executando: "text-primary",
  aguardando: "text-muted-foreground",
  atrasada: "text-status-warning",
  falhou: "text-status-error",
  parcial: "text-status-warning",
  concluida: "text-status-success",
};

export function ImportClientesCard({
  isRunning,
  pending,
  aberta,
  rodadas,
  onImport,
  onRearmar,
  rearmando,
}: {
  isRunning: boolean;
  pending: boolean;
  /** Há rodada aberta no servidor: o botão só abriria a mesma (o servidor garante uma por vez). */
  aberta: boolean;
  rodadas: StatusRodada[];
  onImport: () => void;
  onRearmar: (rodadaId: string) => void;
  rearmando: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Users className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-base">Importar Clientes (3 Contas Omie)</CardTitle>
          </div>
          <Button variant="outline" size="sm" disabled={isRunning || aberta} onClick={onImport}>
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
          Roda no servidor e também sozinho todo domingo.
        </p>
        {aberta && (
          <p className="mt-3 text-xs font-medium text-primary" data-testid="clientes-import-servidor">
            Importando no servidor — pode fechar esta aba.
          </p>
        )}
        {rodadas.length > 0 && (
          <ul className="mt-2 space-y-1.5">
            {rodadas.map((r) => {
              const Icone = RODADA_ICON[r.estado];
              return (
                <li key={r.id} className={`flex items-start gap-2 text-xs ${RODADA_COR[r.estado]}`} data-testid={`rodada-${r.estado}`}>
                  <Icone className={`h-3 w-3 mt-0.5 shrink-0 ${r.estado === "executando" ? "animate-spin" : ""}`} />
                  <span className="flex-1">{r.descricao}</span>
                  {r.podeRearmar && (
                    <Button variant="ghost" size="sm" className="h-6 px-2" disabled={rearmando || aberta} onClick={() => onRearmar(r.id)}>
                      <RotateCcw className="h-3 w-3 mr-1" />
                      Retomar
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
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

const JANELA_ICON = {
  rodando: <Loader2 className="h-3 w-3 animate-spin text-primary" />,
  aguardando: <Clock className="h-3 w-3 text-muted-foreground" />,
  falhando: <AlertTriangle className="h-3 w-3 text-status-warning" />,
  falhou: <XCircle className="h-3 w-3 text-status-error" />,
  concluida: <CheckCircle2 className="h-3 w-3 text-status-success" />,
} as const;

export function ImportPedidosCard({
  isRunning,
  recentPending,
  bulkPending,
  importandoEmAndamento,
  janelas,
  onImportRecent,
  onImportAll,
  onRearmar,
  rearmando = false,
}: {
  isRunning: boolean;
  recentPending: boolean;
  bulkPending: boolean;
  /** Há janela aberta no vendas_sync_cursor — o servidor ainda está importando. */
  importandoEmAndamento: boolean;
  janelas: StatusJanelaConta[];
  onImportRecent: () => void;
  onImportAll: () => void;
  /** Re-arma uma janela TERMINAL (falhou) — ação sobre UM registro, estado no próprio cursor. */
  onRearmar?: (janela: StatusJanelaConta) => void;
  rearmando?: boolean;
}) {
  const desabilitado = isRunning || importandoEmAndamento;
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShoppingCart className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-base">Importar Pedidos (Oben + Colacor)</CardTitle>
          </div>
          <div className="flex gap-2">
            <Button variant="default" size="sm" disabled={desabilitado} onClick={onImportRecent}>
              {recentPending ? (
                <Loader2 className="h-3 w-3 mr-2 animate-spin" />
              ) : (
                <Sparkles className="h-3 w-3 mr-2" />
              )}
              Importar Recentes (180d)
            </Button>
            <Button variant="outline" size="sm" disabled={desabilitado} onClick={onImportAll}>
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
          O clique <strong>arma a janela</strong> no servidor (cursor + cron a cada 6 min) e a importação roda em
          segundo plano — <strong>pode fechar a aba</strong> e acompanhar o progresso aqui.
          <br />
          <strong>Importar Recentes:</strong> últimos 180 dias (~40–60 min no servidor).
          <br />
          <strong>Importar Todos:</strong> histórico completo desde 2015 (algumas horas no servidor).
        </p>
        {janelas.length > 0 && (
          <div className="mt-3 space-y-1.5">
            {importandoEmAndamento && (
              <div className="flex items-center gap-2 text-xs text-primary font-medium">
                <Loader2 className="h-3 w-3 animate-spin" />
                Importando no servidor — pode fechar esta aba.
              </div>
            )}
            {janelas.map((j) => (
              <div
                key={`${j.account}-${j.janela}`}
                className={`flex flex-wrap items-center gap-2 text-xs ${j.estado === "falhou" ? "text-status-error" : "text-muted-foreground"}`}
              >
                {JANELA_ICON[j.estado]}
                <span className="font-medium text-foreground">{j.account}</span>
                <span>{j.janela}</span>
                <span>— {j.descricao}</span>
                {j.estado === "falhou" && j.podeRearmar && onRearmar && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    disabled={rearmando}
                    onClick={() => onRearmar(j)}
                  >
                    <RotateCcw className="h-3 w-3 mr-1" />
                    Re-tentar
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
