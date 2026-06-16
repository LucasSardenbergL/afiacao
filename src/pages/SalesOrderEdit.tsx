import { TintColorSelectDialog } from '@/components/TintColorSelectDialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Loader2, Save, Plus, AlertCircle, X } from 'lucide-react';
import { useSalesOrderEdit } from '@/components/salesOrderEdit/useSalesOrderEdit';
import { PaymentComboboxEdit } from '@/components/salesOrderEdit/PaymentComboboxEdit';
import { AddProductSearch } from '@/components/salesOrderEdit/AddProductSearch';
import { OrderItemCard } from '@/components/salesOrderEdit/OrderItemCard';

const SalesOrderEdit = () => {
  const {
    order,
    customerName,
    items,
    notes,
    setNotes,
    loading,
    saving,
    formas,
    selectedParcela,
    setSelectedParcela,
    showAddProduct,
    setShowAddProduct,
    productSearch,
    setProductSearch,
    tintPendingProduct,
    setTintPendingProduct,
    customerUserId,
    updateItem,
    removeItem,
    addProduct,
    handleTintConfirm,
    tintProductAsProduct,
    filteredProducts,
    subtotal,
    invalidPriceItemIndices,
    handleSave,
    isBlocked,
  } = useSalesOrderEdit();

  if (loading) {
    return (
      <div className="min-h-screen bg-background pb-24">
        <div className="flex items-center justify-center pt-32">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      </div>
    );
  }

  if (!order) {
    return (
      <div className="min-h-screen bg-background pb-24">
        <div className="flex items-center justify-center pt-32">
          <p className="text-muted-foreground">Pedido não encontrado</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-32">

      <main className="pt-16 px-4 max-w-lg mx-auto space-y-4">
        {/* Order Info */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center justify-between">
              <span>📦 {customerName || 'Cliente'}</span>
              <Badge variant="outline">{order.account === 'colacor' ? 'Colacor' : 'Oben'}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground space-y-1">
            {order.omie_numero_pedido && <p>PV: {order.omie_numero_pedido.replace(/^0+/, '') || '0'}</p>}
            <p>Status: {order.status}</p>
          </CardContent>
        </Card>

        {isBlocked && (
          <Card className="border-destructive">
            <CardContent className="p-4 flex items-center gap-2 text-destructive">
              <AlertCircle className="w-5 h-5" />
              <p className="text-sm font-medium">
                Este pedido está com status "{order.status}" e não pode ser editado.
              </p>
            </CardContent>
          </Card>
        )}

        {/* Items */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center justify-between">
              <span>Itens do Pedido</span>
              {!isBlocked && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1 text-xs"
                  onClick={() => setShowAddProduct(!showAddProduct)}
                >
                  {showAddProduct ? <X className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
                  {showAddProduct ? 'Fechar' : 'Adicionar'}
                </Button>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Add product search */}
            {showAddProduct && !isBlocked && (
              <AddProductSearch
                productSearch={productSearch}
                setProductSearch={setProductSearch}
                filteredProducts={filteredProducts}
                onAddProduct={addProduct}
              />
            )}

            {items.map((item, index) => (
              <OrderItemCard
                key={index}
                item={item}
                index={index}
                isBlocked={isBlocked}
                isPriceInvalid={invalidPriceItemIndices.includes(index)}
                onUpdate={updateItem}
                onRemove={removeItem}
              />
            ))}
          </CardContent>
        </Card>

        {/* Forma de Pagamento */}
        {formas.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Forma de Pagamento</CardTitle>
            </CardHeader>
            <CardContent>
              <PaymentComboboxEdit
                formas={formas}
                selected={selectedParcela}
                onSelect={setSelectedParcela}
                disabled={isBlocked}
              />
            </CardContent>
          </Card>
        )}

        {/* Notes */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Observações</CardTitle>
          </CardHeader>
          <CardContent>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={isBlocked}
              rows={3}
              placeholder="Observações do pedido..."
            />
          </CardContent>
        </Card>

        {/* Financial Summary */}
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between text-lg font-bold">
              <span>Total</span>
              <span>R$ {subtotal.toFixed(2)}</span>
            </div>
          </CardContent>
        </Card>

        {/* Save Button */}
        {!isBlocked && (
          <Button
            onClick={handleSave}
            disabled={saving || items.length === 0 || invalidPriceItemIndices.length > 0}
            className="w-full gap-2"
            size="lg"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {order.omie_pedido_id ? 'Salvar e Alterar no Omie' : 'Salvar Alterações'}
          </Button>
        )}
      </main>


      {/* Tint Color Dialog */}
      {tintProductAsProduct && (
        <TintColorSelectDialog
          product={tintProductAsProduct}
          open={!!tintPendingProduct}
          onClose={() => setTintPendingProduct(null)}
          onConfirm={handleTintConfirm}
          customerUserId={customerUserId}
        />
      )}
    </div>
  );
};

export default SalesOrderEdit;
