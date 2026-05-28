import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { TrendingUp, TrendingDown } from 'lucide-react';
import type { DrillResult } from '@/lib/financeiro/orcamento-drill-helpers';
import { classificarReconciliacaoEntidade, type EntidadeConcentracaoResult } from '@/lib/financeiro/orcamento-entidade-helpers';

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

const deltaCls = (d: number) =>
  d > 0 ? 'text-status-error' : d < 0 ? 'text-status-success' : 'text-muted-foreground';

function LoadingRows() {
  return (
    <div className="space-y-2 py-3">
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-4 w-3/4" />
    </div>
  );
}

/** Visão por categoria (drill v1): decompõe o realizado YTD por categoria do Omie. */
function CategoriaView({ result, ano }: { result: DrillResult; ano: number }) {
  const q = QUALIDADE_META[result.qualidade];
  return (
    <div className="space-y-3 text-sm">
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
                  <td className={`py-1 text-right tabular-nums ${deltaCls(c.delta)}`}>
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

      {result.forecast_nao_decomposto !== 0 && (
        <p className="text-xs text-muted-foreground">
          + Forecast dos meses restantes (não decomposto por categoria):{' '}
          <span className="font-medium text-foreground">{fmt(result.forecast_nao_decomposto)}</span>
        </p>
      )}
    </div>
  );
}

const CLASSE_BADGE: Record<string, { label: string; cls: string } | null> = {
  novo: { label: 'Novo', cls: 'text-status-info border-status-info/50' },
  sumiu: { label: 'Sumiu', cls: 'text-muted-foreground border-border' },
  recorrente: null,
};

