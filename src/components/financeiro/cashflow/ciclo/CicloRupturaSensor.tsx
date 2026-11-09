// Sensor de ruptura / fill-rate da Oben — o guardrail da Frente C ("segurar compra") nasce aqui, com
// denominador, ANTES de a política de compra mudar (plano PME/PMR 2026-10-31, decisão 2 do founder).
// Fatos nas views `v_reposicao_ruptura_*_semana` (migration 20261031200000); regra em ruptura-sensor-helpers.
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useRupturaSensor } from '@/hooks/useFinanceiroCiclo';
import { guardrailFillRate, pct, variacaoFillRatePp } from '@/lib/financeiro/ruptura-sensor-helpers';

const SEMANAS_VISIVEIS = 8;

const dm = (iso: string) => iso.slice(5, 10).split('-').reverse().join('/');

export function CicloRupturaSensor({ hoje }: { hoje: string }) {
  const { data, error, isLoading } = useRupturaSensor();
  const pedidos = (data?.pedidos ?? []).slice(-SEMANAS_VISIVEIS);
  const prateleira = (data?.prateleira ?? []).slice(-SEMANAS_VISIVEIS);
  const variacao = data ? variacaoFillRatePp(data.pedidos, hoje) : null;
  const guardrail = guardrailFillRate(variacao);
  const ultimaPrateleira = prateleira.length > 0 ? prateleira[prateleira.length - 1] : null;

  return (
    <Card data-testid="ciclo-ruptura-sensor">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Oben — sensor de ruptura (fill-rate)</CardTitle>
        <p className="text-xs text-muted-foreground">
          Pedidos do Omie × estoque no instante da importação (PV já faturado = indeterminado; sem leitura fresca = sem leitura).
          Fill-rate = atendíveis ÷ decididos, só com ≥ 20 itens na semana. Prateleira = SKUs com venda em 90 d sem saldo hoje.
          Guardrail: queda &gt; 1 p.p. entre semanas fechadas pausa o "segurar compra".
        </p>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {error && <p className="text-status-error text-xs">Não foi possível ler o sensor de ruptura.</p>}
        {isLoading && <p className="text-xs text-muted-foreground">…</p>}
        {data && (
          <>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div>
                <div className="text-xs text-muted-foreground">Fill-rate (última semana fechada)</div>
                <div className="font-mono text-lg" data-testid="ruptura-fill-rate">
                  {variacao ? pct(pedidos.find((s) => s.semana === variacao.para)?.fillRatePct ?? null) : '—'}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Variação vs anterior</div>
                <div className={`font-mono text-lg ${guardrail === 'queda' ? 'text-status-error' : guardrail === 'estavel' ? 'text-status-success' : ''}`} data-testid="ruptura-guardrail">
                  {variacao ? `${variacao.pp >= 0 ? '+' : ''}${variacao.pp.toFixed(1).replace('.', ',')} p.p.` : '— (sem 2 semanas fechadas)'}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Prateleira: SKUs com venda sem saldo</div>
                <div className="font-mono text-lg" data-testid="ruptura-prateleira">
                  {ultimaPrateleira ? pct(ultimaPrateleira.pctSkusSemSaldo) : '—'}
                </div>
                {ultimaPrateleira && (
                  <div className="text-xs text-muted-foreground">
                    {ultimaPrateleira.skusComVenda90d ?? '—'} SKUs · sem leitura {pct(ultimaPrateleira.pctSkusSemLeitura)} · lido {ultimaPrateleira.ultimoDia ? dm(ultimaPrateleira.ultimoDia) : '—'}
                  </div>
                )}
              </div>
            </div>
            {pedidos.length === 0 ? (
              <p className="text-xs text-muted-foreground">Sem pedido importado desde que o sensor entrou (a trilha começa na importação seguinte à migration).</p>
            ) : (
              <table className="w-full text-xs" data-testid="ruptura-semanas">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="text-left font-normal">Semana</th>
                    <th className="text-right font-normal">Itens</th>
                    <th className="text-right font-normal">Atendíveis</th>
                    <th className="text-right font-normal">Ruptura</th>
                    <th className="text-right font-normal">Indet.</th>
                    <th className="text-right font-normal">Sem leitura</th>
                    <th className="text-right font-normal">Fill-rate</th>
                    <th className="text-right font-normal">Cobertura</th>
                  </tr>
                </thead>
                <tbody>
                  {pedidos.map((s) => (
                    <tr key={s.semana}>
                      <td>{dm(s.semana)}</td>
                      <td className="text-right font-mono">{s.itensRegistrados}</td>
                      <td className="text-right font-mono">{s.atendiveis}</td>
                      <td className={`text-right font-mono ${s.ruptura > 0 ? 'text-status-warning' : ''}`}>{s.ruptura}</td>
                      <td className="text-right font-mono">{s.indeterminados}</td>
                      <td className="text-right font-mono">{s.semLeitura}</td>
                      <td className="text-right font-mono">{pct(s.fillRatePct)}</td>
                      <td className="text-right font-mono">{pct(s.coberturaPct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
