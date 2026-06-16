// Notificações — disparo de alertas via Gmail + Google Calendar (fornecedor_alerta).
// Composição: useNotificacoes (queries/mutation/memos) + tabs + drawer.
// God-component split de src/pages/AdminNotificacoes.tsx (comportamento 1:1).
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useNotificacoes } from '@/components/notificacoes/useNotificacoes';
import { DispatchButton } from '@/components/notificacoes/DispatchButton';
import { PendentesTab } from '@/components/notificacoes/PendentesTab';
import { HistoricoTab } from '@/components/notificacoes/HistoricoTab';
import { StatsTab } from '@/components/notificacoes/StatsTab';
import { AlertaDrawer } from '@/components/notificacoes/AlertaDrawer';

export default function AdminNotificacoes() {
  const {
    drawerAlerta,
    setDrawerAlerta,
    filtroSev,
    setFiltroSev,
    filtroEmpresa,
    setFiltroEmpresa,
    filtroTipo,
    setFiltroTipo,
    pendentes,
    loadingPend,
    historico,
    loadingHist,
    loadingStats,
    dispatchPending,
    dispatch,
    empresasOpts,
    tiposOpts,
    pendentesFiltrados,
    total7d,
    taxaSucesso,
    esgotados,
    chartData,
  } = useNotificacoes();

  return (
    <div className="container mx-auto p-4 lg:p-6 space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Notificações</h1>
          <p className="text-sm text-muted-foreground">
            Disparo de alertas via Gmail + Google Calendar (sobre fornecedor_alerta).
          </p>
        </div>
        <DispatchButton isPending={dispatchPending} onDispatch={dispatch} />
      </div>

      <Tabs defaultValue="pendentes">
        <TabsList>
          <TabsTrigger value="pendentes">
            Pendentes {pendentes ? `(${pendentes.length})` : ''}
          </TabsTrigger>
          <TabsTrigger value="historico">Histórico</TabsTrigger>
          <TabsTrigger value="stats">Estatísticas</TabsTrigger>
        </TabsList>

        {/* PENDENTES */}
        <TabsContent value="pendentes" className="space-y-4">
          <PendentesTab
            loading={loadingPend}
            pendentesFiltrados={pendentesFiltrados}
            filtroSev={filtroSev}
            onFiltroSevChange={setFiltroSev}
            filtroEmpresa={filtroEmpresa}
            onFiltroEmpresaChange={setFiltroEmpresa}
            filtroTipo={filtroTipo}
            onFiltroTipoChange={setFiltroTipo}
            empresasOpts={empresasOpts}
            tiposOpts={tiposOpts}
            onSelectAlerta={setDrawerAlerta}
          />
        </TabsContent>

        {/* HISTÓRICO */}
        <TabsContent value="historico" className="space-y-4">
          <HistoricoTab
            loading={loadingHist}
            historico={historico}
            onSelectAlerta={setDrawerAlerta}
          />
        </TabsContent>

        {/* STATS */}
        <TabsContent value="stats" className="space-y-4">
          <StatsTab
            loading={loadingStats}
            total7d={total7d}
            taxaSucesso={taxaSucesso}
            esgotados={esgotados}
            chartData={chartData}
          />
        </TabsContent>
      </Tabs>

      {/* DRAWER */}
      <AlertaDrawer alerta={drawerAlerta} onOpenChange={(o) => !o && setDrawerAlerta(null)} />
    </div>
  );
}
