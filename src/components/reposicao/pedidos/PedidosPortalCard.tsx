import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { UltimaExecucao } from '@/components/execucoes/UltimaExecucao';
import { formatBRL } from '@/components/reposicao/pedidos/shared';
import { ImportarPedidoPortalDialog } from './ImportarPedidoPortalDialog';
import { linkDoPedido, normalizarPainel, type PainelPortal } from './importar-portal';

const quando = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

/**
 * Pedidos do portal Sayerlack: o que a varredura automática (12:30 · 17:30 · 22:30) e o botão importaram, e o que ficou
 * PENDENTE. Antes só havia o e-mail e o ✓/✗ da última rodada — uma rodada boa escondia a pendência da anterior.
 * Lê a RPC `sayerlack_painel_portal` (cap_compras_ler). Falha de leitura NUNCA vira "nada pendente".
 */
export function PedidosPortalCard() {
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['portal-sayerlack-painel'],
    queryFn: async (): Promise<PainelPortal> => {
      const { data: bruto, error: e } = await supabase.rpc('sayerlack_painel_portal');
      if (e) throw e;
      return normalizarPainel(bruto);
    },
  });
  const [importarProtocolo, setImportarProtocolo] = useState<string | null>(null);
  const [verImportados, setVerImportados] = useState(false);

  const pendentes = (data?.pendencias.length ?? 0) + (data?.semPo.length ?? 0);

  return (
    <Card data-testid="pedidos-portal-card">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            Pedidos do portal Sayerlack
            {data && pendentes > 0 && (
              <span className="inline-flex items-center gap-1 text-sm font-normal text-status-warning">
                <AlertTriangle className="w-4 h-4" aria-hidden /> {pendentes} pendente{pendentes > 1 ? 's' : ''}
              </span>
            )}
          </CardTitle>
          <div className="flex items-center gap-2">
            {/* Varredura automática do portal (cron 12:30 · 17:30 · 22:30) — registro server-side da edge. */}
            <UltimaExecucao acao="reposicao.varrer_portal_sayerlack" />
            <ImportarPedidoPortalDialog />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {isLoading && <p className="text-muted-foreground">Carregando…</p>}
        {error && (
          <div className="flex flex-wrap items-center gap-2 text-status-error" role="alert">
            <AlertTriangle className="w-4 h-4" aria-hidden />
            Não consegui ler os pedidos do portal — pode haver pendência que não estou mostrando.
            <Button size="sm" variant="outline" onClick={() => void refetch()} disabled={isFetching}>
              <RefreshCw className="w-3.5 h-3.5 mr-1" aria-hidden /> Tentar de novo
            </Button>
          </div>
        )}

        {data && data.pendencias.length > 0 && (
          <section aria-label="Pendências da varredura">
            <p className="font-medium text-status-error mb-1">Não entraram no Omie</p>
            <ul className="divide-y rounded-md border">
              {data.pendencias.map((p) => (
                <li key={p.protocolo} className="flex flex-col gap-2 p-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <p className="font-medium">Pedido {p.protocolo}</p>
                    <p className="text-xs text-muted-foreground break-words">{p.mensagem}</p>
                    <p className="text-xs text-muted-foreground">
                      {p.tentativas} tentativa{p.tentativas > 1 ? 's' : ''} · última {quando(p.ultimaEm)}
                    </p>
                  </div>
                  <Button size="sm" variant="outline" className="shrink-0" onClick={() => setImportarProtocolo(p.protocolo)}>
                    Importar de novo
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {data && data.semPo.length > 0 && (
          <section aria-label="Gravados sem pedido de compra">
            <p className="font-medium text-status-warning mb-1">No app, sem pedido de compra no Omie</p>
            <ul className="divide-y rounded-md border">
              {data.semPo.map((p) => (
                <li key={p.pedidoId} className="flex flex-col gap-2 p-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="font-medium">
                      Pedido {p.protocolo} · <Link className="underline" to={linkDoPedido(p.pedidoId)}>#{p.pedidoId}</Link>
                    </p>
                    <p className="text-xs text-muted-foreground">Gravado {quando(p.importadoEm)} · status {p.status ?? '?'}</p>
                  </div>
                  <Button size="sm" variant="outline" className="shrink-0" onClick={() => setImportarProtocolo(p.protocolo)}>
                    Criar pedido de compra
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {data && pendentes === 0 && (
          <p className="flex items-center gap-1 text-status-success">
            <CheckCircle2 className="w-4 h-4" aria-hidden /> Nada pendente do portal.
          </p>
        )}

        {data && data.importados.length > 0 && (
          <Collapsible open={verImportados} onOpenChange={setVerImportados}>
            <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              {verImportados ? <ChevronDown className="w-3.5 h-3.5" aria-hidden /> : <ChevronRight className="w-3.5 h-3.5" aria-hidden />}
              Importados nos últimos 14 dias ({data.importados.length})
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ul className="mt-1 divide-y rounded-md border text-xs">
                {data.importados.map((p) => (
                  <li key={p.pedidoId} className="flex flex-wrap items-center justify-between gap-2 p-2">
                    <span>
                      Pedido {p.protocolo} · <Link className="underline" to={linkDoPedido(p.pedidoId)}>#{p.pedidoId}</Link>
                      {p.omieNumero ? ` · PO ${p.omieNumero}` : ' · sem PO'}
                    </span>
                    <span className="text-muted-foreground tabular-nums">
                      {p.valorTotal != null ? formatBRL(p.valorTotal) : '—'} · {p.origem === 'cron' ? 'automático' : 'botão'} · {quando(p.importadoEm)}
                    </span>
                  </li>
                ))}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        )}
      </CardContent>

      <ImportarPedidoPortalDialog
        open={importarProtocolo !== null}
        onOpenChange={(v) => { if (!v) setImportarProtocolo(null); }}
        protocoloInicial={importarProtocolo ?? undefined}
      />
    </Card>
  );
}
