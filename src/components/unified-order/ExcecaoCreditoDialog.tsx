import { useState } from 'react';
import { ShieldAlert, ShieldCheck, Copy } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useDisplayAccess } from '@/hooks/useDisplayAccess';
import {
  useAprovadoresCredito,
  useAprovarExcecaoCredito,
  useBloqueioCreditoLog,
  useExcecaoCreditoVigente,
  type ContextoBloqueioCredito,
} from '@/hooks/useExcecaoCredito';
import { formatBRL, formatDate } from '@/lib/reposicao';
import { track } from '@/lib/analytics';

/**
 * Válvula de escape da trava de crédito (Fase 2): aprova uma exceção POR PEDIDO.
 *
 * Visões (useDisplayAccess — fiel à lente; a ESCRITA vive em useExcecaoCredito
 * com a identidade REAL + RLS WITH CHECK + trigger anti-forje):
 * - Gestor/master: form motivo + validade → INSERT em venda_excecao_credito.
 * - Vendedor: NÃO cria tarefa (RLS tarefas_insert é gestor-only por desenho do
 *   domínio Tarefas) → mostra quem pode aprovar + resumo copiável pro WhatsApp.
 *
 * Contexto do bloqueio: via prop (fluxo do submit, dado fresco do gate) ou do
 * último venda_bloqueio_credito_log do pedido (fluxo /sales — gestor remoto).
 * Sem evidência de bloqueio não há form (precisão > recall: exceção às cegas não).
 */

const VALIDADE_DIAS = [
  { dias: 3, label: '3 dias' },
  { dias: 7, label: '7 dias (padrão)' },
  { dias: 15, label: '15 dias' },
  { dias: 30, label: '30 dias (máximo)' },
] as const;

const contaLabel = (account: 'oben' | 'colacor') => (account === 'oben' ? 'Oben' : 'Colacor');

function resumoParaGestor(salesOrderId: string, ctx: ContextoBloqueioCredito): string {
  const valor = typeof ctx.vencido === 'number' ? formatBRL(ctx.vencido) : 'valor não informado';
  const titulos = ctx.titulos ? ` (${ctx.titulos} título${ctx.titulos > 1 ? 's' : ''})` : '';
  return (
    `Preciso de aprovação de exceção de crédito:\n` +
    `Cliente: ${ctx.nomeCliente} (código ${ctx.omieCodigoCliente} — conta ${contaLabel(ctx.account)})\n` +
    `Bloqueio: ${valor} vencido há 60+ dias${titulos}\n` +
    `Pedido: ${salesOrderId}\n` +
    `Como aprovar: Pedidos → abrir o pedido do cliente → botão "Crédito" → Aprovar exceção. Depois eu reenvio o pedido.`
  );
}

