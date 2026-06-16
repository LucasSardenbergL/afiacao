// Card de detalhe da cor selecionada: preço, fonte, desconto e embalagens alternativas.
// Extraído verbatim de src/components/TintColorSelectDialog.tsx (god-component split).
import { Fragment } from 'react';
import { Loader2, History, Package, Palette, Info, AlertTriangle } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import type { Product } from '@/hooks/useUnifiedOrder';
import { fmt } from '@/hooks/useUnifiedOrder';
import { selectAltPrice, type TintPriceSource, type SemPrecoMotivo, type TintPriceBreakdownLite } from '@/lib/tint/select-price';
import type { FormulaResult, AlternativePackaging } from './types';

const LABEL_FONTE: Record<TintPriceSource, string> = {
  cliente: 'Preço cliente',
  tabela: 'Tabela',
  calculado: 'Calculado',
};

// Mensagem honesta quando não há preço — diz o que fazer, nunca vende a R$ 0.
const MOTIVO_SEM_PRECO: Record<SemPrecoMotivo, string> = {
  base: 'A base não tem preço cadastrado no Omie. Ajuste o produto no Omie para vender esta cor.',
  corante: 'Falta o custo de um corante no Omie. Avise o tintométrico para vincular o corante.',
  receita: 'A receita desta cor está incompleta. Avise o tintométrico.',
  indisponivel: 'Não foi possível calcular o preço agora (motor de preço indisponível). Tente de novo; se persistir, avise o suporte.',
};

interface SelectedFormulaCardProps {
  selectedFormula: FormulaResult;
  loadingLastPrice: boolean;
  lastPracticedPrice: { price: number; date: string } | null | undefined;
  precoCsv: number;
  precoCalc: number | null;
  precoCliente: number | null;
  priceSource: TintPriceSource | null;
  setPriceSourceOverride: (s: TintPriceSource | null) => void;
  precoFinal: number | null;
  precoSemDesconto: number | null;
  disponivel: boolean;
  precoCarregando: boolean;
  recalculado: boolean;
  precoImportadoAnterior: number | null;
  motivoSemPreco: SemPrecoMotivo | null;
  discountPct: number;
  setDiscountPct: (n: number) => void;
  syncDiscount: boolean;
  setSyncDiscount: (v: boolean) => void;
  alternatives: AlternativePackaging[] | undefined;
  loadingAlternatives: boolean;
  /** Preço honesto (motor batch) por formulaId das alternativas. */
  altPriceMap: Record<string, TintPriceBreakdownLite> | undefined;
  /** Batch de preços das alternativas ainda carregando (mostra "calculando", não "sem preço"). */
  altPriceLoading: boolean;
  altDiscounts: Record<string, number>;
  setAltDiscounts: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  custoCorantes: number;
  onConfirm: (formulaId: string, corId: string, nomeCor: string, precoFinal: number, custoCorantes: number, alternativeProduct?: Product) => void;
}

