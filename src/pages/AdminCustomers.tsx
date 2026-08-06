// Clientes (admin) — carteira com scoring, lista densa e perfil 360.
// Composição: useAdminCustomers (queries/loads/handlers) + CustomerListView / Customer360View.
// God-component split de src/pages/AdminCustomers.tsx (comportamento 1:1).
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { AddToolDialog } from '@/components/AddToolDialog';
import { useAdminCustomers } from '@/components/adminCustomers/useAdminCustomers';
import { CustomerListView } from '@/components/adminCustomers/CustomerListView';
import { Customer360View } from '@/components/adminCustomers/Customer360View';

const AdminCustomers = () => {
  const {
    authLoading,
    isStaff,
    loading,
    customers,
    scores,
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
          total={total}
          isCarteira={isCarteira}
          onSelect={handleSelectCustomer}
          hasNextPage={hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          onLoadMore={fetchNextPage}
        />
      )}
    </>
  );
};

export default AdminCustomers;
