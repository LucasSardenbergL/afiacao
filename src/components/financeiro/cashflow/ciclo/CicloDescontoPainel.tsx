import { useEffect, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { CUSTO_MENSAL_MAX, descontoMaximo, parseCustoMensal } from '@/lib/financeiro/ciclo-cliente-helpers';
import { COMPANIES, type Company } from '@/contexts/CompanyContext';
import { track } from '@/lib/analytics';

const N_CENARIOS = [10, 20, 30] as const;

function CustoEmpresa({ company, texto, onCusto }: { company: Company; texto: string; onCusto: (t: string) => void }) {
  const parsed = parseCustoMensal(texto);
  const valido = parsed.ok ? parsed.c : null;
  const ultimo = useRef<number | null>(valido); // valor da montagem não conta como "simulação"
  useEffect(() => {
    if (valido !== null && valido !== ultimo.current) track('financeiro.ciclo_desconto_simulado', { custo_pct: valido * 100, empresa: company });
    ultimo.current = valido;
  }, [valido, company]);
  const idErro = `ciclo-custo-erro-${company}`;
  const invalido = !parsed.ok && parsed.motivo === 'custo_invalido';
  return (
    <div className="space-y-2" data-testid={`ciclo-desconto-${company}`}>
      <label className="flex items-center gap-2">
        {COMPANIES[company].shortName} — custo do seu dinheiro (% a.m.)
        <Input
          className="w-24" inputMode="decimal" value={texto} placeholder="ex.: 2,5"
          aria-invalid={invalido} aria-describedby={!parsed.ok ? idErro : undefined}
          onChange={(e) => onCusto(e.target.value)}
        />
      </label>
      {!parsed.ok && (
        <p id={idErro} className={invalido ? 'text-status-error' : 'text-muted-foreground'}>
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
    </div>
  );
}

/** Um custo por empresa (spec §5.2): nunca um c único aplicado a todas. */
export function CicloDescontoPainel({ empresas, custos, onCusto }: {
  empresas: Company[]; custos: Record<Company, string>; onCusto: (c: Company, t: string) => void;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Desconto por pontualidade — teto de indiferença</CardTitle>
        <p className="text-xs text-muted-foreground">
          d = 1 − (1+c)^(−N/30). Antes de custos operacionais e mudança de risco. Quem já pagaria em dia também recebe o desconto — sem piloto não há adesão medida. O custo é por empresa.
        </p>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {empresas.map((c) => <CustoEmpresa key={c} company={c} texto={custos[c]} onCusto={(t) => onCusto(c, t)} />)}
      </CardContent>
    </Card>
  );
}
