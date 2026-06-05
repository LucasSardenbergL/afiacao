import { RotateCcw, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { EmptyState } from '@/components/EmptyState';
import { useParamAutoMudancas, type ParamAutoLog } from '@/hooks/useParamAutoMudancas';

const fmtRs = (n: number | null): string =>
  n == null ? '—' : n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const fmtNum = (n: number | null): string => (n == null ? '—' : n.toLocaleString('pt-BR'));

function StatusBadge({ status }: { status: string }) {
  if (status === 'aplicado') return <Badge variant="outline" className="text-status-success border-status-success/40">aplicado</Badge>;
  if (status === 'segurado') return <Badge variant="outline" className="text-status-warning border-status-warning/40">segurado</Badge>;
  if (status === 'pinado') return <Badge variant="outline" className="text-muted-foreground">pinado</Badge>;
  if (status === 'bloqueado_validacao') return <Badge variant="outline" className="text-status-error border-status-error/40">bloqueado</Badge>;
  return <Badge variant="secondary">{status}</Badge>;
}

function LogRow({
  log,
  empresa,
  onReverter,
  onDespinar,
  reverterPending,
  despinarPending,
}: {
  log: ParamAutoLog;
  empresa: string;
  onReverter: (id: string) => void;
  onDespinar: (skuEmpresa: string, sku: string) => void;
  reverterPending: boolean;
  despinarPending: boolean;
}) {
  const jaRevertido = !!log.revertido_em;
  return (
    <tr className="border-t">
      <td className="py-2 pr-3 align-top">
        <span className="font-tabular text-xs text-muted-foreground">{log.sku_codigo_omie}</span>
        {log.sku_descricao && (
          <span className="block text-xs text-muted-foreground truncate max-w-[180px]">{log.sku_descricao}</span>
        )}
      </td>
      <td className="py-2 pr-3 align-top">
        <StatusBadge status={log.status} />
      </td>
      <td className="py-2 pr-3 align-top font-tabular text-sm">
        {fmtNum(log.ponto_pedido_antes)} → {fmtNum(log.ponto_pedido_depois)}
      </td>
      <td className="py-2 pr-3 align-top font-tabular text-sm">
        {fmtNum(log.estoque_maximo_antes)} → {fmtNum(log.estoque_maximo_depois)}
      </td>
      <td className="py-2 pr-3 text-right align-top font-tabular text-sm">
        {fmtRs(log.impacto_rs)}
      </td>
      <td className="py-2 text-right align-top whitespace-nowrap">
        {jaRevertido ? (
          <div className="flex items-center justify-end gap-2">
            <Badge variant="secondary">revertido</Badge>
            <Button
              size="sm"
              variant="ghost"
              className="text-xs h-7"
              onClick={() => onDespinar(empresa, log.sku_codigo_omie)}
              disabled={despinarPending}
              title="Devolver ao automático (apagar o pin)"
            >
              Voltar ao auto
            </Button>
          </div>
        ) : log.status === 'aplicado' ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-7"
            onClick={() => onReverter(log.id)}
            disabled={reverterPending}
          >
            <RotateCcw className="w-3 h-3 mr-1" />
            Reverter
          </Button>
        ) : null}
      </td>
    </tr>
  );
}

