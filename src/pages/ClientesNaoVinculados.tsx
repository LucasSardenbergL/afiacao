import { RefreshCw, UserX, Download } from 'lucide-react';
import { Card, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/EmptyState';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { useAuth } from '@/contexts/AuthContext';
import { useClientesNaoVinculados } from '@/hooks/useClientesNaoVinculados';
import { useRefreshClientesNaoVinculados } from '@/hooks/useRefreshClientesNaoVinculados';
import { useExportNaoVinculados } from '@/hooks/useExportNaoVinculados';

function formatFrescor(iso: string | null): string {
  if (!iso) return 'nunca sincronizado';
  return `atualizado em ${new Date(iso).toLocaleString('pt-BR')}`;
}

export default function ClientesNaoVinculados() {
  const { isMaster, isGestorComercial } = useAuth();
  const podeVer = isMaster || isGestorComercial;
  const { data, isLoading } = useClientesNaoVinculados();
  const refresh = useRefreshClientesNaoVinculados();
  const exportar = useExportNaoVinculados();

  if (!podeVer) {
    return (
      <div className="p-4">
        <EmptyState
          icon={UserX}
          tone="operational"
          title="Sem permissão"
          description="Esta tela é restrita a master e gestão comercial."
        />
      </div>
    );
  }

  if (isLoading) return <PageSkeleton variant="list" />;

  const state = data?.state ?? null;
  const lista = data?.lista ?? [];
  // total real vem do estado do run; a lista é capada (PostgREST ~1000 linhas).
  const total = state?.total ?? lista.length;
  const running = state?.status === 'running';
  const erro = state?.status === 'error';
  const nuncaSync = !state?.last_complete_synced_at;

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-display font-medium">
            Clientes não-vinculados (Oben)
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Clientes no Omie sem conta no app — alvos pra convidar/criar conta. {formatFrescor(state?.last_complete_synced_at ?? null)}.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            size="sm"
            variant="outline"
            onClick={() => exportar.mutate()}
            disabled={total === 0 || exportar.isPending}
          >
            <Download className="w-4 h-4 mr-2" />
            {exportar.isPending ? 'Exportando…' : 'Exportar CSV'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => refresh.mutate()}
            disabled={running || refresh.isPending}
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${running ? 'animate-spin' : ''}`} />
            {running ? 'Atualizando…' : 'Atualizar'}
          </Button>
        </div>
      </header>

      {erro && (
        <Card className="border-status-error">
          <CardHeader className="py-3">
            <p className="text-sm text-status-error">
              A última atualização falhou. O relatório abaixo é do último run completo (pode estar velho).
            </p>
            {state?.error_message && (
              <p className="text-2xs text-muted-foreground font-mono mt-1 break-all">{state.error_message}</p>
            )}
          </CardHeader>
        </Card>
      )}

      {running && (
        <Card>
          <CardHeader className="py-3">
            <p className="text-sm text-muted-foreground">
              Enumerando os clientes do Omie… isso pode levar ~1 min. A lista atualiza sozinha quando terminar.
            </p>
          </CardHeader>
        </Card>
      )}

      {nuncaSync && !running ? (
        <EmptyState
          icon={UserX}
          tone="operational"
          title="Ainda não sincronizado"
          description="Clique em Atualizar pra enumerar os clientes do Omie e montar o relatório."
        />
      ) : total === 0 && !running ? (
        <EmptyState
          icon={UserX}
          tone="operational"
          title="Nenhum cliente não-vinculado 🎉"
          description="No último sync, todos os clientes do Omie (Oben) já têm conta no app."
        />
      ) : (
        <Card>
          <CardHeader className="pb-2">
            <h2 className="text-base font-medium">{total.toLocaleString('pt-BR')} clientes sem conta</h2>
            {lista.length < total && (
              <p className="text-2xs text-muted-foreground">mostrando os primeiros {lista.length.toLocaleString('pt-BR')}</p>
            )}
          </CardHeader>
          <div className="divide-y divide-border">
            {lista.map((c) => (
              <div key={c.id} className="p-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">
                    {c.razao_social ?? c.nome_fantasia ?? `Cliente Omie ${c.omie_codigo_cliente}`}
                  </div>
                  <div className="text-2xs text-muted-foreground font-tabular">
                    {c.cnpj_cpf || 'sem documento'}
                    {(c.cidade || c.uf) && ` · ${[c.cidade, c.uf].filter(Boolean).join('/')}`}
                  </div>
                </div>
                {c.codigo_vendedor != null && (
                  <Badge variant="outline" className="text-2xs shrink-0">vend. {c.codigo_vendedor}</Badge>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