export function ExcecaoCreditoDialog({
  open,
  onOpenChange,
  salesOrderId,
  bloqueio,
  nomeCliente,
  onExcecaoCriada,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  salesOrderId: string;
  /** Contexto fresco do gate (fluxo do submit). Ausente → busca o último log de bloqueio. */
  bloqueio?: ContextoBloqueioCredito;
  /** Nome exibido quando o contexto vem do log (o log não guarda nome). */
  nomeCliente?: string;
  onExcecaoCriada?: () => void;
}) {
  const { displayIsMaster, displayIsGestorComercial } = useDisplayAccess();
  const isGestor = displayIsMaster || displayIsGestorComercial;

  const [motivo, setMotivo] = useState('');
  const [validadeDias, setValidadeDias] = useState('7');

  const logQuery = useBloqueioCreditoLog(salesOrderId, open && !bloqueio);
  const excecaoQuery = useExcecaoCreditoVigente(salesOrderId, open);
  const aprovadoresQuery = useAprovadoresCredito(open && !isGestor);
  const { aprovar, salvando } = useAprovarExcecaoCredito(salesOrderId);

  const ctx: ContextoBloqueioCredito | null =
    bloqueio ??
    (logQuery.data && logQuery.data.omie_codigo_cliente
      ? {
          account: logQuery.data.company === 'colacor' ? 'colacor' : 'oben',
          omieCodigoCliente: logQuery.data.omie_codigo_cliente,
          nomeCliente: nomeCliente || 'Cliente',
          vencido: logQuery.data.vencido,
          titulos: logQuery.data.titulos,
        }
      : null);

  const onAprovar = async () => {
    if (!ctx) return;
    const ok = await aprovar(ctx, motivo, Number(validadeDias));
    if (ok) {
      setMotivo('');
      onExcecaoCriada?.();
    }
  };

  const copiarResumo = async () => {
    if (!ctx) return;
    try {
      await navigator.clipboard.writeText(resumoParaGestor(salesOrderId, ctx));
      track('venda.bloqueio_credito_resumo_copiado', { account: ctx.account });
      toast.success('Resumo copiado', { description: 'Cole no WhatsApp do gestor.' });
    } catch {
      toast.error('Não foi possível copiar', { description: 'Copie os dados manualmente do painel.' });
    }
  };

  const carregandoContexto = !bloqueio && logQuery.isPending;
  const excecaoValida = excecaoQuery.data;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="w-5 h-5 text-status-error" />
            Exceção de crédito
          </DialogTitle>
          <DialogDescription>
            O gate bloqueia venda a cliente com saldo vencido há 60+ dias. A exceção vale só para
            este pedido, dentro da validade.
          </DialogDescription>
        </DialogHeader>

        {carregandoContexto && (
          <p className="text-sm text-muted-foreground py-4">Buscando o bloqueio deste pedido…</p>
        )}

        {!carregandoContexto && !ctx && (
          <p className="text-sm text-muted-foreground py-4">
            Nenhum bloqueio de crédito registrado para este pedido. Este painel serve para pedidos
            que o gate travou no envio ao Omie.
          </p>
        )}

        {ctx && (
          <div className="space-y-4">
            <div className="bg-status-error/10 border border-status-error/30 rounded-lg p-3 text-xs space-y-1">
              <p className="font-semibold text-status-error">
                {ctx.nomeCliente} · conta {contaLabel(ctx.account)}
              </p>
              <p className="text-muted-foreground">
                {typeof ctx.vencido === 'number'
                  ? `${formatBRL(ctx.vencido)} vencido há 60+ dias`
                  : 'Valor vencido não informado pelo gate'}
                {ctx.titulos ? ` · ${ctx.titulos} título${ctx.titulos > 1 ? 's' : ''}` : ''}
                {' '}· código Omie {ctx.omieCodigoCliente}
              </p>
            </div>

            {excecaoValida ? (
              <div className="bg-status-success/10 border border-status-success/30 rounded-lg p-3 text-xs space-y-1">
                <p className="font-semibold text-status-success flex items-center gap-1.5">
                  <ShieldCheck className="w-3.5 h-3.5" />
                  Exceção já aprovada — válida até {formatDate(excecaoValida.valido_ate.slice(0, 10))}
                </p>
                <p className="text-muted-foreground">
                  Motivo: {excecaoValida.motivo}. É só reenviar o pedido que o gate libera.
                </p>
              </div>
            ) : isGestor ? (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="excecao-motivo">Motivo (obrigatório, fica na auditoria)</Label>
                  <Textarea
                    id="excecao-motivo"
                    placeholder="Ex.: cliente negociou a dívida com o financeiro, quita sexta"
                    value={motivo}
                    onChange={(e) => setMotivo(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Validade da exceção</Label>
                  <Select value={validadeDias} onValueChange={setValidadeDias}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {VALIDADE_DIAS.map((v) => (
                        <SelectItem key={v.dias} value={String(v.dias)}>
                          {v.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-2xs text-muted-foreground">
                    Vale SÓ para este pedido. Um pedido novo do mesmo cliente bloqueia de novo.
                  </p>
                </div>
              </>
            ) : (
              <div className="space-y-2 text-xs">
                <p className="text-muted-foreground">
                  Só gestor comercial ou master aprova exceção. Quem pode aprovar
                  {aprovadoresQuery.data?.length ? (
                    <>
                      : <span className="text-foreground font-medium">{aprovadoresQuery.data.join(', ')}</span>.
                    </>
                  ) : (
                    ' você encontra com a gestão.'
                  )}
                </p>
                <p className="text-muted-foreground">
                  O pedido ficou salvo — depois da aprovação é só reenviar (o carrinho não duplica).
                </p>
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Fechar
          </Button>
          {ctx && !excecaoValida && isGestor && (
            <Button onClick={onAprovar} disabled={salvando || !motivo.trim()}>
              {salvando ? 'Aprovando…' : 'Aprovar exceção'}
            </Button>
          )}
          {ctx && !excecaoValida && !isGestor && (
            <Button onClick={copiarResumo} className="gap-2">
              <Copy className="w-4 h-4" />
              Copiar resumo pro gestor
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