export default function ParamAutoMudancas() {
  const empresa = 'oben';
  const { run, logs, isLoading, reverter, reverterTudo, despinar } = useParamAutoMudancas(empresa);

  if (isLoading) return <PageSkeleton variant="list" />;

  if (!run) {
    return (
      <div className="container mx-auto p-6">
        <EmptyState
          icon={ShieldAlert}
          tone="operational"
          title="Sem mudanças automáticas registradas"
          description="O ajuste automático de parâmetros ainda não rodou hoje ou não há run completo registrado."
        />
      </div>
    );
  }

  const aplicados = logs.filter((l) => l.status === 'aplicado');
  const segurados = logs.filter((l) => l.status === 'segurado');
  const bloqueados = logs.filter((l) => l.status === 'bloqueado_validacao' || l.status === 'pinado');
  const temAplicadosPendentes = aplicados.some((l) => !l.revertido_em);

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Mudanças automáticas de parâmetros</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Run de {run.data_negocio_brt} · {run.total_aplicados ?? 0} aplicadas ·{' '}
            {run.total_segurados ?? 0} seguradas pelo fusível ·{' '}
            impacto estimado{' '}
            <span className="font-tabular">
              {run.impacto_total_rs != null ? fmtRs(run.impacto_total_rs) : '—'}
            </span>
            {(run.impacto_desconhecido_n ?? 0) > 0 && (
              <span className="text-muted-foreground">
                {' '}(+{run.impacto_desconhecido_n} sem custo)
              </span>
            )}
          </p>
        </div>
        {temAplicadosPendentes && (
          <Button
            variant="outline"
            onClick={() => reverterTudo.mutate(run.id)}
            disabled={reverterTudo.isPending}
          >
            <RotateCcw className="w-4 h-4 mr-2" />
            Reverter tudo do dia
          </Button>
        )}
      </div>

      {/* Segurados pelo fusível */}
      {segurados.length > 0 && (
        <section className="rounded-md border border-status-warning/40 bg-status-warning-bg p-4">
          <h2 className="text-sm font-medium text-status-warning mb-2">
            Segurados pelo fusível — confira ({segurados.length})
          </h2>
          <p className="text-xs text-muted-foreground mb-3">
            Estes SKUs tiveram sugestão fora dos limites de segurança (salto &gt;3× ou cobertura &gt;120 dias) e
            NÃO foram alterados. Revise manualmente se a mudança for desejada.
          </p>
          <ul className="space-y-1">
            {segurados.map((l) => (
              <li key={l.id} className="text-sm font-tabular flex items-baseline gap-2">
                <span className="text-muted-foreground min-w-[120px]">{l.sku_codigo_omie}</span>
                <span className="text-foreground truncate flex-1">{l.sku_descricao ?? ''}</span>
                <span className="text-muted-foreground whitespace-nowrap">
                  máx atual {fmtNum(l.estoque_maximo_antes)} · sugestão {fmtNum(l.estoque_maximo_depois)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Tabela de aplicados + outros */}
      {aplicados.length > 0 && (
        <section>
          <h2 className="text-sm font-medium mb-3">Aplicadas (por impacto)</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground text-xs">
                  <th className="pb-2 pr-3 font-medium">SKU</th>
                  <th className="pb-2 pr-3 font-medium">Status</th>
                  <th className="pb-2 pr-3 font-medium">PP (antes → depois)</th>
                  <th className="pb-2 pr-3 font-medium">Máx (antes → depois)</th>
                  <th className="pb-2 pr-3 text-right font-medium">Impacto</th>
                  <th className="pb-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {aplicados.map((log) => (
                  <LogRow
                    key={log.id}
                    log={log}
                    empresa={empresa}
                    onReverter={(id) => reverter.mutate(id)}
                    onDespinar={(emp, sku) => despinar.mutate({ skuEmpresa: emp, sku })}
                    reverterPending={reverter.isPending}
                    despinarPending={despinar.isPending}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Bloqueados / pinados */}
      {bloqueados.length > 0 && (
        <section>
          <h2 className="text-sm font-medium mb-2">Bloqueados ou pinados ({bloqueados.length})</h2>
          <p className="text-xs text-muted-foreground mb-3">
            Estes SKUs não foram alterados — ou por incoerência na sugestão (bloqueado_validacao) ou
            porque o valor sugerido foi revertido manualmente antes (pinado).
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground text-xs">
                  <th className="pb-2 pr-3 font-medium">SKU</th>
                  <th className="pb-2 pr-3 font-medium">Motivo</th>
                  <th className="pb-2 pr-3 font-medium">PP atual</th>
                  <th className="pb-2 pr-3 font-medium">Máx atual</th>
                  <th className="pb-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {bloqueados.map((log) => (
                  <tr key={log.id} className="border-t">
                    <td className="py-2 pr-3 align-top">
                      <span className="font-tabular text-xs text-muted-foreground">{log.sku_codigo_omie}</span>
                      {log.sku_descricao && (
                        <span className="block text-xs text-muted-foreground truncate max-w-[180px]">{log.sku_descricao}</span>
                      )}
                    </td>
                    <td className="py-2 pr-3 align-top">
                      <StatusBadge status={log.status} />
                    </td>
                    <td className="py-2 pr-3 align-top font-tabular text-sm">{fmtNum(log.ponto_pedido_antes)}</td>
                    <td className="py-2 pr-3 align-top font-tabular text-sm">{fmtNum(log.estoque_maximo_antes)}</td>
                    <td className="py-2 text-right align-top">
                      {log.status === 'pinado' && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-xs"
                          onClick={() => despinar.mutate({ skuEmpresa: empresa, sku: log.sku_codigo_omie })}
                          disabled={despinar.isPending}
                          title="Devolver ao automático — remove o pin e permite que o próximo ciclo aplique normalmente"
                        >
                          Voltar ao auto
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {aplicados.length === 0 && bloqueados.length === 0 && segurados.length === 0 && (
        <p className="text-sm text-muted-foreground">Nenhuma alteração relevante neste run.</p>
      )}
    </div>
  );
}
