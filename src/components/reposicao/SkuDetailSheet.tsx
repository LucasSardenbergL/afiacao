import { memo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as ReTooltip,
  Legend,
  ReferenceLine,
} from 'recharts';
import {
  classBadge,
  fmt,
  fmtBRL,
  fonteBadgeLabel,
  fonteBadgeVariant,
  type RowWithPrice,
  type SkuParam,
  type ViewStats,
} from '@/lib/reposicao/sku-param';

type BadgeVariant =
  | 'default'
  | 'secondary'
  | 'destructive'
  | 'outline'
  | 'success'
  | 'warning'
  | 'info'
  | 'danger'
  | 'purple'
  | 'indigo';

type DemandaRow = { data_emissao: string; quantidade: number };

/**
 * Drill-down lateral (Sheet) com detalhes do SKU em revisão.
 * Extraído de AdminReposicaoRevisao.tsx (1099 LoC → ~640 LoC) como proof-of-concept
 * de refactor de god-component. Padrão reproduzível pros outros 6 da Reposição.
 *
 * Pure component (toda data vem de props ou queries internas com sku como key).
 * memo(): re-render só quando sku muda — parent pode re-render livre.
 */

interface Props {
  sku: RowWithPrice | null;
  onClose: () => void;
  onSaveValues: (values: Partial<SkuParam>) => void;
  isSaving: boolean;
}

