import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AlertCircle } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { EmptyState } from '@/components/EmptyState';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { AvisoLeituraFalhou } from '@/components/leitura/AvisoLeituraFalhou';
import { estadoDeRegistro, naoConsegui } from '@/lib/leitura/estado-de-leitura';
import { useCustomerContacts } from '@/hooks/useCustomerContacts';
import { useSalespeople } from '@/hooks/useCoverage';
import { useFeatureFlag } from '@/hooks/useFeatureFlag';
import { useReguaPreco360 } from '@/hooks/useReguaPreco360';
import {
  useCustomerCore,
  useCustomerAddress,
  useCustomerMetrics,
  useCustomerScore,
  useCustomerPreferredItems,
  useCustomerOrders,
  useCustomerFaturamento12m,
  useCustomerInteractions,
} from '@/components/customer360/hooks';
import { CustomerHero } from '@/components/customer360/CustomerHero';
import { CustomerKpiStrip } from '@/components/customer360/CustomerKpiStrip';
import { leituraDaQuery } from '@/components/customer360/kpi-rotulos';
import { IdentityColumn } from '@/components/customer360/IdentityColumn';
import { ActivityColumn } from '@/components/customer360/ActivityColumn';
import { VozTarefaDialog } from '@/components/tarefas/VozTarefaDialog';

export default function Customer360() {
  const { customerId } = useParams<{ customerId: string }>();
  const navigate = useNavigate();
  const { user, isMaster, isGestorComercial, isStaff } = useAuth();
  const [abrirVozTarefa, setAbrirVozTarefa] = useState(false);

  const { data: customer, status: statusCore, fetchStatus: fetchCore, refetch: refetchCore } =
    useCustomerCore(customerId);
  const address = useCustomerAddress(customerId);
  const metrics = useCustomerMetrics(customerId);
  const score = useCustomerScore(customerId, user?.id);
  const preferred = useCustomerPreferredItems(customerId);
  const orders = useCustomerOrders(customerId);
  const faturamento12m = useCustomerFaturamento12m(customerId);
  const interactions = useCustomerInteractions(customerId);

  // Régua de Preço (readonly) nos itens preferidos — só Oben, só staff, atrás de flag (off).
  const [regua360Flag] = useFeatureFlag('regua_preco_360');
  const omieCodigosRegua = useMemo(
    () => (preferred.data ?? []).filter((it) => it.account === 'oben').map((it) => it.omie_codigo_produto),
    [preferred.data],
  );
  const { reguaByOmie } = useReguaPreco360(customerId, omieCodigosRegua, regua360Flag && isStaff);

  // Contatos extras (PR-CONTACTS): múltiplos contatos por cliente (dono, gerente,
  // comprador, etc). Edição completa fica em /admin/customers detail tab — aqui
  // mostro só leitura compacta pra contexto operacional.
  const contacts = useCustomerContacts(customerId ?? null);
  const { data: salespeople = [] } = useSalespeople();
  // #9 (P0-B-bis PR-4): NÃO derivamos a empresa da tarefa do espelho omie_clientes — empresa_omie lá é
  // 100% 'colacor' (rótulo fabricado, nenhum writer o seta). A tarefa por voz usa o default explícito
  // empresa="oben" da tela (Oben-cêntrica); derivar da view fresca seria ambíguo p/ cliente multi-conta
  // (precisão>recall: não fabricar a conta). Ver design §4 #9.

  // Faturamento 12m: query PRÓPRIA no universo de venda (ver useCustomerFaturamento12m). A lista
  // `orders` é só o feed "Pedidos recentes" — todo status, de propósito — e não é fonte de número.
  // As duas fontes da faixa passam pela MESMA ponte de estado: sem valor → o motivo; valor em mãos
  // cujo refetch falhou → o valor FICA, declarando a idade (nunca como recém-lido).
  const leitura12m = leituraDaQuery(faturamento12m);
  const leituraMetricas = leituraDaQuery(metrics);

  // `.maybeSingle()`: "não existe" é `null` em SUCESSO; erro e offline deixam `undefined`. Sem `error`
  // de propósito — aqui o PGRST116 seria MAIS de uma linha (zero é `null`), e "inexistente" mentiria.
  const estadoCore = estadoDeRegistro({ status: statusCore, fetchStatus: fetchCore }, customer != null);

  if (estadoCore === 'carregando') {
    return <PageSkeleton variant="detail" />;
  }

  // Sem o cliente em mãos, "não consegui ler" NÃO é "não existe": o `if (!core.data)` de antes fundia
  // os dois — e sem rede (`pending`+`paused`, `isLoading` FALSE) nem passava pelo esqueleto. Com o
  // cliente no cache, o refetch que falha não derruba a página.
  if (naoConsegui(estadoCore) && !customer) {
    return (
      <div className="mx-auto max-w-xl space-y-3 py-8">
        <AvisoLeituraFalhou
          oque="os dados deste cliente"
          estado={estadoCore}
          variante="bloco"
          testId="aviso-c360-cliente"
        />
        {estadoCore === 'sem-rede' && (
          <p className="text-2xs text-muted-foreground">A página abre sozinha quando a conexão voltar.</p>
        )}
        <div className="flex flex-wrap gap-2">
          {/* sem rede, tentar de novo só pausaria de novo — o react-query retoma sozinho com a rede */}
          {estadoCore === 'erro' && (
            <Button size="sm" variant="outline" onClick={() => refetchCore()}>
              Tentar de novo
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => navigate('/admin/customers')}>
            Voltar para Clientes
          </Button>
        </div>
      </div>
    );
  }

  // Daqui em diante a leitura RESPONDEU (ou nem foi feita: sem id na URL) — `null` é "não existe".
  if (!customer) {
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

        <CustomerKpiStrip faturamento12m={leitura12m} metricas={leituraMetricas} score={s} />

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
            reguaByOmie={reguaByOmie}
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
          }}
        />
      )}
    </TooltipProvider>
  );
}
