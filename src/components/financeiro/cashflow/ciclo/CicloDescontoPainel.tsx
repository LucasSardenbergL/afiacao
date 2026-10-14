import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { CUSTO_MENSAL_MAX, descontoMaximo, parseCustoMensal } from '@/lib/financeiro/ciclo-cliente-helpers';
import { track } from '@/lib/analytics';

const N_CENARIOS = [10, 20, 30] as const;

export function CicloDescontoPainel({ custoTexto, onCusto }: { custoTexto: string; onCusto: (t: string) => void }) {
  const parsed = parseCustoMensal(custoTexto);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Desconto por pontualidade — teto de indiferença</CardTitle>
        <p className="text-xs text-muted-foreground">
          d = 1 − (1+c)^(−N/30). Antes de custos operacionais e mudança de risco. Quem já pagaria em dia também recebe o desconto — sem piloto não há adesão medida.
        </p>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <label className="flex items-center gap-2">
          Custo do seu dinheiro (% a.m.)
          <Input
            className="w-24" inputMode="decimal" value={custoTexto} placeholder="ex.: 2,5"
            onChange={(e) => onCusto(e.target.value)}
            onBlur={() => { if (parsed.ok) track('financeiro.ciclo_desconto_simulado', { custo_pct: parsed.c * 100 }); }}
          />
        </label>
        {!parsed.ok && (
          <p className={parsed.motivo === 'custo_invalido' ? 'text-status-error' : 'text-muted-foreground'}>
            {parsed.motivo === 'custo_ausente'
              ? 'Informe o custo do seu dinheiro para ver o desconto máximo.'
              : `Valor inválido — use um número positivo de até ${CUSTO_MENSAL_MAX * 100}% a.m., ex.: 2,5.`}
          </p>
        )}
        {parsed.ok && (
          <table className="w-full text-left">
            <thead><tr><th>Antecipa N dias</th><th className="text-right">Desconto máximo</th></tr></thead>
            <tbody>
              {N_CENARIOS.map((n) => {
                const r = descontoMaximo(parsed.c, n);
                return (
                  <tr key={n}>
                    <td>{n} dias</td>
                    <td className="text-right font-mono">{r.ok ? `${(r.dMax * 100).toFixed(2).replace('.', ',')}%` : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}