function SkuDetailSheetImpl({
  sku,
  onClose,
  onSaveValues,
  isSaving,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [edit, setEdit] = useState<{ em: string; pp: string; emax: string; min: string }>({
    em: '',
    pp: '',
    emax: '',
    min: '',
  });

  const open = !!sku;

  // Stats from view (pico, p95, preços, custos, fórmula)
  const { data: stats } = useQuery<ViewStats | null>({
    queryKey: ['sku_view_stats', sku?.empresa, sku?.sku_codigo_omie],
    enabled: open,
    queryFn: async () => {
      if (!sku) return null;
      const { data, error } = await supabase
        .from('v_sku_parametros_sugeridos')
        .select(
          'pico_maximo_dia, p95_diario, p90_quando_vende, cobertura_alvo_dias, ' +
            'preco_compra_real, preco_venda_medio, preco_item_eoq, fonte_preco, n_compras, ' +
            'custo_capital_efetivo_perc, custo_pedido_aplicado, modo_pedido, ' +
            'z_aplicado, demanda_sigma_diario, sigma_lt_d, lead_time_medio, qtde_compra_ciclo_sugerida',
        )
        .eq('empresa', sku.empresa)
        .eq('sku_codigo_omie', sku.sku_codigo_omie)
        .maybeSingle();
      if (error) return null;
      return data as unknown as ViewStats;
    },
  });

  // 90d daily demand chart
  const { data: demanda } = useQuery({
    queryKey: ['sku_demanda_90d', sku?.empresa, sku?.sku_codigo_omie],
    enabled: open,
    queryFn: async () => {
      if (!sku) return [];
      const since = new Date();
      since.setDate(since.getDate() - 90);
      const { data, error } = await supabase
        .from('venda_items_history')
        .select('data_emissao, quantidade')
        .eq('empresa', sku.empresa)
        .eq('sku_codigo_omie', sku.sku_codigo_omie)
        .gte('data_emissao', since.toISOString())
        .order('data_emissao', { ascending: true });
      if (error) return [];
      const buckets: Record<string, number> = {};
      for (let i = 0; i < 90; i++) {
        const d = new Date();
        d.setDate(d.getDate() - (89 - i));
        const k = d.toISOString().slice(0, 10);
        buckets[k] = 0;
      }
      (data ?? []).forEach((row: DemandaRow) => {
        const k = String(row.data_emissao).slice(0, 10);
        if (k in buckets) buckets[k] += Number(row.quantidade ?? 0);
      });
      return Object.entries(buckets).map(([dia, qtde]) => ({
        dia: dia.slice(5),
        qtde: Math.round(qtde * 100) / 100,
      }));
    },
  });

  if (!sku) return null;

  const Z = stats?.z_aplicado ?? sku.z_score ?? null;
  const D = sku.demanda_media_diaria ?? null;
  const LT = stats?.lead_time_medio ?? sku.lt_medio_dias_uteis ?? null;
  const sigmaD = stats?.demanda_sigma_diario ?? sku.demanda_desvio_padrao ?? null;
  const sigmaLT = sku.lt_desvio_padrao_dias ?? null;
  const Cp = stats?.custo_pedido_aplicado ?? null;
  const Cm = stats?.custo_capital_efetivo_perc ?? null;
  const preco = stats?.preco_item_eoq ?? stats?.preco_compra_real ?? null;
  const QC = stats?.qtde_compra_ciclo_sugerida ?? null;
  const markup =
    stats?.preco_compra_real && stats?.preco_venda_medio
      ? stats.preco_venda_medio / stats.preco_compra_real
      : null;

  const justificativaAuto =
    `SKU classe ${sku.classe_consolidada}. Fórmula Silver-Pyke-Peterson com service level Z = ${fmt(Z, 2)}:\n` +
    `• Safety Stock = Z × √(LT × σ_D² + D² × σ_LT²) = ${fmt(Z, 2)} × √(${fmt(LT, 1)}×${fmt(sigmaD, 2)}² + ${fmt(D, 2)}²×${fmt(sigmaLT, 2)}²) = ${fmt(sku.estoque_minimo, 0)}\n` +
    `• Ponto de Pedido = D×LT + SS = ${fmt(D, 2)}×${fmt(LT, 1)} + ${fmt(sku.estoque_minimo, 0)} = ${fmt(sku.ponto_pedido, 0)}\n` +
    `• Lote de Compra (EOQ) = √(2 × D_anual × Cp / (Cm × preço)) = √(2×${fmt(D, 2)}×252×${fmt(Cp, 2)} / (${fmt(Cm, 4)}×${fmtBRL(preco)})) = ${fmt(QC, 0)}\n` +
    `• Estoque Máximo = PP + QC = ${fmt(sku.ponto_pedido, 0)} + ${fmt(QC, 0)} = ${fmt(sku.estoque_maximo, 0)}\n` +
    `Cobertura efetiva: ${stats?.cobertura_alvo_dias ?? sku.cobertura_alvo_dias ?? '—'} dias de demanda.`;

  const startEdit = () => {
    setEdit({
      em: String(sku.estoque_minimo ?? ''),
      pp: String(sku.ponto_pedido ?? ''),
      emax: String(sku.estoque_maximo ?? ''),
      min: sku.minimo_forcado_manual != null ? String(sku.minimo_forcado_manual) : '',
    });
    setEditing(true);
  };
  const saveEdit = () => {
    // Mínimo de compra forçado: vazio → null (sem piso). Valor inválido (≤0 / não-finito) → não
    // salva e avisa (degradação honesta — espelha o CHECK do banco que rejeita ≤0/NaN/Infinity).
    const minRaw = edit.min.trim();
    let minForcado: number | null = null;
    if (minRaw !== '') {
      const n = Number(minRaw);
      if (!Number.isFinite(n) || n <= 0) {
        toast.error('Mínimo de compra forçado inválido — informe um número maior que zero (ou deixe vazio para remover).');
        return;
      }
      minForcado = n;
    }
    onSaveValues({
      estoque_minimo: Number(edit.em),
      ponto_pedido: Number(edit.pp),
      estoque_maximo: Number(edit.emax),
      minimo_forcado_manual: minForcado,
    });
    setEditing(false);
  };

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-start justify-between gap-2">
            <span>
              {sku.sku_descricao}
              <span className="ml-2 text-xs font-mono text-muted-foreground">
                #{sku.sku_codigo_omie}
              </span>
            </span>
            <Badge variant={classBadge(sku.classe_consolidada) as BadgeVariant}>
              {sku.classe_consolidada}
            </Badge>
          </SheetTitle>
        </SheetHeader>

        <div className="space-y-5 py-4 text-sm">
          {/* Identificação */}
          <section>
            <h3 className="font-semibold mb-2">Identificação</h3>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
              <dt className="text-muted-foreground">Fornecedor</dt>
              <dd>{sku.fornecedor_nome ?? '—'}</dd>
              <dt className="text-muted-foreground">Empresa</dt>
              <dd>{sku.empresa}</dd>
              <dt className="text-muted-foreground">Última atualização</dt>
              <dd>
                {sku.ultima_atualizacao_calculo
                  ? new Date(sku.ultima_atualizacao_calculo).toLocaleString('pt-BR')
                  : '—'}
              </dd>
              <dt className="text-muted-foreground">Valor vendido 90d</dt>
              <dd>{fmtBRL(sku.valor_vendido_90d)}</dd>
            </dl>
          </section>

          {/* Demanda */}
          <section>
            <h3 className="font-semibold mb-2">Estatísticas de demanda (180d)</h3>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
              <dt className="text-muted-foreground">Demanda média/dia</dt>
              <dd>{fmt(sku.demanda_media_diaria)}</dd>
              <dt className="text-muted-foreground">Desvio padrão</dt>
              <dd>{fmt(sku.demanda_desvio_padrao)}</dd>
              <dt className="text-muted-foreground">Coef. variação</dt>
              <dd>{fmt(sku.demanda_coef_variacao)}</dd>
              <dt className="text-muted-foreground">Dias com movimento</dt>
              <dd>{sku.demanda_dias_com_movimento ?? '—'}</dd>
              <dt className="text-muted-foreground">Pico máximo (dia)</dt>
              <dd>{fmt(stats?.pico_maximo_dia, 0)}</dd>
              <dt className="text-muted-foreground">P95 diário</dt>
              <dd>{fmt(stats?.p95_diario)}</dd>
            </dl>
          </section>

          {/* Preço e custo */}
          <section>
            <h3 className="font-semibold mb-2">Preço e custo</h3>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
              <dt className="text-muted-foreground">Preço de compra médio</dt>
              <dd className="flex items-center gap-2">
                {fmtBRL(stats?.preco_compra_real)}
                <span className="text-xs text-muted-foreground">
                  (baseado em {stats?.n_compras ?? 0} compras)
                </span>
              </dd>
              <dt className="text-muted-foreground">Preço de venda médio (180d)</dt>
              <dd>{fmtBRL(stats?.preco_venda_medio)}</dd>
              <dt className="text-muted-foreground">Markup implícito</dt>
              <dd>
                {markup
                  ? `${fmt(markup, 2)}x (${fmt((markup - 1) * 100, 1)}%)`
                  : '—'}
              </dd>
              <dt className="text-muted-foreground">Custo de capital efetivo</dt>
              <dd>
                {stats?.custo_capital_efetivo_perc != null
                  ? `${fmt(stats.custo_capital_efetivo_perc * 100, 2)}% a.a.`
                  : '—'}
              </dd>
              <dt className="text-muted-foreground">Custo de pedido aplicado</dt>
              <dd>{fmtBRL(stats?.custo_pedido_aplicado)}</dd>
              <dt className="text-muted-foreground">Modo atual</dt>
              <dd>
                <Badge variant={stats?.modo_pedido === 'api' ? ('info' as BadgeVariant) : 'outline'}>
                  {stats?.modo_pedido === 'api' ? 'API' : stats?.modo_pedido === 'manual' ? 'Manual' : '—'}
                </Badge>
              </dd>
              <dt className="text-muted-foreground">Fonte do preço</dt>
              <dd>
                <Badge variant={fonteBadgeVariant(stats?.fonte_preco) as BadgeVariant}>
                  {fonteBadgeLabel(stats?.fonte_preco)}
                </Badge>
              </dd>
            </dl>
          </section>

          {/* Lead time */}
          <section>
            <h3 className="font-semibold mb-2">Lead time</h3>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
              <dt className="text-muted-foreground">LT médio (du)</dt>
              <dd>{fmt(sku.lt_medio_dias_uteis, 1)}</dd>
              <dt className="text-muted-foreground">Desvio padrão</dt>
              <dd>{fmt(sku.lt_desvio_padrao_dias, 1)}</dd>
              <dt className="text-muted-foreground">P95 LT</dt>
              <dd>{fmt(sku.lt_p95_dias, 1)}</dd>
              <dt className="text-muted-foreground">Observações</dt>
              <dd>{sku.lt_n_observacoes ?? '—'}</dd>
              <dt className="text-muted-foreground">Fonte</dt>
              <dd>{sku.fonte_leadtime ?? '—'}</dd>
            </dl>
          </section>

          {/* Sugeridos */}
          <section className="rounded-md border bg-accent/30 p-3">
            <h3 className="font-semibold mb-2">Parâmetros sugeridos</h3>
            {!editing ? (
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <div className="text-xs text-muted-foreground">Estoque mínimo</div>
                  <div className="text-2xl font-semibold">{fmt(sku.estoque_minimo, 0)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Ponto pedido</div>
                  <div className="text-2xl font-semibold">{fmt(sku.ponto_pedido, 0)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Estoque máximo</div>
                  <div className="text-2xl font-semibold">{fmt(sku.estoque_maximo, 0)}</div>
                </div>
                <div className="col-span-3 text-xs text-muted-foreground">
                  Cobertura alvo: {sku.cobertura_alvo_dias ?? stats?.cobertura_alvo_dias ?? '—'} dias
                </div>
                <div className="col-span-3 flex items-baseline gap-2 border-t pt-2 mt-1">
                  <span className="text-xs text-muted-foreground">Mínimo de compra forçado:</span>
                  <span className="text-sm font-semibold tabular-nums">
                    {sku.minimo_forcado_manual != null ? fmt(sku.minimo_forcado_manual, 0) : '—'}
                  </span>
                  {sku.minimo_forcado_manual != null && (
                    <span className="text-[11px] text-status-warning">
                      a compra sugerida nunca fica abaixo deste valor
                    </span>
                  )}
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label className="text-xs">EM</Label>
                  <Input
                    type="number"
                    value={edit.em}
                    onChange={(e) => setEdit((s) => ({ ...s, em: e.target.value }))}
                  />
                </div>
                <div>
                  <Label className="text-xs">PP</Label>
                  <Input
                    type="number"
                    value={edit.pp}
                    onChange={(e) => setEdit((s) => ({ ...s, pp: e.target.value }))}
                  />
                </div>
                <div>
                  <Label className="text-xs">Emax</Label>
                  <Input
                    type="number"
                    value={edit.emax}
                    onChange={(e) => setEdit((s) => ({ ...s, emax: e.target.value }))}
                  />
                </div>
                <div className="col-span-3 border-t pt-2 mt-1">
                  <Label className="text-xs">Mínimo de compra forçado (opcional)</Label>
                  <Input
                    type="number"
                    min={0}
                    step="1"
                    placeholder="vazio = sem mínimo"
                    value={edit.min}
                    onChange={(e) => setEdit((s) => ({ ...s, min: e.target.value }))}
                  />
                  <p className="text-[11px] text-muted-foreground mt-1">
                    O motor nunca sugere comprar menos que este valor — só eleva itens que já precisam
                    de reposição (não força comprar item sobre-estocado). Deixe vazio para remover.
                  </p>
                </div>
              </div>
            )}
            <div className="flex gap-2 pt-3">
              {sku.read_only ? null : !editing ? (
                <Button size="sm" variant="outline" onClick={startEdit}>
                  Editar valores manualmente
                </Button>
              ) : (
                <>
                  <Button size="sm" onClick={saveEdit} disabled={isSaving}>
                    {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Salvar
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                    Cancelar
                  </Button>
                </>
              )}
            </div>
          </section>

          {/* Justificativa auto */}
          <section>
            <h3 className="font-semibold mb-2">Justificativa</h3>
            <p className="text-muted-foreground leading-relaxed whitespace-pre-line font-mono text-xs">
              {justificativaAuto}
            </p>
          </section>

          {/* Gráfico */}
          <section>
            <h3 className="font-semibold mb-2">Demanda diária (últimos 90d)</h3>
            <div className="h-56 w-full">
              <ResponsiveContainer>
                <ComposedChart data={demanda ?? []} margin={{ left: 0, right: 8, top: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                  <XAxis dataKey="dia" tick={{ fontSize: 10 }} interval={9} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <ReTooltip />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="qtde" name="Demanda" fill="hsl(var(--primary))" />
                  {sku.estoque_minimo != null && (
                    <ReferenceLine
                      y={sku.estoque_minimo}
                      stroke="hsl(var(--destructive))"
                      strokeDasharray="4 4"
                      label={{ value: 'EM', fontSize: 10, position: 'right' }}
                    />
                  )}
                  {sku.ponto_pedido != null && (
                    <ReferenceLine
                      y={sku.ponto_pedido}
                      stroke="hsl(var(--accent-foreground))"
                      strokeDasharray="4 4"
                      label={{ value: 'PP', fontSize: 10, position: 'right' }}
                    />
                  )}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </section>

          {/* Rodapé */}
          <section className="space-y-2 border-t pt-4">
            {sku.read_only && (
              <div className="rounded-md border border-dashed bg-muted/50 p-3 text-sm text-muted-foreground space-y-1">
                <div className="font-medium text-foreground flex items-center gap-2">
                  <Badge variant="secondary" className="bg-muted">
                    Aguardando fornecedor
                  </Badge>
                </div>
                <p>
                  Este SKU está fora da reposição automática enquanto o fornecedor{' '}
                  <strong>{sku.fornecedor_nome ?? '—'}</strong> não estiver habilitado.
                </p>
              </div>
            )}
            <div className="flex justify-end pt-2">
              <Button variant="outline" onClick={onClose}>
                Fechar
              </Button>
            </div>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export const SkuDetailSheet = memo(SkuDetailSheetImpl);
