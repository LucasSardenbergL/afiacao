/**
 * Ranking de vendedores do mês (MTD) no dashboard Master. Read-only, escopo da empresa
 * do switcher. Ordena por receita de pedidos válidos, atribuído por quem LANÇOU (created_by);
 * rodapé expõe "não atribuído" e "sem pedido no mês". Self-hide sem pedidos.
 * Conversão de visita fica fora (route_visits não tem account → seria cross-empresa). v2.
 * Spec: docs/superpowers/specs/2026-06-04-master-visao-time-design.md
 */
import { Card, CardHeader } from '@/components/ui/card';
import { Trophy, Loader2 } from 'lucide-react';
import { useTeamRanking } from '@/hooks/useTeamRanking';
import { useCompany } from '@/contexts/CompanyContext';
import { formatBRL } from '@/components/customer360/format';

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

  const { ranking, naoAtribuido, semAtividade } = data;
  if (ranking.length === 0 && naoAtribuido.pedidos === 0) return null; // sem pedidos no mês

  const visiveis = ranking.slice(0, TOP);
  const restante = ranking.length - visiveis.length;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 pb-3">
        <div className="flex items-center gap-2">
          <Trophy className="w-4 h-4 text-muted-foreground" />
          <div>
            <h2 className="text-base font-medium">Ranking de vendedores · mês</h2>
            <p className="text-2xs text-muted-foreground">por quem lançou o pedido · {escopo}</p>
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

      {(restante > 0 || naoAtribuido.pedidos > 0 || semAtividade > 0) && (
        <div className="px-4 pb-3 pt-2 space-y-0.5 text-2xs text-muted-foreground">
          {restante > 0 && (
            <div>
              +{restante} vendedor{restante > 1 ? 'es' : ''} com pedido
            </div>
          )}
          {naoAtribuido.pedidos > 0 && (
            <div>
              Sem vendedor atribuído: {formatBRL(naoAtribuido.receita)} · {naoAtribuido.pedidos} ped.
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
