import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { MoreVertical, Search, AlertTriangle } from 'lucide-react';
import { Card, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/EmptyState';
import { useMyMixGap } from '@/hooks/useMyMixGap';
import { useMarkMixGapFeedback } from '@/hooks/useMarkMixGapFeedback';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { buildPorQue } from '@/lib/mixgap/format';
import { track } from '@/lib/analytics';

/**
 * O card colapsava TRÊS estados numa tela em branco só, e o evento só saía num deles.
 *
 *   `if (totalComGap > 0 && !tracked.current) track('carteira.mixgap_visto', …)`
 *   `if (!data || data.totalComGap === 0) return null;`
 *
 * Como `useMyMixGap` LANÇA quando a RPC falha, `data` fica `undefined` no erro — mesma
 * condição do zero. Então "não há oportunidade", "não consegui ler" e "o vendedor nunca
 * abriu a tela" produziam o mesmo silêncio, na tela e no PostHog. É o §6/§12 do money-path
 * (a leitura que falha calada, o motivo que morre) na forma de ADOÇÃO: sem denominador,
 * zero não julga desenho nenhum (`docs/historico/fase-sem-sinal.md`).
 *
 * Não é hipótese: o motor por trás deste card está saindo de 116 para ~84 clientes com gap
 * (a fatia do denominador, #1853 — medido em prod via psql-ro). Sem separar os estados não
 * há como distinguir "caiu para 84" de "quebrou e sumiu", que é exatamente a pergunta que a
 * mudança faz nascer.
 *
 * ⚠️ O evento leva `total_com_gap: null` no erro, nunca `0`. Mandar zero seria fabricar o
 * número que o sensor existe para medir (§2 — ausente ≠ zero): a série de adoção passaria a
 * somar falhas de leitura como se fossem carteiras sem oportunidade.
 */
type EstadoMixGap = 'com_gap' | 'zero' | 'erro';

export function MixGapCard() {
  const { data, error, isLoading } = useMyMixGap();
  const { mutate: markFeedback } = useMarkMixGapFeedback();
  const { isImpersonating } = useImpersonation();

  // `data === null` é a RPC dizendo "você não é staff" (ela retorna NULL sem uid/sem role):
  // não é um estado do card, é ausência de acesso — e aí o card não deve existir mesmo.
  // `undefined` com a query desabilitada (sem user) cai no mesmo lugar.
  const semAcesso = !isLoading && !error && (data === null || data === undefined);
  const estado: EstadoMixGap | null =
    isLoading || semAcesso ? null : error ? 'erro' : (data!.totalComGap > 0 ? 'com_gap' : 'zero');

  const trackedEstado = useRef<EstadoMixGap | null>(null);
  useEffect(() => {
    // Um evento por estado RESOLVIDO. A guarda por estado (e não por booleano) deixa passar a
    // transição erro → zero → com_gap dentro da mesma montagem, que é o dado que separa uma
    // falha transitória de uma carteira realmente vazia.
    if (!estado || trackedEstado.current === estado) return;
    trackedEstado.current = estado;
    track('carteira.mixgap_visto', {
      estado,
      total_com_gap: estado === 'erro' ? null : data!.totalComGap,
    });
  }, [estado, data]);

  if (semAcesso) return null;

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-3 w-64 mt-1.5" />
        </CardHeader>
        <div className="divide-y divide-border">
          {[0, 1, 2].map((i) => (
            <div key={i} className="p-3"><Skeleton className="h-4 w-full" /></div>
          ))}
        </div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <EmptyState
          tone="operational"
          icon={AlertTriangle}
          title="Não consegui carregar as oportunidades"
          description="A leitura da carteira falhou — isto NÃO significa que não há oportunidades. Recarregue a página; se persistir, avise o suporte."
        />
      </Card>
    );
  }

  if (data!.totalComGap === 0) {
    return (
      <Card>
        <EmptyState
          tone="operational"
          icon={Search}
          title="Nenhuma oportunidade de cross-sell agora"
          description="Todos os clientes da sua carteira já compram as famílias que clientes parecidos compram — ou as oportunidades abertas já foram marcadas."
        />
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <h2 className="text-base font-medium">Oportunidades de cross-sell</h2>
        <p className="text-2xs text-muted-foreground">
          {data!.totalComGap} clientes da sua carteira sem uma família que clientes parecidos compram
        </p>
      </CardHeader>
      <div className="divide-y divide-border">
        {data!.lista.slice(0, 20).map((g) => (
          <div key={g.customer_user_id} className="p-3 flex items-center justify-between gap-3 hover:bg-muted/30">
            <Link
              to={`/admin/customers/${g.customer_user_id}/360`}
              onClick={() => track('carteira.mixgap_cliente_aberto', { familia: g.familia_faltante })}
              className="min-w-0 flex-1"
            >
              <div className="text-sm font-medium truncate">{g.nome ?? 'Cliente sem nome'}</div>
              <div className="text-2xs text-muted-foreground">{buildPorQue(g)}</div>
            </Link>
            <div className="flex items-center gap-2 shrink-0">
              {g.feedback_status === 'ofertado' && (
                <Badge variant="outline" className="text-status-warning text-2xs">ofertado</Badge>
              )}
              <Badge variant="outline" className="text-status-info text-2xs">{g.familia_faltante}</Badge>
              <DropdownMenu>
                <DropdownMenuTrigger
                  disabled={isImpersonating}
                  title={isImpersonating ? 'Indisponível em modo Ver como' : 'Marcar oportunidade'}
                  className="p-1 rounded hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <MoreVertical className="w-4 h-4 text-muted-foreground" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => markFeedback({ customerUserId: g.customer_user_id, familia: g.familia_faltante, status: 'ofertado' })}>
                    Ofertado
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => markFeedback({ customerUserId: g.customer_user_id, familia: g.familia_faltante, status: 'convertido' })}>
                    Convertido
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => markFeedback({ customerUserId: g.customer_user_id, familia: g.familia_faltante, status: 'recusado' })}>
                    Recusado
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
