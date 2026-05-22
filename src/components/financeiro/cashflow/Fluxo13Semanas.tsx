import { useState } from 'react';
import { useCompany } from '@/contexts/CompanyContext';
import { useCashflowProjection, type Cenario } from '@/hooks/useCashflowProjection';
import { CenarioToggle } from './CenarioToggle';
import { AlertasStack } from './AlertasStack';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Bar, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid } from 'recharts';
import { formatBRL, formatSemana } from '@/lib/financeiro/cashflow-format';

export function Fluxo13Semanas() {
  const { activeCompany } = useCompany();
  const [cenario, setCenario] = useState<Cenario>('realista');
  const { data, isLoading, error } = useCashflowProjection(activeCompany, cenario);

  if (isLoading) return <Skeleton className="h-96 w-full" />;
  if (error) return <div className="text-status-error">Erro: {String((error as Error).message ?? error)}</div>;
  if (!data) return null;

  const chartData = data.semanas.map(s => ({
    semana: formatSemana(s.inicio),
    entradas: Math.round(s.total_entradas),
    saidas: Math.round(s.total_saidas),
    saldo_final: Math.round(s.saldo_final),
  }));

  const FAIXAS_ORDEM = ['a_vencer', '1-30', '31-60', '61-90', '+90'] as const;
  const FAIXA_LABEL: Record<string, string> = {
    'a_vencer': 'A vencer', '1-30': '1–30d', '31-60': '31–60d', '61-90': '61–90d', '+90': '+90d',
  };
  const curvas = data.curvas_aging;
  const temBaixaConfianca = curvas
    ? FAIXAS_ORDEM.some(f => curvas[f] && curvas[f].confianca === 'baixa')
    : false;
  const temPonte = (data.apos_horizonte ?? 0) > 0 || (data.ar_impaired ?? 0) > 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <CenarioToggle value={cenario} onChange={setCenario} />
        <div className="text-xs text-muted-foreground">
          Horizonte: 13 semanas · Cenário: <strong>{cenario}</strong>
        </div>
      </div>

      <AlertasStack />

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Projeção 13 semanas — {cenario}</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={360}>
            <ComposedChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="semana" />
              <YAxis />
              <Tooltip formatter={(v: number) => formatBRL(v)} />
              <Legend />
              <Bar dataKey="entradas" fill="hsl(var(--status-success-bold))" name="Entradas" />
              <Bar dataKey="saidas" fill="hsl(var(--status-error-bold))" name="Saídas" />
              <Line type="monotone" dataKey="saldo_final" stroke="hsl(var(--foreground))" strokeWidth={2} name="Saldo acumulado" />
            </ComposedChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {temPonte && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Recebíveis fora do horizonte de 13 semanas</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="rounded-md border p-3">
                <div className="text-xs text-muted-foreground">Esperado após 13 semanas</div>
                <div className="kpi-value text-lg tabular-nums">{formatBRL(data.apos_horizonte ?? 0)}</div>
                <div className="text-xs text-muted-foreground mt-1">
                  Recebimento estimado para depois do horizonte — não entra no caixa projetado acima.
                </div>
              </div>
              <div className="rounded-md border p-3">
                <div className="text-xs text-muted-foreground">AR impaired (perda esperada)</div>
                <div className="kpi-value text-lg tabular-nums text-status-error">{formatBRL(data.ar_impaired ?? 0)}</div>
                <div className="text-xs text-muted-foreground mt-1">
                  Parcela do CR aberto que a curva de cobrança não espera receber (1 − taxa).
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {curvas && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Curva de cobrança por faixa de aging</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Faixa</TableHead>
                  <TableHead className="text-right">Taxa recebimento</TableHead>
                  <TableHead className="text-right">Lag médio (dias)</TableHead>
                  <TableHead className="text-right">Mediana (dias)</TableHead>
                  <TableHead className="text-right">Exposição</TableHead>
                  <TableHead className="text-center">Confiança</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {FAIXAS_ORDEM.filter(f => curvas[f]).map(f => {
                  const c = curvas[f];
                  return (
                    <TableRow key={f}>
                      <TableCell className="font-medium">{FAIXA_LABEL[f]}</TableCell>
                      <TableCell className="text-right tabular-nums">{(c.taxa_recebimento * 100).toFixed(1)}%</TableCell>
                      <TableCell className="text-right tabular-nums">{c.lag_dias.toFixed(0)}</TableCell>
                      <TableCell className="text-right tabular-nums">{c.lag_mediana.toFixed(0)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatBRL(c.exposicao)}</TableCell>
                      <TableCell className="text-center">
                        {c.confianca === 'alta' ? (
                          <span className="text-xs text-status-success">alta</span>
                        ) : (
                          <span className="text-xs text-status-warning">baixa</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {temBaixaConfianca && (
              <div className="px-4 py-3 text-xs text-status-warning border-t">
                Faixas com confiança <strong>baixa</strong> usam curva default (pouca amostra: &lt;20 títulos,
                volume baixo ou concentração alta num único título). Calibração melhora conforme o histórico cresce.
              </div>
            )}
            <div className="px-4 py-2 text-xs text-muted-foreground border-t">
              Taxa calibrada por <strong>exposição</strong> (pago ÷ R$ que entrou na faixa, incluindo abertos não-pagos) —
              sem viés de "só liquidados".
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Detalhe semana a semana</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Semana</TableHead>
                <TableHead className="text-right">Saldo inicial</TableHead>
                <TableHead className="text-right">Entradas</TableHead>
                <TableHead className="text-right">Saídas</TableHead>
                <TableHead className="text-right">Saldo final</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.semanas.map((s, i) => (
                <TableRow key={i} className={s.saldo_final < 0 ? 'bg-status-error-bg' : ''}>
                  <TableCell className="font-mono text-xs">{formatSemana(s.inicio)} → {formatSemana(s.fim)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatBRL(s.saldo_inicial)}</TableCell>
                  <TableCell className="text-right tabular-nums text-status-success">+{formatBRL(s.total_entradas)}</TableCell>
                  <TableCell className="text-right tabular-nums text-status-error">-{formatBRL(s.total_saidas)}</TableCell>
                  <TableCell className="text-right tabular-nums font-bold">{formatBRL(s.saldo_final)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
