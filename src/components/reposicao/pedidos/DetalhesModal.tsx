import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertTriangle, Loader2, Trash2 } from 'lucide-react';
import { PedidoSugerido } from './types';
import { formatBRL, formatTime } from './shared';
import { StatusBadge, SplitInfo } from './badges';
import { useDetalhesModal } from './useDetalhesModal';
import { PortalStatusPanel } from './PortalStatusPanel';
import { HistoricoAcoesPanel } from './HistoricoAcoesPanel';
import { CondicaoPagamentoPanel } from './CondicaoPagamentoPanel';
import { ItensTable } from './ItensTable';
import { EmbalagemPanel } from './EmbalagemPanel';
import { RemoverItemDialog, DescontinuarItemDialog, RemoverItensLoteDialog } from './ConfirmacaoDialogs';

/* ─── Detalhes Modal ─── */
export function DetalhesModal({
  pedido,
  open,
  onOpenChange,
  onApproved,
}: {
  pedido: PedidoSugerido | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onApproved: () => void;
}) {
  const {
    condicoes,
    isLoading,
    edits,
    onEditQty,
    precoEdits,
    onEditPreco,
    obs,
    setObs,
    condicaoCodigo,
    setCondicaoCodigo,
    removerItem,
    setRemoverItem,
    descontinuarItem,
    setDescontinuarItem,
    linhas,
    totalAtual,
    condicaoSelecionada,
    condicaoMudou,
    salvarMutation,
    salvarCondicaoMutation,
    aprovarMutation,
    removerItemMutation,
    descontinuarMutation,
    podeEditar,
    podeEditarCondicao,
    podeEditarPreco,
    selecionados,
    toggleSelecionado,
    toggleTodos,
    linhasSelecionadas,
    confirmarRemocaoLote,
    setConfirmarRemocaoLote,
    removerLoteMutation,
  } = useDetalhesModal({ pedido, open, onOpenChange, onApproved });

  if (!pedido) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-7xl xl:max-w-screen-2xl w-[95vw] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3 flex-wrap">
            Pedido #{pedido.id} — {pedido.fornecedor_nome}
            <StatusBadge status={pedido.status} />
            <SplitInfo pedido={pedido} />
          </DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <div><div className="text-muted-foreground">Grupo</div><div className="font-medium">{pedido.grupo_codigo ?? '—'}</div></div>
          <div><div className="text-muted-foreground">Nº SKUs</div><div className="font-medium">{pedido.num_skus}</div></div>
          <div><div className="text-muted-foreground">Valor total</div><div className="font-medium">{formatBRL(totalAtual || pedido.valor_total)}</div></div>
          <div><div className="text-muted-foreground">Horário corte</div><div className="font-medium">{formatTime(pedido.horario_corte_planejado)}</div></div>
        </div>

        {/* Condição de pagamento Omie (obrigatório p/ disparo) */}
        <CondicaoPagamentoPanel
          pedido={pedido}
          podeEditarCondicao={podeEditarCondicao}
          condicaoCodigo={condicaoCodigo}
          onCondicaoChange={setCondicaoCodigo}
          condicoes={condicoes}
          condicaoSelecionada={condicaoSelecionada}
          condicaoMudou={condicaoMudou}
          salvarCondicaoPending={salvarCondicaoMutation.isPending}
          onSalvarCondicao={() => salvarCondicaoMutation.mutate()}
        />

        {pedido.status === 'bloqueado_guardrail' && pedido.mensagem_bloqueio && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Bloqueado por guardrail</AlertTitle>
            <AlertDescription>Motivo: {pedido.mensagem_bloqueio}</AlertDescription>
          </Alert>
        )}

        {pedido.status === 'falha_envio' && pedido.resposta_canal?.erro && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Falha no disparo</AlertTitle>
            <AlertDescription className="whitespace-pre-wrap break-words">
              {pedido.resposta_canal.erro}
            </AlertDescription>
          </Alert>
        )}

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {linhas.some((l) => l.inativo_no_omie) && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>
                  {linhas.filter((l) => l.inativo_no_omie).length}{' '}
                  {linhas.filter((l) => l.inativo_no_omie).length === 1 ? 'item inativado' : 'itens inativados'} no Omie
                </AlertTitle>
                <AlertDescription>
                  Produto(s) desativado(s) no Omie após a geração do pedido. O disparo será
                  bloqueado — reative no Omie e sincronize, ou remova o(s) item(ns) antes de aprovar.
                </AlertDescription>
              </Alert>
            )}
            {podeEditar && linhasSelecionadas.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-status-warning/40 bg-status-warning/5 px-3 py-2 text-sm">
                <span>
                  <strong>{linhasSelecionadas.length}</strong>{' '}
                  {linhasSelecionadas.length === 1 ? 'item selecionado' : 'itens selecionados'} —{' '}
                  {formatBRL(linhasSelecionadas.reduce((acc, l) => acc + l._valor, 0))}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setConfirmarRemocaoLote(true)}
                  disabled={removerLoteMutation.isPending}
                >
                  <Trash2 className="w-4 h-4 mr-1" />
                  Remover selecionados
                </Button>
              </div>
            )}
            <ItensTable
              linhas={linhas}
              podeEditar={podeEditar}
              totalAtual={totalAtual}
              onEditQty={onEditQty}
              podeEditarPreco={podeEditarPreco}
              onEditPreco={onEditPreco}
              onRemover={(l) => setRemoverItem(l)}
              onDescontinuar={(l) => setDescontinuarItem(l)}
              removerPending={removerItemMutation.isPending}
              descontinuarPending={descontinuarMutation.isPending}
              selecionados={selecionados}
              onToggleSelecionado={toggleSelecionado}
              onToggleTodos={toggleTodos}
            />
          </>
        )}

        {!isLoading && <EmbalagemPanel empresa={pedido.empresa} itens={linhas} />}

        {/* Status de envio ao portal + Histórico de ações */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <PortalStatusPanel pedido={pedido} />
          <HistoricoAcoesPanel pedido={pedido} />
        </div>


        {podeEditar && (
          <div>
            <label className="text-sm text-muted-foreground mb-1 block">Observações internas (opcional)</label>
            <Textarea value={obs} onChange={(e) => setObs(e.target.value)} placeholder="Notas sobre os ajustes..." />
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Fechar</Button>
          {(podeEditar || podeEditarPreco) && (
            <Button
              variant="secondary"
              disabled={(Object.keys(edits).length === 0 && Object.keys(precoEdits).length === 0) || salvarMutation.isPending}
              onClick={() => salvarMutation.mutate()}
            >
              {salvarMutation.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
              Salvar ajustes
            </Button>
          )}
          {podeEditar && (
            <Button
              disabled={aprovarMutation.isPending || !condicaoSelecionada}
              onClick={() => aprovarMutation.mutate()}
              title={!condicaoSelecionada ? 'Selecione a condição de pagamento antes de aprovar' : ''}
            >
              {aprovarMutation.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
              ✓ Aprovar e disparar agora
            </Button>
          )}
        </DialogFooter>
      </DialogContent>

      {/* Confirmação: remover linha */}
      <RemoverItemDialog
        item={removerItem}
        onOpenChange={() => setRemoverItem(null)}
        pending={removerItemMutation.isPending}
        onConfirm={() => removerItem && removerItemMutation.mutate(removerItem.id)}
      />

      {/* Confirmação: remover + descontinuar */}
      <DescontinuarItemDialog
        item={descontinuarItem}
        onOpenChange={() => setDescontinuarItem(null)}
        pending={descontinuarMutation.isPending}
        onConfirm={() => descontinuarItem && descontinuarMutation.mutate(descontinuarItem)}
      />

      {/* Confirmação: remover selecionados em lote */}
      <RemoverItensLoteDialog
        itens={confirmarRemocaoLote ? linhasSelecionadas : null}
        onOpenChange={() => setConfirmarRemocaoLote(false)}
        pending={removerLoteMutation.isPending}
        onConfirm={() => removerLoteMutation.mutate()}
      />
    </Dialog>
  );
}
