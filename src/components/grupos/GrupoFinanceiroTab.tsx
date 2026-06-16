import { Loader2, Info } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useGrupoFinanceiro } from '@/queries/useGrupoFinanceiro';
import { formatDoc, formatBRL } from '@/lib/grupos/format';

function Metric({ label, valor, tone }: { label: string; valor: number; tone?: 'warning' | 'error' }) {
  const color = tone === 'error' ? 'text-status-error' : tone === 'warning' ? 'text-status-warning' : 'text-foreground';
  return (
    <Card>
      <CardContent className="p-3">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className={`mt-0.5 text-lg font-semibold tabular-nums ${color}`}>{formatBRL(valor)}</p>
      </CardContent>
    </Card>
  );
}

export function GrupoFinanceiroTab({ grupoId }: { grupoId: string }) {
  const { data, isLoading, error } = useGrupoFinanceiro(grupoId);

  if (isLoading) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (error) {
    return <p className="text-sm text-status-error">Não consegui carregar o financeiro: {error instanceof Error ? error.message : 'erro'}.</p>;
  }

  const r = data!.resumo;
  const semTitulo = r.total_aberto === 0 && data!.porDoc.length === 0;

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-md border border-status-info/30 bg-status-info/5 px-3 py-2 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-info" />
        <span>Visão consolidada — a cobrança é emitida no Omie por documento; aqui é só a soma dos {r.documentos_com_titulo} documento(s) com título em aberto.</span>
      </div>

      {semTitulo ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Nenhum recebível em aberto pros documentos deste grupo.
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Exposição total + aging */}
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">Exposição total (em aberto)</p>
              <p className="mt-0.5 text-3xl font-bold tabular-nums">{formatBRL(r.total_aberto)}</p>
            </CardContent>
          </Card>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <Metric label="A vencer" valor={r.a_vencer} />
            <Metric label="Vencido 1–30" valor={r.venc_1_30} tone="warning" />
            <Metric label="Vencido 31–60" valor={r.venc_31_60} tone="warning" />
            <Metric label="Vencido 61–90" valor={r.venc_61_90} tone="error" />
            <Metric label="Vencido 90+" valor={r.venc_90_mais} tone="error" />
          </div>

          {/* Por documento (expor a composição) */}
          <div className="space-y-1.5">
            <h3 className="text-sm font-medium text-muted-foreground">Por documento</h3>
            {data!.porDoc.map((d) => (
              <div key={`${d.documento}-${d.company ?? ''}`} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="font-mono">{formatDoc(d.documento)}</span>
                  {d.company && <Badge variant="outline" className="shrink-0 uppercase">{d.company}</Badge>}
                  {d.nome_cliente && <span className="truncate text-muted-foreground">{d.nome_cliente}</span>}
                </div>
                <div className="shrink-0 text-right tabular-nums">
                  <span className="font-medium">{formatBRL(d.total_aberto)}</span>
                  {d.vencido > 0 && <span className="ml-2 text-xs text-status-error">({formatBRL(d.vencido)} vencido)</span>}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
