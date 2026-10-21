import { Skeleton } from '@/components/ui/skeleton';
import { formatPrecoOuAusente } from '@/lib/format';
import type { Historico } from '@/lib/venda-cliente/historico';

function dataCurta(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime())
    ? d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'America/Sao_Paulo' })
    : '—';
}

interface Props {
  historico: Historico | null;
  loading: boolean;
  erro: boolean;
}

/** Histórico: os últimos pedidos de venda do cliente (o universo de venda é filtrado no hook). */
export function SecaoHistorico({ historico, loading, erro }: Props) {
  return (
    <section aria-labelledby="ficha-historico">
      <h3 id="ficha-historico" className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">
        Últimos pedidos
      </h3>
      {loading ? (
        <div className="mt-2 space-y-1.5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-8 w-full" />)}</div>
      ) : erro ? (
        // Erro ≠ "nunca comprou": a farmer entraria na ligação achando que é cliente novo.
        <p className="mt-2 text-2xs text-status-warning">Não consegui ler os pedidos deste cliente agora.</p>
      ) : !historico || historico.ultimosPedidos.length === 0 ? (
        <p className="mt-2 text-2xs text-muted-foreground">Nenhum pedido de venda registrado.</p>
      ) : (
        <ul className="mt-2 divide-y divide-border rounded-md border">
          {historico.ultimosPedidos.map((p, i) => (
            <li key={`${p.data}:${i}`} className="px-3 py-2 flex items-center justify-between text-sm">
              <span className="tabular-nums">{dataCurta(p.data)}</span>
              <span className="text-2xs text-muted-foreground tabular-nums">
                {p.nItens} {p.nItens === 1 ? 'item' : 'itens'}
              </span>
              <span className="font-medium tabular-nums">{formatPrecoOuAusente(p.valor)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
