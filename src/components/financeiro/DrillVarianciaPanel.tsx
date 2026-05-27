import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { TrendingUp, TrendingDown } from 'lucide-react';
import type { DrillResult } from '@/lib/financeiro/orcamento-drill-helpers';

const fmt = (n: number) =>
  n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });

const QUALIDADE_META: Record<DrillResult['qualidade'], { label: string; cls: string; aviso: string | null }> = {
  ok: { label: 'Reconcilia', cls: 'text-status-success border-status-success/50', aviso: null },
  parcial: {
    label: 'Drill parcial',
    cls: 'text-status-warning border-status-warning/50',
    aviso: 'Drill parcial — as categorias não reconciliam totalmente com o DRE neste período.',
  },
  diagnostico: {
    label: 'Modo diagnóstico',
    cls: 'text-status-error border-status-error/50',
    aviso: 'Não reconcilia com o DRE — leia como diagnóstico, não como explicação fechada da variância.',
  },
};

/**
 * Painel do drill de variância por categoria (realizado YTD), aberto inline sob uma
 * linha do Forecast que furou a meta. Honesto por design (Codex): explica o realizado
 * YTD, NÃO a variância anual (landing); sempre exibe a reconciliação contra o snapshot.
 */
export function DrillVarianciaPanel({
  result,
  isLoading,
  isError,
  ano,
}: {
  result: DrillResult | null | undefined;
  isLoading: boolean;
  isError: boolean;
  ano: number;
}) {
  if (isLoading) {
    return (
      <div className="space-y-2 py-3">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    );
  }
  if (isError) {
    return (
      <p className="py-3 text-sm text-status-error">
        Não foi possível carregar as categorias deste período. Recolha e abra de novo para tentar.
      </p>
    );
  }
  if (!result) return null;

  const q = QUALIDADE_META[result.qualidade];

  return (
    <div className="space-y-3 py-2 text-sm">
      {/* Reconciliação — contrato sempre visível */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border bg-muted/30 px-3 py-2 text-xs">
        <Badge variant="outline" className={`text-[10px] ${q.cls}`}>{q.label}</Badge>
        <span className="text-muted-foreground">
          Realizado DRE (YTD): <span className="font-medium text-foreground">{fmt(result.realizado_snapshot)}</span>
        </span>
        <span className="text-muted-foreground">
          Soma das categorias: <span className="font-medium text-foreground">{fmt(result.total_decomposto)}</span>
        </span>
        <span className="text-muted-foreground">
          Resíduo: <span className="font-medium text-foreground">{fmt(result.residuo)}</span>
          {result.residuo_perc !== null && ` (${(result.residuo_perc * 100).toFixed(1)}%)`}
        </span>
      </div>
      {q.aviso && <p className="text-xs text-status-warning">{q.aviso}</p>}

      {/* Componentes do realizado YTD */}
      {result.componentes.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Sem categorias mapeadas para esta linha neste período. (O realizado pode vir de
          movimentações ou de categorias não mapeadas — veja o resíduo acima.)
        </p>
      ) : (
        <div className="overflow-x-auto">
          <p className="mb-1 text-xs font-medium text-muted-foreground">
            Principais componentes do realizado YTD (variações vs {ano - 1}, mesmos meses fechados)
          </p>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b text-muted-foreground">
                <th className="py-1 text-left font-normal">Categoria</th>
                <th className="py-1 text-right font-normal">Realizado YTD</th>
                <th className="py-1 text-right font-normal">{ano - 1}</th>
                <th className="py-1 text-right font-normal">Δ vs {ano - 1}</th>
                <th className="py-1 text-right font-normal">% do total</th>
              </tr>
            </thead>
            <tbody>
              {result.componentes.map((c) => (
                <tr key={c.categoria_codigo} className="border-b border-border/50">
                  <td className="py-1 pr-2">
                    <span className="font-tabular text-muted-foreground">{c.categoria_codigo}</span>{' '}
                    {c.categoria_descricao}
                  </td>
                  <td className="py-1 text-right tabular-nums">{fmt(c.realizado_ytd)}</td>
                  <td className="py-1 text-right tabular-nums text-muted-foreground">
                    {fmt(c.realizado_ytd_ano_anterior)}
                  </td>
                  <td
                    className={`py-1 text-right tabular-nums ${
                      c.delta > 0 ? 'text-status-error' : c.delta < 0 ? 'text-status-success' : 'text-muted-foreground'
                    }`}
                  >
                    <span className="inline-flex items-center gap-0.5">
                      {c.delta > 0 ? <TrendingUp className="h-3 w-3" /> : c.delta < 0 ? <TrendingDown className="h-3 w-3" /> : null}
                      {fmt(c.delta)}
                      {c.delta_perc !== null && ` (${(c.delta_perc * 100).toFixed(0)}%)`}
                    </span>
                  </td>
                  <td className="py-1 text-right tabular-nums text-muted-foreground">
                    {(c.peso_perc * 100).toFixed(0)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Forecast restante — não decomposto, explícito */}
      {result.forecast_nao_decomposto !== 0 && (
        <p className="text-xs text-muted-foreground">
          + Forecast dos meses restantes (não decomposto por categoria):{' '}
          <span className="font-medium text-foreground">{fmt(result.forecast_nao_decomposto)}</span>
        </p>
      )}
    </div>
  );
}