/** Visão por fornecedor/cliente (drill v2): concentração do realizado YTD + aumento YoY. */
function EntidadeView({
  data, rotulo, ano, totalCategoriaV1, realizadoSnapshot,
}: {
  data: EntidadeConcentracaoResult;
  rotulo: 'fornecedor' | 'cliente';
  ano: number;
  totalCategoriaV1: number | null;
  realizadoSnapshot: number | null;
}) {
  const plural = rotulo === 'fornecedor' ? 'fornecedores' : 'clientes';
  const recon = classificarReconciliacaoEntidade(data.total_ano, totalCategoriaV1, data.truncado);
  const reconMeta = QUALIDADE_META[recon.qualidade];
  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs text-muted-foreground">
        Concentração do realizado YTD por {rotulo} e variação YoY (mesmos meses fechados). Não é
        causa da meta — é onde o realizado se concentra e o que mais subiu vs {ano - 1}.
      </p>

      {data.truncado ? (
        <p className="rounded-md border border-status-warning/50 bg-status-warning/5 px-3 py-2 text-xs text-status-warning">
          Amostra truncada (muitos lançamentos) — análise de concentração não confiável neste período (modo diagnóstico).
        </p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs">
            <div className="text-muted-foreground">Maior concentração YTD</div>
            <div className="font-medium">
              top {data.top_n} {plural} = {(data.top_n_peso_nivel_perc * 100).toFixed(0)}% do total
            </div>
          </div>
          <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs">
            <div className="text-muted-foreground">Maior aumento vs {ano - 1}</div>
            <div className="font-medium">
              {data.sem_aumento_bruto || data.top_n_peso_aumento_perc == null
                ? `linha não cresceu vs ${ano - 1}`
                : `top ${data.top_n} explicam ${(data.top_n_peso_aumento_perc * 100).toFixed(0)}% do aumento`}
            </div>
          </div>
        </div>
      )}

      {/* Reconciliação contra o total-por-categoria do v1 (mesma base viva) */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border bg-muted/30 px-3 py-2 text-xs">
        <Badge variant="outline" className={`text-[10px] ${reconMeta.cls}`}>{reconMeta.label}</Badge>
        <span className="text-muted-foreground">
          Σ {plural}: <span className="font-medium text-foreground">{fmt(data.total_ano)}</span>
        </span>
        {totalCategoriaV1 != null && (
          <span className="text-muted-foreground">
            Σ categorias (v1): <span className="font-medium text-foreground">{fmt(totalCategoriaV1)}</span>
          </span>
        )}
        {recon.diff != null && (
          <span className="text-muted-foreground">
            Diferença: <span className="font-medium text-foreground">{fmt(recon.diff)}</span>
            {recon.diff_perc !== null && ` (${(recon.diff_perc * 100).toFixed(1)}%)`}
          </span>
        )}
        {realizadoSnapshot != null && (
          <span className="text-muted-foreground">
            Realizado contábil (snapshot): <span className="font-medium text-foreground">{fmt(realizadoSnapshot)}</span>
          </span>
        )}
      </div>
      {recon.qualidade !== 'ok' && !data.truncado && (
        <p className="text-xs text-status-warning">
          A diferença vs as categorias (v1) pode incluir lançamentos no razão oposto (ex.: estorno/ajuste) — leia com cautela.
        </p>
      )}

      {data.componentes.length === 0 ? (
        <p className="text-xs text-muted-foreground">Sem títulos para esta linha neste período.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b text-muted-foreground">
                <th className="py-1 text-left font-normal">{rotulo === 'fornecedor' ? 'Fornecedor' : 'Cliente'}</th>
                <th className="py-1 text-right font-normal">Realizado YTD</th>
                <th className="py-1 text-right font-normal">{ano - 1}</th>
                <th className="py-1 text-right font-normal">Δ vs {ano - 1}</th>
                <th className="py-1 text-right font-normal">% do total</th>
              </tr>
            </thead>
            <tbody>
              {data.componentes.map((c) => {
                const badge = CLASSE_BADGE[c.classe];
                return (
                  <tr key={c.entidade_chave} className="border-b border-border/50">
                    <td className="py-1 pr-2">
                      {c.entidade_label}
                      {badge && <Badge variant="outline" className={`ml-1 text-[9px] ${badge.cls}`}>{badge.label}</Badge>}
                      {c.sem_id && <Badge variant="outline" className="ml-1 text-[9px] text-muted-foreground border-border">Sem ID</Badge>}
                    </td>
                    <td className="py-1 text-right tabular-nums">{fmt(c.realizado_ytd)}</td>
                    <td className="py-1 text-right tabular-nums text-muted-foreground">{fmt(c.realizado_ytd_ano_anterior)}</td>
                    <td className={`py-1 text-right tabular-nums ${deltaCls(c.delta)}`}>
                      <span className="inline-flex items-center gap-0.5">
                        {c.delta > 0 ? <TrendingUp className="h-3 w-3" /> : c.delta < 0 ? <TrendingDown className="h-3 w-3" /> : null}
                        {fmt(c.delta)}
                        {c.delta_perc !== null && ` (${(c.delta_perc * 100).toFixed(0)}%)`}
                      </span>
                    </td>
                    <td className="py-1 text-right tabular-nums text-muted-foreground">{(c.peso_perc * 100).toFixed(0)}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Painel do drill aberto inline sob uma linha do Forecast que furou a meta. Honesto por
 * design (Codex): explica o realizado YTD, NÃO a variância anual; sempre exibe a
 * reconciliação. Toggle "Por categoria" (v1) / "Por fornecedor·cliente" (v2, só em
 * linhas puras de despesa/receita).
 */
export function DrillVarianciaPanel({
  result,
  isLoading,
  isError,
  ano,
  lente = 'categoria',
  onLente,
  entidadeRotulo = null,
  entidadeData = null,
  entidadeLoading = false,
  entidadeError = false,
  totalCategoriaV1 = null,
  realizadoSnapshot = null,
}: {
  result: DrillResult | null | undefined;
  isLoading: boolean;
  isError: boolean;
  ano: number;
  lente?: 'categoria' | 'entidade';
  onLente?: (l: 'categoria' | 'entidade') => void;
  entidadeRotulo?: 'fornecedor' | 'cliente' | null;
  entidadeData?: EntidadeConcentracaoResult | null;
  entidadeLoading?: boolean;
  entidadeError?: boolean;
  totalCategoriaV1?: number | null;
  realizadoSnapshot?: number | null;
}) {
  const temEntidade = entidadeRotulo != null && onLente != null;

  return (
    <div className="space-y-3 py-2">
      {temEntidade && (
        <div className="flex gap-1">
          <Button
            size="sm"
            variant={lente === 'categoria' ? 'secondary' : 'ghost'}
            className="h-7 text-xs"
            onClick={() => onLente!('categoria')}
          >
            Por categoria
          </Button>
          <Button
            size="sm"
            variant={lente === 'entidade' ? 'secondary' : 'ghost'}
            className="h-7 text-xs"
            onClick={() => onLente!('entidade')}
          >
            Por {entidadeRotulo === 'fornecedor' ? 'fornecedor' : 'cliente'}
          </Button>
        </div>
      )}

      {lente === 'entidade' && temEntidade ? (
        entidadeLoading ? (
          <LoadingRows />
        ) : entidadeError ? (
          <p className="py-3 text-sm text-status-error">
            Não foi possível carregar os {entidadeRotulo === 'fornecedor' ? 'fornecedores' : 'clientes'} deste período. Recolha e abra de novo.
          </p>
        ) : entidadeData ? (
          <EntidadeView
            data={entidadeData}
            rotulo={entidadeRotulo!}
            ano={ano}
            totalCategoriaV1={totalCategoriaV1}
            realizadoSnapshot={realizadoSnapshot}
          />
        ) : null
      ) : isLoading ? (
        <LoadingRows />
      ) : isError ? (
        <p className="py-3 text-sm text-status-error">
          Não foi possível carregar as categorias deste período. Recolha e abra de novo para tentar.
        </p>
      ) : result ? (
        <CategoriaView result={result} ano={ano} />
      ) : null}
    </div>
  );
}
