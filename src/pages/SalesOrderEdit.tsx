import { TintColorSelectDialog } from '@/components/TintColorSelectDialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Loader2, Save, Plus, AlertCircle, X } from 'lucide-react';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { useSalesOrderEdit } from '@/components/salesOrderEdit/useSalesOrderEdit';
import { formatPrecoOuAusente } from '@/lib/format';
import { PaymentComboboxEdit } from '@/components/salesOrderEdit/PaymentComboboxEdit';
import { AvisoFormasPagamento } from '@/components/sales/AvisoFormasPagamento';
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
    formasDegradadas,
    formasErro,
    formasMotivo,
    condicaoDoPedidoAusente,
    parcelaTravada,
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
    precoPrevisto,
    handleTintConfirm,
    tintProductAsProduct,
    filteredProducts,
    subtotal,
    invalidPriceItemIndices,
    handleSave,
    isBlocked,
    motivoBloqueio,
    invalidQuantityItemIndices,
  } = useSalesOrderEdit();

  if (loading) {
    return (
      <div className="min-h-screen bg-background pb-24">
        <main className="pt-16 px-4 max-w-lg mx-auto">
          <PageSkeleton variant="form" />
        </main>
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
                {motivoBloqueio}
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
                precoPrevisto={precoPrevisto}
              />
            )}

            {items.map((item, index) => (
              <OrderItemCard
                // Chave pelo ITEM, não pela posição: o campo guarda o texto digitado, e com key={index}
                // remover um item fazia o seguinte herdar o rascunho do removido (Codex, 2026-11-25).
                key={`${item.omie_codigo_produto}-${item.tint_cor_id ?? ''}-${item.codigo ?? ''}`}
                item={item}
                index={index}
                isBlocked={isBlocked}
                isPriceInvalid={invalidPriceItemIndices.includes(index)}
                isQuantityInvalid={invalidQuantityItemIndices.includes(index)}
                onUpdate={updateItem}
                onRemove={removeItem}
              />
            ))}
          </CardContent>
        </Card>

        {/* Forma de Pagamento — o card aparece também quando a listagem degradou ou
            falhou, mesmo sem opções: sumir levaria o aviso junto e a tela diria, por
            omissão, que este pedido não tem condição de pagamento (§7). */}
        {(formas.length > 0 || formasDegradadas || formasErro) && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Forma de Pagamento</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {formas.length > 0 && (
                <PaymentComboboxEdit
                  formas={formas}
                  selected={selectedParcela}
                  onSelect={setSelectedParcela}
                  disabled={isBlocked || parcelaTravada}
                />
              )}
              <AvisoFormasPagamento
                degradado={formasDegradadas}
                erro={formasErro}
                motivo={formasMotivo}
                condicoesAusentes={condicaoDoPedidoAusente}
              />
              {parcelaTravada && (
                <p className="text-xs text-muted-foreground">
                  A condição atual do pedido ({selectedParcela}) foi mantida e vai íntegra ao
                  Omie. Recarregue a página quando o Omie voltar para poder alterá-la.
                </p>
              )}
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
              <span className="font-tabular">{/* Bloqueado = nada a recalcular: mostra o total GRAVADO (o importado traz o líquido, e a
                  soma das linhas sem `valor_total` não reconstrói o desconto). */}
              {formatPrecoOuAusente(isBlocked ? order.total : subtotal)}</span>
            </div>
          </CardContent>
        </Card>

        {/* Save Button */}
        {!isBlocked && (
          <Button
            onClick={handleSave}
            disabled={saving || items.length === 0 || invalidPriceItemIndices.length > 0 || invalidQuantityItemIndices.length > 0 || subtotal === null}
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
