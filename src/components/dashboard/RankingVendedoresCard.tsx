/**
 * Ranking de vendedores do mês (MTD) no dashboard Master. Read-only, escopo da empresa do switcher.
 * Ordena por receita de pedidos válidos, atribuída ao DONO ATUAL da carteira elegível do cliente (a régua
 * da positivação e da comissão — o `created_by` da importada é carimbo técnico, não quem vendeu).
 * O rodapé separa "carteira de não-vendedor" (dono sem papel de venda) de "sem vendedor atribuído"
 * (cliente sem carteira) e expõe "sem pedido no mês". Some só sem pedido em nenhum dos três destinos.
 * Conversão de visita fica fora (route_visits não tem account → seria cross-empresa).
 * Specs: docs/superpowers/specs/2026-06-04-master-visao-time-design.md
 *        docs/superpowers/specs/2026-10-06-ranking-atribuicao-por-carteira-design.md
 */
import { Card, CardHeader } from '@/components/ui/card';
import { Trophy, Loader2 } from 'lucide-react';
import { useTeamRanking } from '@/hooks/useTeamRanking';
import { useCompany } from '@/contexts/CompanyContext';
import { formatBRL } from '@/components/customer360/format';
import { rankingSemPedido } from '@/lib/dashboard/team-kpis';

const TOP = 8;

export function RankingVendedoresCard() {
  const { data, isLoading, isError } = useTeamRanking();
  const { selection, companyInfo } = useCompany();
  const escopo = selection === 'all' ? 'todas as empresas' : companyInfo.shortName;

  if (isLoading) {
    return (
      <Card className="p-6 flex justify-center">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </Card>
    );
  }
  if (isError) {
    return (
      <Card className="p-4 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <Trophy className="w-4 h-4" />
          Ranking de vendedores
        </div>
        <p className="mt-2">Indisponível no momento.</p>
      </Card>
    );
  }
  if (!data) return null;
  if (rankingSemPedido(data)) return null; // nenhum dos 3 destinos tem pedido no mês

  const { ranking, carteiraNaoVendedor, naoAtribuido, semAtividade } = data;
  const visiveis = ranking.slice(0, TOP);
  const restante = ranking.length - visiveis.length;
  const temRodape =
    restante > 0 || carteiraNaoVendedor.pedidos > 0 || naoAtribuido.pedidos > 0 || semAtividade > 0;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 pb-3">
        <div className="flex items-center gap-2">
          <Trophy className="w-4 h-4 text-muted-foreground" />
          <div>
            <h2 className="text-base font-medium">Ranking de vendedores · mês</h2>
            <p className="text-2xs text-muted-foreground">por dono da carteira · {escopo}</p>
          </div>
        </div>
      </CardHeader>

      <div className="divide-y divide-border">
        {visiveis.map((v, i) => (
          <div key={v.id} className="px-4 py-2.5 flex items-center gap-3">
            <div className="w-5 text-center text-xs font-medium text-muted-foreground tabular-nums">{i + 1}</div>
            <div className="flex-1 min-w-0 text-sm font-medium truncate">{v.nome}</div>
            <div className="text-2xs text-muted-foreground tabular-nums">{v.pedidos} ped.</div>
            <div className="text-sm font-medium tabular-nums w-28 text-right">{formatBRL(v.receita)}</div>
          </div>
        ))}
      </div>

      {temRodape && (
        <div className="px-4 pb-3 pt-2 space-y-0.5 text-2xs text-muted-foreground">
          {restante > 0 && (
            <div>
              +{restante} vendedor{restante > 1 ? 'es' : ''} com pedido
            </div>
          )}
          {carteiraNaoVendedor.pedidos > 0 && (
            <div title="Dono da carteira sem papel farmer, hunter nem closer — hoje o master e o pool órfão.">
              Carteira de não-vendedor: {formatBRL(carteiraNaoVendedor.receita)} · {carteiraNaoVendedor.pedidos} ped. — dono sem papel de venda
            </div>
          )}
          {naoAtribuido.pedidos > 0 && (
            <div title="Cliente sem carteira elegível (ou pedido sem cliente).">
              Sem vendedor atribuído: {formatBRL(naoAtribuido.receita)} · {naoAtribuido.pedidos} ped. — cliente sem carteira
            </div>
          )}
          {semAtividade > 0 && (
            <div>
              {semAtividade} vendedor{semAtividade > 1 ? 'es' : ''} sem pedido no mês
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
