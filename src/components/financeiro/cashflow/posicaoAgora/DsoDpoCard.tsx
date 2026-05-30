// Lente contábil agregada (DSO) — alternativa honesta ao PMR title-based pra empresas
// que liquidam em lote (colacor). Point-in-time (AR aberto ÷ receita bruta TTM); NÃO usa
// data de baixa. Colacor-only (v1). DPO FORA da v1 (codex): AP do colacor inclui
// matéria-prima/capex/tributo (≠ CMV) → DPO-sobre-CMV seria incoerente (~1300+ dias).
// Ver dso-dpo-helpers.ts + §5.
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Scale } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { getDsoDpoColacor } from '@/services/financeiroService';

export function DsoDpoCard() {
  const { data, isLoading } = useQuery({
    queryKey: ['dso-dpo-colacor'],
    queryFn: () => getDsoDpoColacor(),
    staleTime: 5 * 60 * 1000,
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Scale className="w-4 h-4" />
          Lente contábil agregada (DSO)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="text-sm text-muted-foreground">Calculando…</div>
        ) : !data || data.dso === null ? (
          <div className="p-4 rounded-lg bg-muted/40 border text-sm text-muted-foreground">
            <p className="font-medium text-foreground">DSO indisponível</p>
            <p className="mt-1">
              Depende de 12 meses fechados de DRE (competência) com receita &gt; 0. O DRE competência
              do colacor precisa ser <strong>regenerado</strong>: o contas-a-receber ficou congelado
              em 2022 até a correção recente (#426), então os snapshots de DRE ainda refletem receita
              zerada. Após regenerar (e validar), o DSO aparece aqui automaticamente.
            </p>
            {data && (
              <div className="mt-2 text-xs space-y-1">
                {data.caveats
                  .filter((c) => c.includes('TTM') || c.includes('incoerente_plausibilidade'))
                  .map((c) => (
                    <p key={c}>• {c}</p>
                  ))}
              </div>
            )}
          </div>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              Período: {data.periodo_label} · últimos 12 meses fechados (competência)
            </p>
            <div className="rounded-lg border p-3">
              <div className="text-sm text-muted-foreground">
                DSO <span className="text-xs">· sobre receita bruta · point-in-time</span>
              </div>
              <div className="kpi-value text-2xl mt-1">{data.dso} dias</div>
            </div>
            <div className="p-3 rounded-lg bg-muted/40 border text-xs text-muted-foreground space-y-1">
              {data.caveats
                .filter((c) => !c.toLowerCase().includes('dpo'))
                .map((c) => (
                  <p key={c}>• {c}</p>
                ))}
              <p>
                • DPO omitido na v1: o AP do colacor inclui matéria-prima/capex/tributo (≠ CMV) e não
                há denominador de compras confiável — DPO-sobre-CMV seria incoerente.
              </p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
