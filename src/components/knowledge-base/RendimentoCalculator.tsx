import { useState, useMemo } from 'react';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Calculator, AlertTriangle, Loader2 } from 'lucide-react';
import { useKbProductSpecsList } from '@/hooks/useKbProductSpecsList';
import { calculateRendimento } from '@/lib/knowledge-base/calculate-rendimento';

/**
 * Calculadora standalone de consumo de tinta.
 * Vendedor escolhe produto (de kb_product_specs aprovados), informa área em m²,
 * vê cálculo de litros necessários + memória de cálculo + warnings.
 *
 * Usável tanto fora de chamada (planejamento, cotação) quanto embutida
 * em painel de chamada futuramente (PR6c.5).
 */
export function RendimentoCalculator() {
  const { data: specs, isLoading } = useKbProductSpecsList();
  const [productCode, setProductCode] = useState<string>('');
  const [areaM2, setAreaM2] = useState<string>('');
  const [demaosOverride, setDemaosOverride] = useState<string>('');

  const selectedSpec = specs?.find((s) => s.product_code === productCode);
  const area = parseFloat(areaM2) || 0;
  const demaos = demaosOverride ? parseInt(demaosOverride, 10) : undefined;

  const result = useMemo(() => {
    if (!selectedSpec || area <= 0) return null;
    return calculateRendimento({ spec: selectedSpec, areaM2: area, demaosOverride: demaos });
  }, [selectedSpec, area, demaos]);

  return (
    <Card className="p-4 space-y-4">
      <div className="flex items-center gap-2">
        <Calculator className="w-4 h-4 text-status-warning" />
        <h2 className="text-sm font-semibold">Calculadora de rendimento</h2>
      </div>

      <div className="space-y-3">
        <div>
          <Label htmlFor="product" className="text-xs">Produto</Label>
          {isLoading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
              <Loader2 className="w-3 h-3 animate-spin" />
              Carregando produtos…
            </div>
          ) : !specs || specs.length === 0 ? (
            <div className="text-xs text-muted-foreground py-2 px-2 rounded-md bg-muted/40">
              Nenhum spec aprovado ainda. Suba boletins em <span className="font-mono">/admin/knowledge-base</span> e extraia os specs primeiro.
            </div>
          ) : (
            <Select value={productCode} onValueChange={setProductCode}>
              <SelectTrigger>
                <SelectValue placeholder="Escolha o produto" />
              </SelectTrigger>
              <SelectContent>
                {specs.map((s) => (
                  <SelectItem key={s.product_code} value={s.product_code}>
                    <span>{s.product_name}</span>
                    <span className="text-muted-foreground ml-2 text-xs">({s.product_code})</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="area" className="text-xs">Área a pintar (m²)</Label>
            <Input
              id="area"
              type="number"
              min="0"
              step="any"
              value={areaM2}
              onChange={(e) => setAreaM2(e.target.value)}
              placeholder="Ex: 80"
            />
          </div>
          <div>
            <Label htmlFor="demaos" className="text-xs">
              Demãos{' '}
              {selectedSpec?.demaos_recomendadas != null && (
                <span className="text-muted-foreground text-[10px]">(boletim: {selectedSpec.demaos_recomendadas})</span>
              )}
            </Label>
            <Input
              id="demaos"
              type="number"
              min="1"
              step="1"
              placeholder={String(selectedSpec?.demaos_recomendadas ?? 1)}
              value={demaosOverride}
              onChange={(e) => setDemaosOverride(e.target.value)}
            />
          </div>
        </div>
      </div>

      {result && (
        <Card className="p-3 border-status-success bg-status-success-bg/30 space-y-2">
          <div className="flex items-baseline justify-between">
            <span className="text-xs text-muted-foreground uppercase tracking-wide">Consumo estimado</span>
            <span className="text-2xl font-semibold tabular-nums text-status-success">
              {result.litrosNecessarios.toFixed(1)} L
            </span>
          </div>

          <div className="text-2xs text-muted-foreground space-y-0.5 pt-1 border-t border-status-success/20">
            <div>
              Área: <span className="font-medium">{result.areaM2} m²</span> · Demãos:{' '}
              <span className="font-medium">{result.demaos}</span> · Rendimento:{' '}
              <span className="font-medium">{result.rendimentoM2PorLitro.toFixed(1)} m²/L</span>
            </div>
            {result.calculo && <div className="font-mono text-[10px] opacity-80">{result.calculo}</div>}
            {result.rendimentoM2PorLitro > 0 && (
              <div className="font-mono text-[10px] opacity-80">
                {result.areaM2} ÷ {result.rendimentoM2PorLitro.toFixed(1)} × {result.demaos} ={' '}
                <span className="font-bold">{result.litrosNecessarios.toFixed(1)} L</span>
              </div>
            )}
          </div>

          {result.warnings.length > 0 && (
            <div className="space-y-1 pt-2 border-t border-status-success/20">
              {result.warnings.map((w, i) => (
                <div key={i} className="flex items-start gap-1.5 text-2xs text-status-warning">
                  <AlertTriangle className="w-2.5 h-2.5 mt-0.5 shrink-0" />
                  <span>{w}</span>
                </div>
              ))}
            </div>
          )}

          {selectedSpec && (
            <div className="flex flex-wrap gap-1 pt-2 border-t border-status-success/20">
              {selectedSpec.catalisador_codigo && (
                <Badge variant="outline" className="text-[10px]">
                  + catalisador {selectedSpec.catalisador_codigo}
                  {selectedSpec.catalisador_proporcao_pct && ` (${selectedSpec.catalisador_proporcao_pct}%)`}
                </Badge>
              )}
              {selectedSpec.diluente_codigo && (
                <Badge variant="outline" className="text-[10px]">
                  + diluente {selectedSpec.diluente_codigo}
                </Badge>
              )}
              {selectedSpec.pot_life_horas && (
                <Badge variant="outline" className="text-[10px]">
                  pot life {selectedSpec.pot_life_horas}h
                </Badge>
              )}
              {selectedSpec.validade_dias && (
                <Badge variant="outline" className="text-[10px]">
                  validade {selectedSpec.validade_dias} dias
                </Badge>
              )}
            </div>
          )}
        </Card>
      )}
    </Card>
  );
}
