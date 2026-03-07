import { Loader2, ChevronLeft, CheckCircle, Building2, Scissors } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { RecommendationsPanel } from '@/components/RecommendationsPanel';
import { AddToolDialog } from '@/components/AddToolDialog';
import { UnifiedAIAssistant } from '@/components/UnifiedAIAssistant';
import { cn } from '@/lib/utils';
import { useUnifiedOrder } from '@/hooks/useUnifiedOrder';
import { useOrderDeepLink } from '@/hooks/useOrderDeepLink';
import { CustomerSearch } from '@/components/unified-order/CustomerSearch';
import { ProductItemForm } from '@/components/unified-order/ProductItemForm';
import { ServiceItemForm } from '@/components/unified-order/ServiceItemForm';
import { CartItemList } from '@/components/unified-order/CartItemList';
import { CartSummaryBar } from '@/components/unified-order/CartSummaryBar';

function OrderStepper({ step, isCustomerMode }: { step: number; isCustomerMode: boolean }) {
  const steps = isCustomerMode ? ['Itens', 'Revisão'] : ['Cliente', 'Itens', 'Revisão'];
  return (
    <div className="flex items-center gap-2 mb-4">
      {steps.map((s, i) => (
        <div key={s} className="flex items-center gap-2">
          <div className={cn('w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium transition-colors',
            i <= step ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')}>
            {i < step ? <CheckCircle className="w-3.5 h-3.5" /> : i + 1}
          </div>
          <span className={cn('text-xs font-medium', i <= step ? 'text-foreground' : 'text-muted-foreground')}>{s}</span>
          {i < steps.length - 1 && <div className={cn('w-8 h-px', i < step ? 'bg-primary' : 'bg-border')} />}
        </div>
      ))}
    </div>
  );
}

const UnifiedOrder = () => {
  const h = useUnifiedOrder();
  const { isCustomerMode } = h;

  useOrderDeepLink({
    selectedCustomer: h.selectedCustomer,
    selectCustomer: h.selectCustomer,
    addProductToCart: h.addProductToCart,
    obenProducts: h.obenProducts,
    colacorProducts: h.colacorProducts,
    loadingObenProducts: h.loadingObenProducts,
    loadingColacorProducts: h.loadingColacorProducts,
    loadingCustomer: h.loadingCustomer,
  });

  if (h.authLoading) {
    return <div className="flex items-center justify-center py-32"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>;
  }

  /* ─── Derived flags to keep UI clean ─── */
  const showCustomerSearch = !isCustomerMode;
  const showProductTabs = !isCustomerMode;
  const showAIAssistant = !isCustomerMode;
  const customerReady = !!h.selectedCustomer;

  return (
    <div className="max-w-5xl mx-auto space-y-4 pb-20">
      <div className="flex items-center gap-3">
        <button onClick={() => h.navigate(-1)} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="w-4 h-4" />
        </button>
        <div>
          <h1 className="text-lg font-semibold">
            {isCustomerMode ? 'Nova Ordem de Serviço' : 'Novo Pedido'}
          </h1>
          <p className="text-xs text-muted-foreground">
            {isCustomerMode
              ? 'Solicite afiação para suas ferramentas.'
              : 'Produtos Oben, Colacor e Afiação em um único pedido.'}
          </p>
        </div>
      </div>

      <OrderStepper step={h.currentStep} isCustomerMode={isCustomerMode} />

      <div className={cn('grid gap-4', showProductTabs ? 'grid-cols-1 lg:grid-cols-3' : 'grid-cols-1 lg:grid-cols-3')}>
        <div className={cn(showProductTabs ? 'lg:col-span-2' : 'lg:col-span-2', 'space-y-4')}>
          {/* AI Assistant — staff only */}
          {showAIAssistant && (
            <UnifiedAIAssistant
              products={[...h.obenProducts, ...h.colacorProducts] as any}
              userTools={h.userTools}
              onItemsIdentified={h.handleUnifiedAIResult}
              onCustomerIdentified={h.handleAICustomerSelect}
              customerUserId={h.customerUserId}
              hasCustomerSelected={!!h.selectedCustomer}
              isLoading={h.submitting}
            />
          )}

          {/* Customer search — staff only */}
          {showCustomerSearch && (
            <CustomerSearch
              selectedCustomer={h.selectedCustomer} customerUserId={h.customerUserId}
              customerSearch={h.customerSearch} onSearchChange={h.setCustomerSearch}
              customers={h.customers} searchingCustomers={h.searchingCustomers}
              loadingCustomer={h.loadingCustomer} validatingVendedor={h.validatingVendedor}
              vendedorDivergencias={h.vendedorDivergencias}
              onSelectCustomer={h.selectCustomer} onClearCustomer={h.clearCustomer}
            />
          )}

          {/* Item selection — adapted by role */}
          {customerReady && (
            <>
              {showProductTabs ? (
                /* Staff: full tabs with Oben, Colacor, Afiação */
                <Tabs value={h.activeTab} onValueChange={h.setActiveTab} className="space-y-3">
                  <TabsList className="w-full grid grid-cols-3">
                    <TabsTrigger value="oben" className="gap-1">
                      <Building2 className="w-3.5 h-3.5" /> Oben
                      {h.obenProductItems.length > 0 && <Badge variant="secondary" className="text-[10px] px-1 py-0 ml-1">{h.obenProductItems.length}</Badge>}
                    </TabsTrigger>
                    <TabsTrigger value="colacor" className="gap-1">
                      <Building2 className="w-3.5 h-3.5" /> Colacor
                      {h.colacorProductItems.length > 0 && <Badge variant="secondary" className="text-[10px] px-1 py-0 ml-1">{h.colacorProductItems.length}</Badge>}
                    </TabsTrigger>
                    <TabsTrigger value="services" className="gap-1">
                      <Scissors className="w-3.5 h-3.5" /> Afiação
                      {h.serviceItems.length > 0 && <Badge variant="secondary" className="text-[10px] px-1 py-0 ml-1">{h.serviceItems.length}</Badge>}
                    </TabsTrigger>
                  </TabsList>
                  <TabsContent value="oben">
                    <ProductItemForm title="Produtos Oben" products={h.filteredObenProducts} prices={h.customerPricesOben}
                      loading={h.loadingObenProducts} productSearch={h.productSearch} onSearchChange={h.setProductSearch}
                      productItems={h.productItems} onAddProduct={h.addProductToCart} />
                  </TabsContent>
                  <TabsContent value="colacor">
                    <ProductItemForm title="Produtos Colacor" products={h.filteredColacorProducts} prices={h.customerPricesColacor}
                      loading={h.loadingColacorProducts} productSearch={h.productSearch} onSearchChange={h.setProductSearch}
                      productItems={h.productItems} onAddProduct={h.addProductToCart} />
                  </TabsContent>
                  <TabsContent value="services">
                    <ServiceItemForm
                      customerUserId={h.customerUserId} loadingTools={h.loadingTools} loadingServicos={h.loadingServicos}
                      creatingLocalProfile={h.creatingLocalProfile} serviceItems={h.serviceItems} availableTools={h.availableTools}
                      userTools={h.userTools} cart={h.cart} submitting={h.submitting}
                      deliveryOption={h.deliveryOption} setDeliveryOption={h.setDeliveryOption}
                      addresses={h.addresses} selectedAddress={h.selectedAddress} setSelectedAddress={h.setSelectedAddress}
                      selectedTimeSlot={h.selectedTimeSlot} setSelectedTimeSlot={h.setSelectedTimeSlot}
                      showAddressOptions={h.showAddressOptions} setShowAddressOptions={h.setShowAddressOptions}
                      afiacaoPaymentMethod={h.afiacaoPaymentMethod} setAfiacaoPaymentMethod={h.setAfiacaoPaymentMethod}
                      onStaffAddTool={h.handleStaffAddTool} onAddService={h.addServiceToCart}
                      onRemoveFromCart={h.removeFromCart} onUpdateQuantity={h.updateQuantity}
                      onUpdateServiceServico={h.updateServiceServico} onUpdateServiceNotes={h.updateServiceNotes}
                      onUpdateServicePhotos={h.updateServicePhotos} onVoiceItemsIdentified={h.handleVoiceItemsIdentified}
                      getFilteredServicos={h.getFilteredServicos} getServicePrice={h.getServicePrice}
                      setAddToolDialogOpen={h.setAddToolDialogOpen}
                    />
                  </TabsContent>
                </Tabs>
              ) : (
                /* Customer: services only, no tabs */
                <ServiceItemForm
                  customerUserId={h.customerUserId} loadingTools={h.loadingTools} loadingServicos={h.loadingServicos}
                  creatingLocalProfile={h.creatingLocalProfile} serviceItems={h.serviceItems} availableTools={h.availableTools}
                  userTools={h.userTools} cart={h.cart} submitting={h.submitting}
                  deliveryOption={h.deliveryOption} setDeliveryOption={h.setDeliveryOption}
                  addresses={h.addresses} selectedAddress={h.selectedAddress} setSelectedAddress={h.setSelectedAddress}
                  selectedTimeSlot={h.selectedTimeSlot} setSelectedTimeSlot={h.setSelectedTimeSlot}
                  showAddressOptions={h.showAddressOptions} setShowAddressOptions={h.setShowAddressOptions}
                  afiacaoPaymentMethod={h.afiacaoPaymentMethod} setAfiacaoPaymentMethod={h.setAfiacaoPaymentMethod}
                  onStaffAddTool={h.handleStaffAddTool} onAddService={h.addServiceToCart}
                  onRemoveFromCart={h.removeFromCart} onUpdateQuantity={h.updateQuantity}
                  onUpdateServiceServico={h.updateServiceServico} onUpdateServiceNotes={h.updateServiceNotes}
                  onUpdateServicePhotos={h.updateServicePhotos} onVoiceItemsIdentified={h.handleVoiceItemsIdentified}
                  getFilteredServicos={h.getFilteredServicos} getServicePrice={h.getServicePrice}
                  setAddToolDialogOpen={h.setAddToolDialogOpen}
                />
              )}
            </>
          )}
        </div>

        <div className="space-y-4">
          <CartItemList
            cart={h.cart} obenProductItems={h.obenProductItems} colacorProductItems={h.colacorProductItems}
            serviceItems={h.serviceItems} obenSubtotal={h.obenSubtotal} colacorProdSubtotal={h.colacorProdSubtotal}
            serviceSubtotal={h.serviceSubtotal} totalEstimated={h.totalEstimated}
            deliveryOption={h.deliveryOption} selectedTimeSlot={h.selectedTimeSlot}
            onUpdateQuantity={h.updateQuantity} onUpdateProductPrice={h.updateProductPrice}
            onRemoveFromCart={h.removeFromCart} getServicePrice={h.getServicePrice}
            getCartIndex={(item) => h.cart.indexOf(item)}
          />

          {/* Cross-sell — staff only */}
          {!isCustomerMode && h.customerUserId && h.productItems.length > 0 && (
            <RecommendationsPanel customerId={h.customerUserId} basketProductIds={h.cartProductIds}
              onAddToCart={h.handleAddRecommendation} title="Combine com" compact maxItems={5} />
          )}

          {h.cart.length > 0 && h.selectedCustomer && (
            <CartSummaryBar
              cart={h.cart} obenProductItems={h.obenProductItems} colacorProductItems={h.colacorProductItems}
              serviceItems={h.serviceItems} totalEstimated={h.totalEstimated} submitting={h.submitting}
              vendedorDivergencias={h.vendedorDivergencias}
              sortedFormasPagamentoOben={isCustomerMode ? [] : h.sortedFormasPagamentoOben}
              sortedFormasPagamentoColacor={isCustomerMode ? [] : h.sortedFormasPagamentoColacor}
              selectedParcelaOben={h.selectedParcelaOben} setSelectedParcelaOben={h.setSelectedParcelaOben}
              selectedParcelaColacor={h.selectedParcelaColacor} setSelectedParcelaColacor={h.setSelectedParcelaColacor}
              loadingFormas={h.loadingFormas} customerParcelaRankingOben={h.customerParcelaRankingOben}
              customerParcelaRankingColacor={h.customerParcelaRankingColacor}
              notes={h.notes} setNotes={h.setNotes} onSubmit={h.submitOrder}
            />
          )}
        </div>
      </div>

      {h.customerUserId && (
        <AddToolDialog open={h.addToolDialogOpen} onOpenChange={h.setAddToolDialogOpen}
          categories={h.toolCategories} targetUserId={h.customerUserId}
          onToolAdded={() => h.loadUserTools(h.customerUserId!)} />
      )}
    </div>
  );
};

export default UnifiedOrder;
