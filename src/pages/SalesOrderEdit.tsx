import { TintColorSelectDialog } from '@/components/TintColorSelectDialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Loader2, Save, Plus, AlertCircle, X, RefreshCw } from 'lucide-react';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { useSalesOrderEdit } from '@/components/salesOrderEdit/useSalesOrderEdit';
import { formatPrecoOuAusente } from '@/lib/format';
import { PaymentComboboxEdit } from '@/components/salesOrderEdit/PaymentComboboxEdit';
import { AvisoFormasPagamento } from '@/components/sales/AvisoFormasPagamento';
import { AddProductSearch } from '@/components/salesOrderEdit/AddProductSearch';
import { mensagemDaFalhaDoPedido } from '@/components/salesOrderEdit/types';
import { OrderItemCard } from '@/components/salesOrderEdit/OrderItemCard';
import { useParams } from 'react-router-dom';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';

const EditorDoPedido = () => {
  const {
    order,
    customerName,
    items,
    notes,
    setNotes,
    loading,
    cargaDoPedido,
    recarregarPedido,
    estadoCatalogo,
    tentarCatalogoDeNovo,
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
    formularioTravado,
    precisaRecarregar,
    recarregar,
    temAlteracaoPendente,
    envioDeOutraTela,
    divergenciaDuravel,
    podeLiberarDivergencia,
    liberandoDivergencia,
    liberarDivergencia,
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
    // #40: só "não encontrado" quando o banco respondeu que a linha não existe. Falha de leitura é OUTRA
    // tela, com o motivo e "Tentar de novo" — antes as duas diziam "Pedido não encontrado".
    if (cargaDoPedido.estado === 'falhou') {
      return (
        <div className="min-h-screen bg-background pb-24">
          <div role="alert" className="flex flex-col items-center justify-center gap-3 pt-32 px-4 text-center">
            <AlertCircle className="h-6 w-6 text-status-error" />
            <p className="font-medium">Não consegui abrir o pedido</p>
            <p className="text-sm text-muted-foreground">
              {mensagemDaFalhaDoPedido(cargaDoPedido.erro, typeof navigator === 'undefined' || navigator.onLine)}
            </p>
            <Button variant="outline" size="sm" className="gap-2" onClick={() => { void recarregarPedido(); }}>
              <RefreshCw className="h-4 w-4" /> Tentar de novo
            </Button>
          </div>
        </div>
      );
    }
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

        {envioDeOutraTela && !precisaRecarregar && (
          <Card className="border-status-info" role="status">
            <CardContent className="p-4 flex items-center gap-2 text-status-info">
              <Loader2 className="w-5 h-5 animate-spin shrink-0" />
              <p className="text-sm font-medium">
                Um salvamento deste pedido ainda está em andamento. Aguarde terminar para editar.
              </p>
            </CardContent>
          </Card>
        )}

        {precisaRecarregar && (
          <Card className="border-status-warning" role="alert">
            <CardContent className="p-4 space-y-3">
              <div className="flex items-start gap-2 text-status-warning">
                <AlertCircle className="w-5 h-5 shrink-0" />
                <p className="text-sm font-medium">{precisaRecarregar.mensagem}</p>
              </div>
              {precisaRecarregar.tipo === 'concorrente' && (
                <Button variant="outline" className="w-full gap-2" onClick={() => { void recarregar(); }}>
                  <RefreshCw className="w-4 h-4" />
                  Recarregar pedido
                </Button>
              )}
              {precisaRecarregar.tipo === 'divergente' && divergenciaDuravel && (
                <>
                  {divergenciaDuravel.motivo && (
                    <p className="text-xs text-muted-foreground">Último erro registrado: {divergenciaDuravel.motivo}</p>
                  )}
                  {podeLiberarDivergencia ? (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="outline" className="w-full" disabled={liberandoDivergencia}>
                          {liberandoDivergencia ? 'Liberando…' : 'Já conferi no Omie — liberar edição'}
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Liberar a edição deste pedido?</AlertDialogTitle>
                          <AlertDialogDescription>
                            A tela vai mostrar o pedido como está registrado NO APP, que pode ser a versão de antes
                            da edição que falhou. Se o Omie ficou diferente, salvar daqui sobrescreve o Omie com o
                            que estiver na tela. Libere só depois de conferir o pedido no Omie.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancelar</AlertDialogCancel>
                          <AlertDialogAction onClick={() => { void liberarDivergencia(); }}>
                            Conferi — liberar
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Depois de conferir no Omie, peça a um gestor (master) para liberar a edição deste pedido.
                    </p>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        )}

        {/* Items */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center justify-between">
              <span>Itens do Pedido</span>
              {!formularioTravado && (
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
            {showAddProduct && !formularioTravado && (
              <AddProductSearch
                productSearch={productSearch}
                setProductSearch={setProductSearch}
                filteredProducts={filteredProducts}
                onAddProduct={addProduct}
                precoPrevisto={precoPrevisto}
                estadoCatalogo={estadoCatalogo}
                onTentarDeNovo={() => { void tentarCatalogoDeNovo(); }}
              />
            )}

            {items.map((item, index) => (
              <OrderItemCard
                // Chave pelo ITEM, não pela posição: o campo guarda o texto digitado, e com key={index}
                // remover um item fazia o seguinte herdar o rascunho do removido (Codex, 2026-11-25).
                key={`${item.omie_codigo_produto}-${item.tint_cor_id ?? ''}-${item.codigo ?? ''}`}
                item={item}
                index={index}
                isBlocked={formularioTravado}
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
        {(formas.length > 0 || formasDegradadas || formasErro || selectedParcela) && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Forma de Pagamento</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {/* Com a lista vazia (falhou/degradou), a condição SALVA continua visível (revisão /sales #29). */}
              {(formas.length > 0 || selectedParcela) && (
                <PaymentComboboxEdit
                  formas={formas}
                  selected={selectedParcela}
                  onSelect={setSelectedParcela}
                  disabled={formularioTravado || parcelaTravada || formas.length === 0}
                  listaCompleta={formas.length > 0 && !formasDegradadas && !formasErro}
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
                  A condição de pagamento não pode ser trocada agora: ao salvar, o pedido mantém a
                  condição que está no Omie. Recarregue a página quando o Omie voltar para poder alterá-la.
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
              disabled={formularioTravado}
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
        {!isBlocked && temAlteracaoPendente && !saving && !precisaRecarregar && (
          <p className="text-xs text-muted-foreground text-center" aria-live="polite">
            Alterações ainda não salvas.
          </p>
        )}
        {!isBlocked && (
          <Button
            onClick={handleSave}
            disabled={formularioTravado || items.length === 0 || invalidPriceItemIndices.length > 0 || invalidQuantityItemIndices.length > 0 || subtotal === null}
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

/**
 * Uma instância por pedido (`key={id}`): trocar de `:id` na mesma rota remonta o editor, e a resposta atrasada
 * do salvar do pedido anterior não tem como escrever no estado, no toast ou na navegação do pedido aberto
 * agora (revisão /sales #15/#30, Codex 2026-11-26).
 */
const SalesOrderEdit = () => {
  const { id } = useParams<{ id: string }>();
  return <EditorDoPedido key={id ?? ''} />;
};

export default SalesOrderEdit;
