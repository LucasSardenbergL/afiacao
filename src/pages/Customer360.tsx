import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { parseISO, subMonths } from 'date-fns';
import { AlertCircle } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { EmptyState } from '@/components/EmptyState';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { useCustomerContacts } from '@/hooks/useCustomerContacts';
import { useSalespeople } from '@/hooks/useCoverage';
import {
  useCustomerCore,
  useCustomerAddress,
  useCustomerMetrics,
  useCustomerScore,
  useCustomerPreferredItems,
  useCustomerOrders,
  useCustomerInteractions,
} from '@/components/customer360/hooks';
import { CustomerHero } from '@/components/customer360/CustomerHero';
import { CustomerKpiStrip } from '@/components/customer360/CustomerKpiStrip';
import { IdentityColumn } from '@/components/customer360/IdentityColumn';
import { ActivityColumn } from '@/components/customer360/ActivityColumn';
import { VozTarefaDialog } from '@/components/tarefas/VozTarefaDialog';

export default function Customer360() {
  const { customerId } = useParams<{ customerId: string }>();
  const navigate = useNavigate();
  const { user, isMaster, isGestorComercial } = useAuth();
  const [abrirVozTarefa, setAbrirVozTarefa] = useState(false);

  const core = useCustomerCore(customerId);
  const address = useCustomerAddress(customerId);
  const metrics = useCustomerMetrics(customerId);
  const score = useCustomerScore(customerId, user?.id);
  const preferred = useCustomerPreferredItems(customerId);
  const orders = useCustomerOrders(customerId);
  const interactions = useCustomerInteractions(customerId);
  // Contatos extras (PR-CONTACTS): múltiplos contatos por cliente (dono, gerente,
  // comprador, etc). Edição completa fica em /admin/customers detail tab — aqui
  // mostro só leitura compacta pra contexto operacional.
  const contacts = useCustomerContacts(customerId ?? null);
  const { data: salespeople = [] } = useSalespeople();

  // Lifetime + 12m derivados dos pedidos
  const revenueDerived = useMemo(() => {
    const list = orders.data ?? [];
    const lifetime = list.reduce((s, o) => s + Number(o.total ?? 0), 0);
    const cutoff = subMonths(new Date(), 12);
    const last12 = list
      .filter((o) => parseISO(o.created_at) >= cutoff)
      .reduce((s, o) => s + Number(o.total ?? 0), 0);
    const orderCount12m = list.filter((o) => parseISO(o.created_at) >= cutoff).length;
    const lastOrder = list[0];
    return { lifetime, last12, orderCount12m, lastOrderAt: lastOrder?.created_at ?? null };
  }, [orders.data]);

  if (core.isLoading || (core.isFetching && !core.data)) {
    return <PageSkeleton variant="detail" />;
  }

  if (!core.data) {
    return (
      <EmptyState
        icon={AlertCircle}
        title="Cliente não encontrado"
        description="Pode ter sido removido ou o link está errado. Volte pra lista e tente de novo."
        tone="operational"
        actionLabel="Voltar para Clientes"
        onAction={() => navigate('/admin/customers')}
      />
    );
  }

  const customer = core.data;
  const m = metrics.data;
  const s = score.data;
  const isPj = (customer.document ?? '').replace(/\D/g, '').length === 14;
  const podeCriarTarefaPorVoz = isMaster || isGestorComercial;

  return (
    <TooltipProvider delayDuration={150}>
      <div className="pb-12 space-y-6">
        <div className="relative">
          <CustomerHero
            customer={customer}
            score={s}
            isPj={isPj}
            onBack={() => navigate('/admin/customers')}
          />
          {podeCriarTarefaPorVoz && (
            <div className="absolute top-3 right-3">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setAbrirVozTarefa(true)}
                disabled={salespeople.length === 0}
                className="gap-1.5"
              >
                🎙️ Criar tarefa por voz
              </Button>
            </div>
          )}
        </div>

        <CustomerKpiStrip revenueDerived={revenueDerived} metrics={m} score={s} />

        {/* ─── Grid principal ─── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <IdentityColumn
            customer={customer}
            isPj={isPj}
            customerId={customerId}
            contacts={contacts}
            address={address}
            score={s}
          />

          <ActivityColumn
            preferred={preferred}
            interactions={interactions}
            orders={orders}
            customer={customer}
          />
        </div>
      </div>

      {/* Dialog de criar tarefa por voz com cliente fixo */}
      {podeCriarTarefaPorVoz && customerId && (
        <VozTarefaDialog
          open={abrirVozTarefa}
          onOpenChange={setAbrirVozTarefa}
          vendedoras={salespeople.map((s) => ({ user_id: s.user_id, nome: s.name }))}
          empresa="oben"
          clienteFixo={{
            customer_user_id: customerId,
            nome: customer.name ?? 'Cliente',
            empresa_omie: undefined,
          }}
        />
      )}
    </TooltipProvider>
  );
}