export function SelectedFormulaCard({
  selectedFormula,
  loadingLastPrice,
  lastPracticedPrice,
  precoCsv,
  precoCalc,
  precoCliente,
  priceSource,
  setPriceSourceOverride,
  precoFinal,
  precoSemDesconto,
  disponivel,
  precoCarregando,
  recalculado,
  precoImportadoAnterior,
  motivoSemPreco,
  discountPct,
  setDiscountPct,
  syncDiscount,
  setSyncDiscount,
  alternatives,
  loadingAlternatives,
  altPriceMap,
  altPriceLoading,
  altDiscounts,
  setAltDiscounts,
  custoCorantes,
  onConfirm,
}: SelectedFormulaCardProps) {
  // Fontes de preço disponíveis (com valor), para a vendedora escolher manualmente.
  const fontes: { key: TintPriceSource; label: string; preco: number }[] = [];
  if (precoCliente != null) fontes.push({ key: 'cliente', label: 'Cliente', preco: precoCliente });
  if (precoCalc != null) fontes.push({ key: 'calculado', label: 'Calculado', preco: precoCalc });
  if (precoCsv > 0) fontes.push({ key: 'tabela', label: 'Tabela', preco: precoCsv });

  return (
    <Card className="border-primary/30">
      <CardContent className="pt-4 space-y-3">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-xs font-mono">{selectedFormula.cor_id}</Badge>
          <span className="text-sm font-medium">{selectedFormula.nome_cor}</span>
        </div>

        {/* Last practiced price for this customer */}
        {loadingLastPrice ? (
          <Loader2 className="w-3 h-3 animate-spin" />
        ) : lastPracticedPrice ? (
          <div className="flex items-center gap-2 p-2 rounded-md bg-primary/5 border border-primary/20">
            <History className="w-3.5 h-3.5 text-primary shrink-0" />
            <div className="text-xs">
              <span className="font-medium text-primary">Último preço cliente: {fmt(lastPracticedPrice.price)}</span>
              {precoCsv > 0 && lastPracticedPrice.price < precoCsv && (
                <Badge variant="secondary" className="ml-1.5 text-[9px] px-1.5 py-0 text-status-warning-bold bg-status-warning-bg border-status-warning/30">
                  -{Math.round((1 - lastPracticedPrice.price / precoCsv) * 100)}% da tabela
                </Badge>
              )}
              <span className="text-muted-foreground ml-1">
                ({new Date(lastPracticedPrice.date).toLocaleDateString('pt-BR')})
              </span>
            </div>
          </div>
        ) : null}

        {precoCarregando ? (
          /* RPC de preço carregando: não decide preço ainda, segura a venda */
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Calculando preço...
          </div>
        ) : disponivel ? (
          <>
            {/* Seletor de fonte quando há mais de uma opção de preço */}
            {fontes.length > 1 && (
              <div className="space-y-1.5">
                <p className="text-[10px] uppercase font-semibold text-muted-foreground tracking-wider">Selecionar preço</p>
                <div className="flex flex-wrap gap-1.5">
                  {fontes.map((f) => (
                    <button
                      key={f.key}
                      onClick={() => setPriceSourceOverride(f.key)}
                      className={`flex items-center gap-1 px-2 py-1 rounded-md border text-xs transition-all ${priceSource === f.key ? 'border-primary bg-primary/10 text-primary font-semibold' : 'border-border hover:border-primary/50'}`}
                    >
                      {f.key === 'cliente' && <History className="w-3 h-3" />}
                      {f.label} {fmt(f.preco)}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Aviso de recálculo (Grupo B): o preço importado não incluía a base */}
            {recalculado && precoImportadoAnterior != null && precoSemDesconto != null && (
              <div className="flex items-start gap-2 p-2 rounded-md bg-status-info-bg border border-status-info/30">
                <Info className="w-3.5 h-3.5 text-status-info shrink-0 mt-0.5" />
                <p className="text-[11px] text-status-info-foreground">
                  <strong>Preço recalculado.</strong> O preço importado não incluía a base.
                  Antes <span className="line-through">{fmt(precoImportadoAnterior)}</span> → agora <strong>{fmt(precoSemDesconto)}</strong>.
                </p>
              </div>
            )}

            {/* Price breakdown */}
            <div className="space-y-2">
              {/* Main price */}
              <div className="flex justify-between text-sm font-bold border-b pb-2">
                <span className="flex items-center gap-1.5">
                  Preço Final
                  <Badge variant="secondary" className="text-[9px] px-1.5 py-0">
                    {LABEL_FONTE[priceSource ?? 'tabela']}
                  </Badge>
                </span>
                <span className="text-primary">{fmt(precoFinal ?? 0)}</span>
              </div>

              {/* Discount field */}
              <div className="flex items-center gap-2 pt-1">
                <label className="text-xs text-muted-foreground whitespace-nowrap">Desconto %</label>
                <Input
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  value={discountPct || ''}
                  onChange={(e) => setDiscountPct(Math.min(100, Math.max(0, Number(e.target.value) || 0)))}
                  className="h-7 w-20 text-xs text-right"
                  placeholder="0"
                />
                {discountPct > 0 && precoSemDesconto != null && (
                  <span className="text-[10px] text-muted-foreground line-through">{fmt(precoSemDesconto)}</span>
                )}
              </div>
              {alternatives && alternatives.length > 0 && (
                <div className="flex items-center gap-2 pt-1">
                  <Checkbox
                    id="sync-discount"
                    checked={syncDiscount}
                    onCheckedChange={(v) => setSyncDiscount(!!v)}
                    className="h-3.5 w-3.5"
                  />
                  <label htmlFor="sync-discount" className="text-[10px] text-muted-foreground cursor-pointer">
                    Aplicar mesmo desconto nas outras embalagens
                  </label>
                </div>
              )}
            </div>

            <Button
              size="sm"
              onClick={() => onConfirm(
                selectedFormula.id,
                selectedFormula.cor_id,
                selectedFormula.nome_cor,
                precoFinal ?? 0,
                custoCorantes,
              )}
            >
              <Palette className="w-3.5 h-3.5 mr-1.5" />
              Adicionar ao Pedido — {fmt(precoFinal ?? 0)}
            </Button>
          </>
        ) : (
          /* Sem preço: degradação honesta — diz o porquê, não vende a R$ 0 */
          <div className="flex items-start gap-2 p-3 rounded-md bg-status-warning-bg border border-status-warning/30">
            <AlertTriangle className="w-5 h-5 text-status-warning shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-status-warning-foreground">Sem preço para esta cor</p>
              <p className="text-xs text-status-warning mt-1">{MOTIVO_SEM_PRECO[motivoSemPreco ?? 'indisponivel']}</p>
            </div>
          </div>
        )}

        {/* Alternative packagings */}
        {loadingAlternatives ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground pt-1">
            <Loader2 className="w-3 h-3 animate-spin" />
            Buscando outras embalagens...
          </div>
        ) : alternatives && alternatives.length > 0 ? (
          <div className="space-y-2 pt-1">
            <div className="flex items-center gap-1.5 text-[10px] uppercase font-semibold text-muted-foreground tracking-wider">
              <Package className="w-3 h-3" />
              Mesma cor em outras embalagens
            </div>
            <div className="space-y-1.5">
              {alternatives.map((alt, idx) => {
                const prevAlt = idx > 0 ? alternatives[idx - 1] : null;
                const showDivider = prevAlt && prevAlt.sameAcabamento && !alt.sameAcabamento;
                // Preço honesto da alternativa (motor batch): calc vs CSV; custoCorantes DA própria fórmula.
                const altSel = selectAltPrice(alt.precoFinalCsv, altPriceMap?.[alt.formulaId] ?? null);
                const altDisponivel = altSel.preco != null;
                const altBasePrice = altSel.preco ?? 0;
                const altDisc = syncDiscount ? discountPct : (altDiscounts[alt.formulaId] || 0);
                const altPrice = altDisc > 0 ? Math.round(altBasePrice * (1 - altDisc / 100) * 100) / 100 : altBasePrice;
                return (
                  <Fragment key={alt.formulaId}>
                    {showDivider && (
                      <div className="flex items-center gap-2 pt-1 pb-0.5">
                        <div className="flex-1 border-t border-border" />
                        <span className="text-[9px] text-muted-foreground uppercase tracking-wider">Outros acabamentos</span>
                        <div className="flex-1 border-t border-border" />
                      </div>
                    )}
                    <div className={`rounded-md border transition-all text-xs group ${alt.sameAcabamento ? 'border-primary/30 bg-primary/5' : 'border-border hover:border-primary/50'}`}>
                    <button
                      disabled={!altDisponivel}
                      onClick={() => altDisponivel && onConfirm(
                        alt.formulaId,
                        selectedFormula.cor_id,
                        selectedFormula.nome_cor,
                        altPrice,
                        altSel.custoCorantes,
                        alt.product,
                      )}
                      className={`w-full flex items-center justify-between gap-2 p-2 ${altDisponivel ? 'hover:bg-primary/5' : 'opacity-60 cursor-not-allowed'}`}
                    >
                      <div className="flex-1 text-left min-w-0">
                        <p className="font-medium group-hover:text-primary transition-colors break-words whitespace-normal">
                          {alt.productDescricao}
                        </p>
                        <p className="text-[10px] text-muted-foreground font-mono">{alt.productCodigo}</p>
                      </div>
                      <div className="text-right shrink-0">
                        {altDisponivel ? (
                          <>
                            <span className="font-bold text-primary">{fmt(altPrice)}</span>
                            {altDisc > 0 && <span className="text-[10px] text-muted-foreground line-through ml-1">{fmt(altBasePrice)}</span>}
                            {altSel.fonte === 'tabela' ? (
                              <Badge variant="secondary" className="text-[8px] px-1 py-0 ml-1">Tabela</Badge>
                            ) : (
                              <Badge variant="outline" className="text-[8px] px-1 py-0 ml-1">Calc.</Badge>
                            )}
                            {altSel.recalculado && (
                              <Badge variant="outline" className="text-[8px] px-1 py-0 ml-1 text-status-info border-status-info/40">recalc.</Badge>
                            )}
                          </>
                        ) : altPriceLoading ? (
                          <span className="text-[10px] text-muted-foreground">calculando…</span>
                        ) : (
                          <span className="text-[10px] font-medium text-status-warning">sem preço</span>
                        )}
                      </div>
                    </button>
                    {altDisponivel && (
                      <div className="flex items-center gap-2 px-2 pb-2" onClick={(e) => e.stopPropagation()}>
                        <label className="text-[10px] text-muted-foreground whitespace-nowrap">Desconto %</label>
                        <Input
                          type="number"
                          min={0}
                          max={100}
                          step={1}
                          value={altDisc || ''}
                          onChange={(e) => setAltDiscounts(prev => ({ ...prev, [alt.formulaId]: Math.min(100, Math.max(0, Number(e.target.value) || 0)) }))}
                          className="h-6 w-16 text-[10px] text-right"
                          placeholder="0"
                        />
                      </div>
                    )}
                  </div>
                  </Fragment>
                );
              })}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
