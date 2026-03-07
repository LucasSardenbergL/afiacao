import { useParams } from 'react-router-dom';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { OrderChat } from '@/components/OrderChat';
import { SendingQualityChecklist } from '@/components/SendingQualityChecklist';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2 } from 'lucide-react';
import { useAdminOrderDetail } from '@/hooks/useAdminOrderDetail';
import { OrderCustomerHeader } from '@/components/admin-order/OrderCustomerHeader';
import { OrderStatusSelect } from '@/components/admin-order/OrderStatusSelect';
import { OrderItemsPricing } from '@/components/admin-order/OrderItemsPricing';
import { OrderFinancialSummary } from '@/components/admin-order/OrderFinancialSummary';
import { OrderActionButtons } from '@/components/admin-order/OrderActionButtons';

const AdminOrderDetail = () => {
  const { id } = useParams<{ id: string }>();
  const {
    order,
    profile,
    loading,
    saving,
    syncingOmie,
    deleting,
    isStaff,
    itemPrices,
    setItemPrices,
    selectedStatus,
    setSelectedStatus,
    currentSubtotal,
    currentTotal,
    applySuggestedPrice,
    hasAnySuggestedPrice,
    getSuggestedPriceSource,
    handleSave,
    handleDelete,
  } = useAdminOrderDetail(id);

  if (loading) {
    return (
      <div className="min-h-screen bg-background pb-24">
        <Header title="Detalhes do Pedido" showBack />
        <div className="flex items-center justify-center pt-32">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
        <BottomNav />
      </div>
    );
  }

  if (!order) {
    return (
      <div className="min-h-screen bg-background pb-24">
        <Header title="Pedido não encontrado" showBack />
        <div className="flex items-center justify-center pt-32">
          <p className="text-muted-foreground">Pedido não encontrado</p>
        </div>
        <BottomNav />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-32">
      <Header title="Triagem de Pedido" showBack />

      <main className="pt-16 px-4 max-w-lg mx-auto">
        <OrderCustomerHeader order={order} profile={profile} />

        <OrderStatusSelect
          selectedStatus={selectedStatus}
          onStatusChange={setSelectedStatus}
        />

        <OrderItemsPricing
          items={order.items}
          itemPrices={itemPrices}
          onPriceChange={(index, value) =>
            setItemPrices((prev) => ({ ...prev, [index]: value }))
          }
          onApplySuggested={applySuggestedPrice}
          hasAnySuggestedPrice={hasAnySuggestedPrice}
          getSuggestedPriceSource={getSuggestedPriceSource}
        />

        <div className="mb-4">
          <SendingQualityChecklist orderId={order.id} userId={order.user_id} />
        </div>

        <OrderFinancialSummary
          subtotal={currentSubtotal}
          deliveryFee={order.delivery_fee || 0}
          total={currentTotal}
        />

        <Card className="mb-4">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">💬 Chat com Cliente</CardTitle>
          </CardHeader>
          <CardContent>
            <OrderChat orderId={order.id} />
          </CardContent>
        </Card>

        <OrderActionButtons
          orderId={order.id}
          saving={saving}
          syncingOmie={syncingOmie}
          deleting={deleting}
          onSave={handleSave}
          onDelete={handleDelete}
        />
      </main>

      <BottomNav />
    </div>
  );
};

export default AdminOrderDetail;
