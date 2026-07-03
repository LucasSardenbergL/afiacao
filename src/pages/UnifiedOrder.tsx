import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Loader2, CheckCircle, Building2, Scissors, Wifi } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { track } from '@/lib/analytics';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { RecommendationsPanel } from '@/components/RecommendationsPanel';
import { AddToolDialog } from '@/components/AddToolDialog';
import { UnifiedAIAssistant } from '@/components/UnifiedAIAssistant';
import { TintColorSelectDialog } from '@/components/TintColorSelectDialog';
import { OrderSuccessDialog } from '@/components/OrderSuccessDialog';
import { cn } from '@/lib/utils';
import { useUnifiedOrder } from '@/hooks/useUnifiedOrder';
import { useOrderDeepLink } from '@/hooks/useOrderDeepLink';
import { useOrderDraft } from '@/hooks/useOrderDraft';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { useNetworkStatus } from '@/hooks/useNetworkStatus';
import { useOfflineSubmit } from '@/hooks/useOfflineSubmit';
import { RestoreDraftDialog } from '@/components/unified-order/RestoreDraftDialog';
import { CustomerSearch } from '@/components/unified-order/CustomerSearch';
import { AlertaCreditoCliente } from '@/components/unified-order/AlertaCreditoCliente';
import { CoresDoClienteCard } from '@/components/unified-order/CoresDoClienteCard';
import { useCoresDoCliente } from '@/hooks/unifiedOrder/useCoresDoCliente';
import type { CorDoCliente, OcorrenciaCor } from '@/lib/tint/cores-do-cliente';
import { termoBuscaCor } from '@/lib/tint/cores-do-cliente';
import { montarPlanoReplicacao, type ItemTinta } from '@/lib/pedido/replicar-pedido';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { ProductItemForm } from '@/components/unified-order/ProductItemForm';
import { useCurrentSpecsMap } from '@/hooks/useProductSpecLink';
import { useCatalisadorLinksMap } from '@/hooks/useCatalisadorLink';
import { keyDeSku } from '@/lib/knowledge-base/spec-link';
import { montarSelosVendaAssistida } from '@/lib/venda-assistida/selos';
import type { ProdutoLinhaOmie } from '@/lib/venda-assistida/montar-embalagens';
import { ServiceItemForm } from '@/components/unified-order/ServiceItemForm';
import { CartItemList } from '@/components/unified-order/CartItemList';
import { CartSummaryBar } from '@/components/unified-order/CartSummaryBar';
import { shareOrderViaWhatsApp } from '@/utils/whatsappShare';

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
  const { user } = useAuth();
  // Fichas técnicas (boletim↔SKU): mapa pequeno (só vínculos confirmados+aprovados), 1 query.
  const { byKey: fichasByKey } = useCurrentSpecsMap();
  // Casamento do catalisador (Fatia 3): mapa global keyDeCatalisador → SKUs (destrava preço catalisado).
  const { byKey: catalisadorByKey } = useCatalisadorLinksMap();
  // Venda assistida: selo "preparado" por produto. Resolve estado+preço de cada boletim reusando o
  // catálogo JÁ carregado (zero query nova) e espalha por SKU. Vendedor-only.
  const selosByKey = useMemo(() => {
    const catalogByKey = new Map<string, ProdutoLinhaOmie>();
    for (const p of [...h.obenProducts, ...h.colacorProducts]) {
      catalogByKey.set(keyDeSku(p.account, p.omie_codigo_produto), {
        omie_codigo_produto: p.omie_codigo_produto,
        descricao: p.descricao,
        valor_unitario: p.valor_unitario,
        estoque: p.estoque ?? 0,
      });
    }
    // Preço-do-cliente (último praticado) POR CONTA — omie_codigo_produto colide entre Oben/Colacor,
    // então o helper lê do mapa da conta de cada SKU (não achata num Record só).
    const customerPricesByAccount = { oben: h.customerPricesOben, colacor: h.customerPricesColacor };
    return montarSelosVendaAssistida([...fichasByKey.values()], catalogByKey, customerPricesByAccount, catalisadorByKey);
  }, [fichasByKey, catalisadorByKey, h.obenProducts, h.colacorProducts, h.customerPricesOben, h.customerPricesColacor]);
  const [restoreOpen, setRestoreOpen] = useState(false);

  // "Cores do cliente": histórico de cores + pré-preenchimento do dialog de tingir.
  const coresDoCliente = useCoresDoCliente(h.customerUserId);
  const [tintInitialSearch, setTintInitialSearch] = useState<string | null>(null);
  const handleRepetirCor = (cor: CorDoCliente, oc: OcorrenciaCor) => {
    const pool = oc.account === 'colacor' ? h.colacorProducts : h.obenProducts;
    const product =
      oc.omieCodigoProduto != null
        ? pool.find((p) => p.omie_codigo_produto === oc.omieCodigoProduto)
        : undefined;
    if (product?.is_tintometric && product.tint_type === 'base') {
      track('pedido.repetir_cor');
      // Busca pelo CÓDIGO da cor, não pelo rótulo cru do histórico ("346J -
      // PLATINA BIANCA 900ML") — o rótulo não casa com cor_id/nome_cor do catálogo.
      setTintInitialSearch(termoBuscaCor(cor.nome));
      h.setTintPendingProduct(product);
      return;
    }
    // Degradação honesta: base fora do catálogo (inativa/outro painel) ou sem
    // fluxo de cor → pré-preenche a busca de produtos pra ela seguir manualmente.
    h.setProductSearch(oc.baseDescricao);
    if (oc.account === 'oben' || oc.account === 'colacor') h.setActiveTab(oc.account);
    toast.info('Base fora do fluxo automático de cor', {
      description: 'Pré-preenchi a busca de produtos com a base daquele pedido — adicione manualmente.',
    });
  };

  const [searchParams] = useSearchParams();
  const preselectCustomerId = searchParams.get('customer');
  const preselectedRef = useRef(false);

  // returnTo da fila (G1 Fase 3): só path interno (guard anti-open-redirect, vem da URL).
  const returnToRaw = searchParams.get('returnTo');
  const returnTo = returnToRaw && returnToRaw.startsWith('/') && !returnToRaw.startsWith('//') ? returnToRaw : null;

  /* ─── "Repetir pedido" (?repeat=<sales_order_id>) ───
   * One-shot após cliente + catálogo prontos (padrão do deep-link): busca o
   * pedido antigo, monta o plano (helper puro) e aplica — itens comuns entram
   * direto (qtd antiga, PREÇO ATUAL do cliente); bases tintométricas entram
   * numa fila que abre o dialog de cor um a um (humano confirma cada tinta). */
  const repeatId = searchParams.get('repeat');
  const repeatHandled = useRef(false);
  const [tintQueue, setTintQueue] = useState<ItemTinta[]>([]);

  useEffect(() => {
    if (
      preselectCustomerId &&
      h.isStaff &&
      !h.selectedCustomer &&
      !preselectedRef.current
    ) {
      preselectedRef.current = true;
      void h.selectCustomerByUserId(preselectCustomerId);
    }
  }, [preselectCustomerId, h.isStaff, h.selectedCustomer, h.selectCustomerByUserId]);

  // Aplica a replicação quando tudo está pronto (cliente + catálogo da conta do pedido).
  useEffect(() => {
    if (!repeatId || repeatHandled.current || !h.isStaff || !h.selectedCustomer || !h.customerUserId) return;
    // Catálogo ainda carregando → espera (senão todo item cairia em "fora do catálogo").
    if (h.loadingObenProducts || h.loadingColacorProducts) return;
    repeatHandled.current = true;
    void (async () => {
      const { data: pedido, error } = await supabase
        .from('sales_orders')
        .select('id, account, items, omie_numero_pedido, customer_user_id')
        .eq('id', repeatId)
        .maybeSingle();
      if (error || !pedido) {
        toast.error('Não consegui carregar o pedido pra repetir.');
        return;
      }
      if (pedido.customer_user_id !== h.customerUserId) {
        toast.error('O pedido a repetir é de outro cliente.');
        return;
      }
      const catalogo = pedido.account === 'colacor' ? h.colacorProducts : h.obenProducts;
      const plano = montarPlanoReplicacao(pedido.items, catalogo);
      for (const d of plano.diretos) h.addProductToCart(d.product, d.quantidade);
      if (plano.tintas.length > 0) setTintQueue(plano.tintas);
      track('pedido.repetir_pedido');
      const pv = (pedido.omie_numero_pedido ?? '').replace(/^0+/, '');
      const partes = [
        plano.diretos.length > 0 ? `${plano.diretos.length} no carrinho` : null,
        plano.tintas.length > 0 ? `${plano.tintas.length} de tinta pra confirmar a cor` : null,
        plano.foraDoCatalogo.length > 0 ? `${plano.foraDoCatalogo.length} fora do catálogo` : null,
      ].filter(Boolean);
      if (partes.length === 0) {
        toast.info(`Pedido${pv ? ` ${pv}` : ''} sem itens replicáveis.`);
      } else {
        toast.success(`Pedido${pv ? ` ${pv}` : ''} replicado: ${partes.join(' · ')}`, {
          description: plano.foraDoCatalogo.length > 0 ? `Fora do catálogo: ${plano.foraDoCatalogo.join('; ')}` : undefined,
        });
      }
    })();
    // h é objeto novo a cada render; deps nos campos usados.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repeatId, h.isStaff, h.selectedCustomer, h.customerUserId, h.obenProducts, h.colacorProducts, h.loadingObenProducts, h.loadingColacorProducts]);

  // Fila de tintas da replicação: abre o dialog de cor um a um (o próximo
  // entra quando o atual fecha — confirmado OU cancelado, que é "pular").
  useEffect(() => {
    if (h.tintPendingProduct || tintQueue.length === 0) return;
    const [proxima, ...resto] = tintQueue;
    setTintQueue(resto);
    // Mesmo motivo do "Pedir de novo": pré-busca pelo código, não pelo rótulo cru.
    setTintInitialSearch(proxima.nomeCor ? termoBuscaCor(proxima.nomeCor) : null);
    h.setTintPendingProduct(proxima.product);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [h.tintPendingProduct, tintQueue]);

  useOrderDeepLink({
    selectedCustomer: h.selectedCustomer,
    addProductToCart: h.addProductToCart,
    obenProducts: h.obenProducts,
    colacorProducts: h.colacorProducts,
    loadingObenProducts: h.loadingObenProducts,
    loadingColacorProducts: h.loadingColacorProducts,
    loadingCustomer: h.loadingCustomer,
  });

  // ─── Auto-save de rascunho ───
  // Salva snapshot enquanto vendedor digita; mostra dialog para restaurar se voltar à tela com cart vazio.
  // Limpa após pedido enviado com sucesso (orderSuccessOpen = true).
  const draftScope = user?.id ?? 'anon';
  const draftPayload = useMemo(
    () => ({
      cart: h.cart,
      customerCodigoCliente: h.selectedCustomer?.codigo_cliente ?? null,
      customerName: h.selectedCustomer?.razao_social ?? null,
      notes: h.notes,
      ordemCompra: h.ordemCompra,
    }),
    [h.cart, h.selectedCustomer, h.notes, h.ordemCompra],
  );
  const { draft, clear: clearDraft, dismiss: dismissDraft } = useOrderDraft({
    scopeKey: draftScope,
    state: draftPayload,
    shouldSave: h.cart.length > 0,
    clearTrigger: h.orderSuccessOpen, // limpa quando o success dialog abrir = pedido enviado
  });

  // Gate offline-first do envio: offline salva rascunho (já auto-salvo acima) e expõe
  // CTA de reconexão; nunca enfileira (submitOrder cria PV cobrado no Omie).
  const net = useNetworkStatus();
  const offlineSubmit = useOfflineSubmit({
    submit: h.submitOrder,
    online: net.online,
    hasContent: h.cart.length > 0,
  });

  // Oferece restore se houver draft pendente E o cart atual estiver vazio (entrou novo na tela).
  useEffect(() => {
    if (draft && h.cart.length === 0 && !restoreOpen) {
      setRestoreOpen(true);
    }
  }, [draft, h.cart.length, restoreOpen]);

  // Telemetria: pedido enviado com sucesso (dispara uma vez ao abrir o success dialog)
  useEffect(() => {
    if (h.orderSuccessOpen && h.lastOrderData) {
      track('pedido.criado', {
        modo: isCustomerMode ? 'customer' : 'staff',
        num_itens: h.lastOrderData.items?.length ?? 0,
        valor_total: h.lastOrderData.total ?? 0,
        num_pedidos: h.lastOrderData.orderNumbers?.length ?? 0,
      });
    }
  }, [h.orderSuccessOpen, h.lastOrderData, isCustomerMode]);

  const handleRestore = () => {
    if (!draft) return;
    const { state } = draft;
    if (Array.isArray(state.cart)) h.setCart(state.cart);
    if (typeof state.notes === 'string') h.setNotes(state.notes);
    if (typeof state.ordemCompra === 'string') h.setOrdemCompra(state.ordemCompra);
    setRestoreOpen(false);
    // Não limpa o draft — ele será reescrito naturalmente conforme o vendedor edita.
  };

  const handleDiscardDraft = () => {
    clearDraft();
    dismissDraft();
    setRestoreOpen(false);
  };

  if (h.authLoading) {
    return <div className="flex items-center justify-center py-32"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>;
  }

  /* ─── Derived flags to keep UI clean ─── */
  const showCustomerSearch = !isCustomerMode;
  const showProductTabs = !isCustomerMode;
  const showAIAssistant = !isCustomerMode;
  const customerReady = !!h.selectedCustomer;

  return (
    <div className="max-w-5xl mx-auto space-y-4 pb-6">
      <div className="flex items-center gap-3">
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

      {offlineSubmit.showReconnectCta && (
        <div className="rounded-md border border-status-info-bold/30 bg-status-info-bg px-4 py-3 mb-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm text-status-info-bold">
            <Wifi className="w-4 h-4 shrink-0" />
            Conexão restabelecida. Seu pedido está salvo como rascunho.
          </div>
          <Button size="sm" onClick={offlineSubmit.onReconnectSubmit} disabled={h.submitting} className="shrink-0">
            Enviar pedido agora
          </Button>
        </div>
      )}

      <div className={cn('grid gap-4', showProductTabs ? 'grid-cols-1 lg:grid-cols-3' : 'grid-cols-1 lg:grid-cols-3')}>
        <div className={cn(showProductTabs ? 'lg:col-span-2' : 'lg:col-span-2', 'space-y-4')}>
          {/* AI Assistant — staff only */}
          {showAIAssistant && (
            <UnifiedAIAssistant
              products={[...h.obenProducts, ...h.colacorProducts] as unknown as { id: string; codigo: string; descricao: string; valor_unitario: number; estoque: number; account?: string }[]}
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

          {/* Alerta de crédito (Fase 1 — informativo, não bloqueia) */}
          {showCustomerSearch && h.selectedCustomer && (
            <AlertaCreditoCliente cliente={h.selectedCustomer} />
          )}

          {/* Cores já pedidas pelo cliente — busca + re-pedido (staff) */}
          {showCustomerSearch && customerReady && (
            <CoresDoClienteCard
              cores={coresDoCliente.cores}
              coresFiltradas={coresDoCliente.coresFiltradas}
              busca={coresDoCliente.busca}
              onBuscaChange={coresDoCliente.setBusca}
              isLoading={coresDoCliente.isLoading}
              onRepetirCor={handleRepetirCor}
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
                      productItems={h.productItems} onAddProduct={h.addProductToCart}
                      customerPurchaseHistory={h.customerPurchaseHistory} customerPricesLoading={h.loadingCustomer}
                      specsByKey={fichasByKey} canSeeFicha={h.isStaff}
                      selosByKey={selosByKey} canSeeVendaAssistida={h.isStaff} />
                  </TabsContent>
                  <TabsContent value="colacor">
                    <ProductItemForm title="Produtos Colacor" products={h.filteredColacorProducts} prices={h.customerPricesColacor}
                      loading={h.loadingColacorProducts} productSearch={h.productSearch} onSearchChange={h.setProductSearch}
                      productItems={h.productItems} onAddProduct={h.addProductToCart}
                      customerPurchaseHistory={h.customerPurchaseHistory} customerPricesLoading={h.loadingCustomer}
                      specsByKey={fichasByKey} canSeeFicha={h.isStaff}
                      selosByKey={selosByKey} canSeeVendaAssistida={h.isStaff} />
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
          {/* Cross-sell — staff only */}
          {!isCustomerMode && h.customerUserId && h.productItems.length > 0 && (
            <RecommendationsPanel customerId={h.customerUserId} basketProductIds={h.cartProductIds}
              onAddToCart={h.handleAddRecommendation} title="Combine com" compact maxItems={5} />
          )}

          <CartItemList
            cart={h.cart} obenProductItems={h.obenProductItems} colacorProductItems={h.colacorProductItems}
            serviceItems={h.serviceItems} obenSubtotal={h.obenSubtotal} colacorProdSubtotal={h.colacorProdSubtotal}
            serviceSubtotal={h.serviceSubtotal} totalEstimated={h.totalEstimated}
            deliveryOption={h.deliveryOption} selectedTimeSlot={h.selectedTimeSlot}
            onUpdateQuantity={h.updateQuantity} onUpdateProductPrice={h.updateProductPrice}
            onRemoveFromCart={h.removeFromCart} getServicePrice={h.getServicePrice}
            getCartIndex={(item) => h.cart.indexOf(item)}
            customerUserId={h.customerUserId}
            customerName={h.selectedCustomer?.razao_social ?? null}
          />

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
              notes={h.notes} setNotes={h.setNotes}
               volumesOben={h.volumesOben}
               volumesColacor={h.volumesColacor}
              ordemCompra={h.ordemCompra} setOrdemCompra={h.setOrdemCompra}
              isOrdemCompraCustomer={h.isOrdemCompraCustomer}
              readyByDate={h.readyByDate} setReadyByDate={h.setReadyByDate}
              onSubmit={offlineSubmit.onSubmit}
              onSubmitQuote={h.submitQuote}
              offline={offlineSubmit.offline}
            />
          )}
        </div>
      </div>

      {h.customerUserId && (
        <AddToolDialog open={h.addToolDialogOpen} onOpenChange={h.setAddToolDialogOpen}
          categories={h.toolCategories} targetUserId={h.customerUserId}
          onToolAdded={() => h.loadUserTools(h.customerUserId!)} />
      )}

      {h.lastOrderData && (
        <OrderSuccessDialog
          open={h.orderSuccessOpen}
          onOpenChange={h.setOrderSuccessOpen}
          customerName={h.lastOrderData.customerName}
          items={h.lastOrderData.items}
          total={h.lastOrderData.total}
          orderNumbers={h.lastOrderData.orderNumbers}
          printDataList={h.lastOrderData.printDataList}
          onViewOrder={() => {
            h.setOrderSuccessOpen(false);
            h.navigate('/sales');
          }}
          onShare={() => {
            shareOrderViaWhatsApp({
              customerName: h.lastOrderData!.customerName,
              items: h.lastOrderData!.items,
              total: h.lastOrderData!.total,
              orderNumbers: h.lastOrderData!.orderNumbers,
            });
          }}
          returnTo={returnTo}
          onVoltarFila={() => { h.setOrderSuccessOpen(false); if (returnTo) h.navigate(returnTo); }}
        />
      )}

      {draft && (
        <RestoreDraftDialog
          open={restoreOpen}
          savedAt={draft.savedAt}
          customerName={draft.state.customerName ?? undefined}
          itemCount={Array.isArray(draft.state.cart) ? draft.state.cart.length : 0}
          onRestore={handleRestore}
          onDiscard={handleDiscardDraft}
        />
      )}

      {h.tintPendingProduct && (
        <TintColorSelectDialog
          product={h.tintPendingProduct}
          open={!!h.tintPendingProduct}
          onClose={() => { h.setTintPendingProduct(null); setTintInitialSearch(null); }}
          customerUserId={h.customerUserId}
          initialSearch={tintInitialSearch}
          onConfirm={(formulaId, corId, nomeCor, precoFinal, custoCorantes, alternativeProduct) => {
            h.addTintProductToCart(alternativeProduct || h.tintPendingProduct!, formulaId, corId, nomeCor, precoFinal, custoCorantes);
            setTintInitialSearch(null);
          }}
        />
      )}
    </div>
  );
};

export default UnifiedOrder;
