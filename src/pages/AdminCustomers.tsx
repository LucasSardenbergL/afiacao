// Clientes (admin) — carteira com scoring, lista densa e perfil 360.
// Composição: useAdminCustomers (queries/loads/handlers) + CustomerListView / Customer360View.
// God-component split de src/pages/AdminCustomers.tsx (comportamento 1:1).
import { AlertTriangle, UserX } from 'lucide-react';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { EmptyState } from '@/components/EmptyState';
import { AddToolDialog } from '@/components/AddToolDialog';
import { useAdminCustomers } from '@/components/adminCustomers/useAdminCustomers';
import { CustomerListView } from '@/components/adminCustomers/CustomerListView';
import { Customer360View } from '@/components/adminCustomers/Customer360View';

const AdminCustomers = () => {
  const {
    authLoading,
    isStaff,
    loading,
    isError,
    refetch,
    customers,
    scores,
    buscaNoServidor,
    buscando,
    estadoDeepLink,
    retryDeepLink,
    categories,
    total,
    isCarteira,
    selectedCustomer,
    customerTools,
    orders,
    loadingTools,
    loadingOrders,
    addToolDialogOpen,
    setAddToolDialogOpen,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    handleSelectCustomer,
    handleDeleteTool,
    handleBack,
    reloadSelectedTools,
  } = useAdminCustomers();

  if (authLoading || loading) {
    return (
      <PageSkeleton variant="list" />
    );
  }

  if (!isStaff) return null;

  // Deep link (/admin/customers/:id) ainda sem ficha: nunca cair silenciosamente na lista.
  if (!selectedCustomer && estadoDeepLink !== 'nenhum') {
    if (estadoDeepLink === 'carregando' || estadoDeepLink === 'encontrado') {
      return <PageSkeleton variant="list" />;
    }
    if (estadoDeepLink === 'erro') {
      return (
        <div role="alert">
          <EmptyState
            icon={AlertTriangle}
            title="Não foi possível abrir este cliente"
            description="A leitura do cadastro falhou — não dá pra afirmar que o cliente não existe."
            actionLabel="Tentar novamente"
            onAction={retryDeepLink}
            secondaryActionLabel="Voltar para a lista"
            onSecondaryAction={handleBack}
          />
        </div>
      );
    }
    return (
      <EmptyState
        icon={UserX}
        title={estadoDeepLink === 'fora_do_escopo' ? 'Cliente fora da sua carteira' : 'Cliente não encontrado'}
        description={
          estadoDeepLink === 'fora_do_escopo'
            ? 'Este cliente não faz parte da carteira em exibição.'
            : 'Nenhum cliente com este identificador está visível para você.'
        }
        actionLabel="Voltar para a lista"
        onAction={handleBack}
      />
    );
  }

  return (
    <>
      <AddToolDialog
        open={addToolDialogOpen}
        onOpenChange={setAddToolDialogOpen}
        onToolAdded={reloadSelectedTools}
        categories={categories}
        targetUserId={selectedCustomer?.user_id}
      />

      {selectedCustomer ? (
        <Customer360View
          customer={selectedCustomer}
          score={scores.get(selectedCustomer.user_id)}
          tools={customerTools}
          orders={orders}
          categories={categories}
          loadingTools={loadingTools}
          loadingOrders={loadingOrders}
          onBack={handleBack}
          onAddTool={() => setAddToolDialogOpen(true)}
          onDeleteTool={handleDeleteTool}
        />
      ) : (
        <CustomerListView
          customers={customers}
          scores={scores}
          loading={loading}
          isError={isError}
          onRetry={refetch}
          total={total}
          isCarteira={isCarteira}
          onSelect={handleSelectCustomer}
          hasNextPage={hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          onLoadMore={fetchNextPage}
          buscaNoServidor={buscaNoServidor}
          buscando={buscando}
        />
      )}
    </>
  );
};

export default AdminCustomers;
