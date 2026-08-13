import { useState } from 'react';
import { useCompany } from '@/contexts/CompanyContext';
import { useCashflowProjection, type Cenario } from '@/hooks/useCashflowProjection';
import { CenarioToggle } from './CenarioToggle';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatBRL } from '@/lib/financeiro/cashflow-format';

export function NcgDecomposicao() {
  const { activeCompany } = useCompany();
  const [cenario, setCenario] = useState<Cenario>('realista');
  const { data, isLoading, error } = useCashflowProjection(activeCompany, cenario);

  if (isLoading) return <Skeleton className="h-96 w-full" />;
  // A engine passou a RESPONDER ERRO quando uma leitura de fonte money-path falha, em vez
  // de devolver 200 com saldo/estoque/CMV = 0 (money-path §7: consertar a engine torna
  // ALCANÇÁVEL um caminho que antes não existia). Sem este ramo, a falha caía no
  // `if (!data) return null` e a decomposição da NCG sumia da tela sem dizer nada — o
  // operador leria a ausência do bloco como "não há NCG", que é a mesma troca de
  // "não consegui ler" por "não existe" que o fix eliminou uma camada abaixo.
  if (error) {
    return (
      <div className="rounded-md border border-status-error/20 bg-status-error-bg px-3 py-2 text-sm text-status-error-fg">
        NCG indisponível — não foi possível ler os dados desta empresa.{' '}
        <span className="text-xs opacity-80">{String((error as Error).message ?? error)}</span>
      </div>
    );
  }
  if (!data) return null;

  const acoData = [
    { nome: 'CR aberto', valor: data.ncg.aco.cr_aberto, tipo: 'ACO' },
    { nome: 'Estoque', valor: data.ncg.aco.estoque, tipo: 'ACO' },
    { nome: 'Adiantamentos', valor: data.ncg.aco.adiantamentos, tipo: 'ACO' },
    { nome: 'CP fornecedor', valor: data.ncg.pco.cp_fornecedor, tipo: 'PCO' },
    { nome: 'Folha 30d', valor: data.ncg.pco.folha_30d, tipo: 'PCO' },
    { nome: 'Tributos', valor: data.ncg.pco.tributos_a_pagar, tipo: 'PCO' },
  ];

  const proj12Data = data.ncg.projecao_12m;

  return (
    <div className="space-y-4">
      {data.ncg.aco.estoque === 0 && (
        <div className="rounded-md border border-status-warning-fg/30 bg-status-warning-bg px-3 py-2 text-xs text-status-warning">
          ⚠ Estoque não informado — NCG e CCC subestimados. Informe o valor do balancete em Configuração.
        </div>
      )}
      {/* Motivo da degradação: sem isto, uma fonte que FALHOU e um dado que não existe
          produzem o mesmo "—" nos cards de PMR/PMP/CCC abaixo — indistinguíveis. */}
      {(data.confianca_dados?.motivos ?? []).map((motivo) => (
        <div key={motivo} className="rounded-md border border-status-warning-fg/30 bg-status-warning-bg px-3 py-2 text-xs text-status-warning">
          ⚠ {motivo}
        </div>
      ))}
      <div className="flex items-center justify-between">
        <CenarioToggle value={cenario} onChange={setCenario} />
        <div className="text-xs text-muted-foreground">Cenário: <strong>{cenario}</strong></div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader><CardTitle className="text-xs">ACO total</CardTitle></CardHeader>
          <CardContent>
            <div className="text-2xl font-mono">{formatBRL(data.ncg.aco.total)}</div>
            <div className="text-xs text-muted-foreground mt-1">CR + Estoque + Adiantamentos</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-xs">PCO total</CardTitle></CardHeader>
          <CardContent>
            <div className="text-2xl font-mono">{formatBRL(data.ncg.pco.total)}</div>
            <div className="text-xs text-muted-foreground mt-1">CP fornecedor + Folha + Tributos</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-xs">NCG (ACO − PCO)</CardTitle></CardHeader>
          <CardContent>
            <div className={`text-2xl font-mono ${
              data.ncg.valor <= 0
                ? 'text-status-success'
                : data.ncg.valor > data.indicadores.liquidez_operacional_liquida
                ? 'text-status-warning'
                : 'text-foreground'
            }`}>
              {formatBRL(data.ncg.valor)}
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              {data.ncg.valor > data.indicadores.liquidez_operacional_liquida ? '⚠ Excede liquidez operacional' : 'Dentro da liquidez'}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-sm">Decomposição ACO vs PCO</CardTitle></CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={acoData}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="nome" />
              <YAxis />
              <Tooltip formatter={(v: number) => formatBRL(v)} />
              <Bar dataKey="valor">
                {acoData.map((d, i) => (
                  <Cell key={i} fill={d.tipo === 'ACO' ? 'hsl(var(--status-success-bold))' : 'hsl(var(--status-error-bold))'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-sm">Projeção NCG 12 meses</CardTitle></CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={proj12Data}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="mes" />
              <YAxis />
              <Tooltip formatter={(v: number) => formatBRL(v)} />
              <Line type="monotone" dataKey="valor" stroke="hsl(var(--foreground))" strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-sm">Cash Conversion Cycle</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-4 gap-4 text-center">
            <div>
              <div className="text-xs text-muted-foreground">PMR</div>
              <div className="text-xl font-mono">
                {data.indicadores.prazo_medio_recebimento != null ? `${data.indicadores.prazo_medio_recebimento.toFixed(0)}d` : '—'}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">PME</div>
              <div className="text-xl font-mono">{data.indicadores.prazo_medio_estoque.toFixed(0)}d</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">PMP</div>
              <div className="text-xl font-mono">
                {data.indicadores.prazo_medio_pagamento != null ? `${data.indicadores.prazo_medio_pagamento.toFixed(0)}d` : '—'}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">CCC</div>
              <div className={`text-xl font-mono ${data.indicadores.cash_conversion_cycle != null && data.indicadores.cash_conversion_cycle > 60 ? 'text-status-warning' : ''}`}>
                {data.indicadores.cash_conversion_cycle != null ? `${data.indicadores.cash_conversion_cycle.toFixed(0)}d` : '—'}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
