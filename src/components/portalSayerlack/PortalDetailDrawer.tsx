import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from '@/components/ui/sheet';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { PortalStatusBadge } from './PortalStatusBadge';
import { DispararAgoraButton } from './DispararAgoraButton';
import { AlertCircle, RefreshCw, ExternalLink } from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { toast } from 'sonner';
import { useState } from 'react';

interface Props {
  pedidoId: number | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  isAdmin?: boolean;
}

function fmtBRL(v: number | null | undefined) {
  if (v == null) return '—';
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v));
}
function fmtDateTime(iso: string | null | undefined) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR');
}

export function PortalDetailDrawer({ pedidoId, open, onOpenChange, isAdmin }: Props) {
  const qc = useQueryClient();
  const [resetting, setResetting] = useState(false);

  const { data: pedido, isLoading } = useQuery({
    queryKey: ['portal-sayerlack-detail', pedidoId],
    queryFn: async () => {
      if (!pedidoId) return null;
      const { data, error } = await supabase
        .from('pedido_compra_sugerido')
        .select('*')
        .eq('id', pedidoId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: !!pedidoId && open,
  });

  const { data: items } = useQuery({
    queryKey: ['portal-sayerlack-items', pedidoId],
    queryFn: async () => {
      if (!pedidoId) return [];
      const { data: rows, error } = await supabase
        .from('pedido_compra_item')
        .select('id, sku_codigo_omie, sku_descricao, qtde_final, preco_unitario, valor_linha')
        .eq('pedido_id', pedidoId);
      if (error) throw error;

      const skus = (rows ?? []).map((r) => r.sku_codigo_omie).filter(Boolean);
      let mapping: Record<string, string> = {};
      if (skus.length) {
        const { data: maps } = await supabase
          .from('sku_fornecedor_externo')
          .select('sku_omie, sku_portal, ativo')
          .in('sku_omie', skus as string[])
          .eq('empresa', 'OBEN')
          .ilike('fornecedor_nome', '%SAYERLACK%');
        for (const m of maps ?? []) {
          if (m.ativo && m.sku_omie) mapping[m.sku_omie] = m.sku_portal as string;
        }
      }
      return (rows ?? []).map((r) => ({
        ...r,
        sku_portal: r.sku_codigo_omie ? mapping[r.sku_codigo_omie] ?? null : null,
      }));
    },
    enabled: !!pedidoId && open,
  });

  const refetchAll = () => {
    qc.invalidateQueries({ queryKey: ['portal-sayerlack-detail', pedidoId] });
    qc.invalidateQueries({ queryKey: ['portal-sayerlack-items', pedidoId] });
    qc.invalidateQueries({ queryKey: ['portal-sayerlack-pendentes'] });
    qc.invalidateQueries({ queryKey: ['portal-sayerlack-historico'] });
    qc.invalidateQueries({ queryKey: ['portal-sayerlack-kpi'] });
  };

  const handleForceReset = async () => {
    if (!pedidoId) return;
    setResetting(true);
    try {
      const { error } = await supabase
        .from('pedido_compra_sugerido')
        .update({
          status_envio_portal: 'pendente_envio_portal',
          portal_tentativas: 0,
          portal_proximo_retry_em: null,
          portal_erro: null,
          portal_protocolo: null,
          enviado_portal_em: null,
        })
        .eq('id', pedidoId);
      if (error) throw error;
      toast.success(`Pedido #${pedidoId} resetado. Use 'Disparar agora' para reenviar.`);
      refetchAll();
    } catch (err: any) {
      toast.error(`Falha: ${err.message}`);
    } finally {
      setResetting(false);
    }
  };

  const itemsSemMapeamento = (items ?? []).filter((i) => !i.sku_portal);
  const isPendente = pedido?.status_envio_portal === 'pendente_envio_portal'
    || pedido?.status_envio_portal === 'enviando_portal';
  const isHistorico = pedido?.status_envio_portal === 'enviado_portal'
    || pedido?.status_envio_portal === 'falha_envio_portal';

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle>
            {isHistorico ? 'Detalhes do envio' : 'Detalhes do pedido'} #{pedidoId}
          </SheetTitle>
          <SheetDescription>
            Dados completos do envio ao portal Sayerlack.
          </SheetDescription>
        </SheetHeader>

        {isLoading || !pedido ? (
          <div className="space-y-3 mt-4">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : (
          <div className="space-y-4 mt-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Resumo</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-3 text-sm">
                <div><span className="text-muted-foreground">Empresa:</span> {pedido.empresa}</div>
                <div><span className="text-muted-foreground">Fornecedor:</span> {pedido.fornecedor_nome}</div>
                <div><span className="text-muted-foreground">Valor total:</span> {fmtBRL(pedido.valor_total)}</div>
                <div><span className="text-muted-foreground">Nº SKUs:</span> {pedido.num_skus}</div>
                <div><span className="text-muted-foreground">Aprovado em:</span> {fmtDateTime(pedido.aprovado_em)}</div>
                <div><span className="text-muted-foreground">Aprovado por:</span> {pedido.aprovado_por ?? '—'}</div>
                <div className="col-span-2 flex items-center gap-2 pt-2 border-t">
                  <span className="text-muted-foreground">Status portal:</span>
                  <PortalStatusBadge status={pedido.status_envio_portal} />
                  <span className="text-muted-foreground ml-3">Tentativas:</span>
                  <Badge variant="outline">{pedido.portal_tentativas ?? 0}</Badge>
                  {pedido.portal_proximo_retry_em && (
                    <>
                      <span className="text-muted-foreground ml-3">Próximo retry:</span>
                      <span>{fmtDateTime(pedido.portal_proximo_retry_em)}</span>
                    </>
                  )}
                </div>
                {pedido.portal_protocolo && (
                  <div className="col-span-2">
                    <span className="text-muted-foreground">Protocolo:</span>{' '}
                    <span className="font-mono">{pedido.portal_protocolo}</span>
                  </div>
                )}
                {pedido.enviado_portal_em && (
                  <div className="col-span-2">
                    <span className="text-muted-foreground">Enviado em:</span> {fmtDateTime(pedido.enviado_portal_em)}
                  </div>
                )}
              </CardContent>
            </Card>

            {itemsSemMapeamento.length > 0 && (
              <Card className="border-red-300 bg-red-50">
                <CardContent className="flex items-start gap-2 pt-4 text-sm text-red-800">
                  <AlertCircle className="h-4 w-4 mt-0.5" />
                  <div>
                    <strong>{itemsSemMapeamento.length} item(s) sem mapeamento ativo</strong> em
                    sku_fornecedor_externo. O envio pode falhar.
                  </div>
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Itens ({items?.length ?? 0})</CardTitle>
              </CardHeader>
              <CardContent className="text-sm">
                <div className="max-h-72 overflow-auto">
                  <table className="w-full text-xs">
                    <thead className="text-left text-muted-foreground border-b">
                      <tr>
                        <th className="py-1">SKU Omie</th>
                        <th className="py-1">SKU Portal</th>
                        <th className="py-1">Descrição</th>
                        <th className="py-1 text-right">Qtde</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(items ?? []).map((it) => (
                        <tr key={it.id} className="border-b">
                          <td className="py-1 font-mono">{it.sku_codigo_omie}</td>
                          <td className="py-1 font-mono">
                            {it.sku_portal ?? <span className="text-red-600">sem mapeamento</span>}
                          </td>
                          <td className="py-1">{it.sku_descricao}</td>
                          <td className="py-1 text-right">{it.qtde_final}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>

            {pedido.portal_screenshot_url && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center gap-2">
                    Screenshot de confirmação
                    <a
                      href={pedido.portal_screenshot_url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary"
                    >
                      <ExternalLink className="h-4 w-4" />
                    </a>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <img
                    src={pedido.portal_screenshot_url}
                    alt="Screenshot do envio"
                    className="max-w-full rounded border"
                  />
                </CardContent>
              </Card>
            )}

            {pedido.portal_resposta && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Resposta portal</CardTitle>
                </CardHeader>
                <CardContent>
                  <pre className="text-xs bg-muted p-2 rounded max-h-60 overflow-auto">
                    {JSON.stringify(pedido.portal_resposta, null, 2)}
                  </pre>
                </CardContent>
              </Card>
            )}

            {pedido.portal_erro && (
              <Card className="border-red-300 bg-red-50">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base text-red-800">Erro</CardTitle>
                </CardHeader>
                <CardContent>
                  <pre className="text-xs whitespace-pre-wrap text-red-900">
                    {pedido.portal_erro}
                  </pre>
                </CardContent>
              </Card>
            )}

            <div className="flex gap-2 pt-2">
              {isPendente && (
                <DispararAgoraButton
                  pedidoId={pedido.id}
                  onSuccess={refetchAll}
                />
              )}

              {isHistorico && isAdmin && (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="outline" disabled={resetting}>
                      <RefreshCw className="h-4 w-4 mr-2" />
                      Forçar reenvio
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Forçar reenvio?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Isso vai resetar tracking e tentar novamente enviar pedido #{pedido.id}.
                        Use apenas se tem certeza que envio anterior NÃO foi recebido pela
                        Sayerlack. Confirmar?
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancelar</AlertDialogCancel>
                      <AlertDialogAction onClick={handleForceReset}>
                        Confirmar reset
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
