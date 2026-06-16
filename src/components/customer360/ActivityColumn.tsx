// Coluna de atividade (Itens preferidos, Últimos contatos, Pedidos recentes) do Customer 360.
// Extraída de src/pages/Customer360.tsx (god-component split).
import { Link } from 'react-router-dom';
import { Package, PhoneCall, MessageSquare, ShoppingBag, Inbox } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { EmptyState } from '@/components/EmptyState';
import { cn } from '@/lib/utils';
import { ReguaPrecoSinal } from '@/components/regua-preco/ReguaPrecoSinal';
import type { Regua360Entry } from '@/hooks/useReguaPreco360';
import { formatBRL, formatRelative, formatDateOrDash, orderStatusTone } from './format';
import type { Customer, PreferredQuery, OrdersQuery, InteractionsQuery } from './viewTypes';

export function ActivityColumn({
  preferred, interactions, orders, customer, reguaByOmie,
}: {
  preferred: PreferredQuery;
  interactions: InteractionsQuery;
  orders: OrdersQuery;
  customer: Customer;
  /** Régua de Preço por omie_codigo (readonly). Vazio/undefined quando a flag está off. */
  reguaByOmie?: Map<number, Regua360Entry>;
}) {
  return (
    <div className="lg:col-span-2 space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Package className="w-4 h-4 text-muted-foreground" />
            Itens preferidos
            <Badge variant="outline" className="ml-auto text-[10px] uppercase font-tabular">
              {preferred.data?.length ?? 0}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {preferred.isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-10 bg-muted/40 rounded animate-pulse" />
              ))}
            </div>
          ) : preferred.data && preferred.data.length > 0 ? (
            <ul className="divide-y divide-border -my-2">
              {preferred.data.map((it) => {
                // só Oben (os códigos do batch são oben); guarda contra colisão de omie_codigo entre contas
                const regua = it.account === 'oben' && it.omie_codigo_produto != null
                  ? reguaByOmie?.get(it.omie_codigo_produto)
                  : undefined;
                return (
                <li key={`${it.product_codigo}-${it.account}`} className="py-2.5 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">
                      {it.product_descricao ?? `Produto ${it.product_codigo}`}
                    </div>
                    <div className="text-xs text-muted-foreground flex items-center gap-2 mt-0.5 flex-wrap">
                      <span className="font-tabular">{it.product_codigo}</span>
                      {it.familia && (
                        <>
                          <span>·</span>
                          <span>{it.familia}</span>
                        </>
                      )}
                      {it.account && (
                        <>
                          <span>·</span>
                          <span className="uppercase tracking-wide">{it.account}</span>
                        </>
                      )}
                      {regua && (
                        <ReguaPrecoSinal
                          mode="readonly"
                          result={regua.result}
                          precoAtual={regua.precoAtual}
                          contexto={{
                            produto: it.product_descricao ?? `Produto ${it.product_codigo}`,
                            cliente: customer.name ?? null,
                            qty: regua.qtyRef,
                          }}
                        />
                      )}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-mono">{it.order_count ?? 0}x</div>
                    <div className="text-xs text-muted-foreground">
                      {it.last_ordered_at ? formatRelative(it.last_ordered_at) : '—'}
                    </div>
                  </div>
                </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState
              icon={Package}
              title="Sem itens preferidos ainda"
              description="Aparecerão depois das primeiras compras."
              tone="operational"
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <PhoneCall className="w-4 h-4 text-muted-foreground" />
            Últimos contatos
            <Badge variant="outline" className="ml-auto text-[10px] uppercase font-tabular">
              {interactions.data?.length ?? 0}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {interactions.isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-12 bg-muted/40 rounded animate-pulse" />
              ))}
            </div>
          ) : interactions.data && interactions.data.length > 0 ? (
            <ul className="space-y-2.5">
              {interactions.data.map((it, i) => (
                <li key={i} className="flex items-start gap-3 text-sm">
                  <span
                    className={cn(
                      'inline-flex items-center justify-center w-6 h-6 rounded-full bg-muted shrink-0',
                      it.tone,
                    )}
                  >
                    {it.kind === 'call' ? (
                      <PhoneCall className="w-3 h-3" />
                    ) : (
                      <MessageSquare className="w-3 h-3" />
                    )}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium">{it.title}</span>
                      <span className="text-xs text-muted-foreground">·</span>
                      <span className="text-xs text-muted-foreground">
                        {formatRelative(it.at)}
                      </span>
                      {it.kind === 'call' && it.revenue != null && it.revenue > 0 && (
                        <Badge className="text-[9px] uppercase bg-status-success-bg text-status-success-bold hover:bg-status-success-bg">
                          +{formatBRL(it.revenue)}
                        </Badge>
                      )}
                    </div>
                    {it.subtitle && (
                      <p className="text-xs text-muted-foreground leading-snug mt-0.5 line-clamp-2">
                        {it.subtitle}
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              icon={Inbox}
              title="Sem contatos recentes"
              description="Nenhuma ligação ou mensagem registrada nas últimas semanas."
              tone="operational"
            />
          )}
        </CardContent>
      </Card>

      {/* Pedidos recentes resumido */}
      {orders.data && orders.data.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <ShoppingBag className="w-4 h-4 text-muted-foreground" />
              Pedidos recentes
              <Badge variant="outline" className="ml-auto text-[10px] uppercase font-tabular">
                {orders.data.length}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-border -my-2">
              {orders.data.slice(0, 5).map((o) => {
                // F11: badge de status com tom semântico (verde p/ faturado, vermelho
                // p/ cancelado, âmbar p/ pendente). Cinza só se status não mapeado.
                const tone = orderStatusTone(o.status);
                return (
                  <li key={o.id} className="py-2 flex items-center gap-3 text-sm">
                    <div className="flex-1 min-w-0">
                      <div className="font-tabular text-foreground">
                        PV {o.omie_numero_pedido ?? o.id.slice(0, 8)}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {formatDateOrDash(o.created_at)} ·{' '}
                        <span className="uppercase tracking-wide">{o.account}</span>
                      </div>
                    </div>
                    <div className="text-sm font-mono tabular-nums">{formatBRL(o.total)}</div>
                    <Badge
                      variant="outline"
                      className={cn('text-[10px] uppercase font-tabular', tone.className)}
                    >
                      {tone.label}
                    </Badge>
                  </li>
                );
              })}
            </ul>
            {orders.data.length > 5 && (
              <>
                <Separator className="my-3" />
                <div className="text-right">
                  <Button
                    asChild
                    variant="ghost"
                    size="sm"
                    className="text-xs h-7"
                  >
                    <Link to={`/sales?customer=${customer.user_id}`}>
                      Ver todos ({orders.data.length})
                    </Link>
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
