import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, FileInput, HelpCircle, RefreshCw } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { UltimaExecucao } from '@/components/execucoes/UltimaExecucao';
import { useRegisterCommands, type Command } from '@/components/shell/CommandsRegistry';
import { formatBRL } from '@/components/reposicao/pedidos/shared';
import { ImportarPedidoPortalDialog } from './ImportarPedidoPortalDialog';
import { descreverDiferenca, lerDiferencas } from './aceitar-portal';
import {
  CHAVE_PAINEL_PORTAL, esperaDaRodada, linkDoPedido, msAteReleituraPosCron, normalizarPainel, vereditoPainel, type PainelPortal,
} from './importar-portal';

const quando = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
const hora = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

/** "mostrando 50 de 61" quando a RPC cortou a lista (6.5). */
function Corte({ mostrados, total }: { mostrados: number; total: number }) {
  if (total <= mostrados) return null;
  return <p className="mt-1 text-xs text-muted-foreground">Mostrando {mostrados} de {total}.</p>;
}

/**
 * Pedidos do portal Sayerlack: o que a varredura automática (12:30 · 17:30 · 22:30) e o botão importaram, e o que ficou
 * PENDENTE. Lê a RPC `sayerlack_painel_portal` v2 (cap_compras_ler). "Nada pendente" só com PROVA: rodada automática
 * efetiva recente, nada em espera e nada pendente (6.1). Falha de leitura NUNCA vira "nada pendente" (6.2/6.3).
 * Vocabulário único: "pedido de compra" (6.9).
 */
export function PedidosPortalCard() {
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    // Sob o prefixo `pedidos-ciclo` de propósito (6.7): o realtime e toda ação de Gerir pedidos invalidam esse prefixo.
    queryKey: CHAVE_PAINEL_PORTAL,
    queryFn: async (): Promise<PainelPortal> => {
      const { data: bruto, error: e } = await supabase.rpc('sayerlack_painel_portal');
      if (e) throw e;
      return normalizarPainel(bruto);
    },
  });
  const [importarProtocolo, setImportarProtocolo] = useState<string | null>(null);
  const [verImportados, setVerImportados] = useState(false);

  // 6.7: relê sozinho depois de cada rodada do cron (o card aberto não fica com o retrato de antes da rodada).
  useEffect(() => {
    let id: ReturnType<typeof setTimeout>;
    const agendar = () => { id = setTimeout(() => { void refetch(); agendar(); }, msAteReleituraPosCron(new Date())); };
    agendar();
    return () => clearTimeout(id);
  }, [refetch]);

  // 6.10: Cmd-K "Importar pedido do portal" enquanto Gerir pedidos está aberta.
  const comandos = useMemo<Command[]>(() => [{
    id: 'reposicao.importar-pedido-portal',
    label: 'Importar pedido do portal Sayerlack',
    keywords: ['importar', 'portal', 'sayerlack', 'pedido de compra', 'omie', 'protocolo'],
    group: 'Ações',
    icon: FileInput,
    perform: (close) => { close(); setImportarProtocolo(''); },
  }], []);
  useRegisterCommands(comandos);

  // Dado velho com a última leitura falhando: mostra o retrato, mas nunca como "nada pendente" atual (6.3).
  const velho = !!error && !!data;
  const veredito = data ? vereditoPainel(data) : null;
  const espera = data ? esperaDaRodada(data) : null;
  const ef = data?.rodada.efetiva ?? null;
  const ul = data?.rodada.ultima ?? null;
  const ultimaFalhou = !!ul && ul.status === 'erro' && (!ef || Date.parse(ul.em) > Date.parse(ef.em));

  return (
    <Card data-testid="pedidos-portal-card">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            Pedidos do portal Sayerlack
            {data && data.pendentesUnicos > 0 && (
              <span className="inline-flex items-center gap-1 text-sm font-normal text-status-warning">
                <AlertTriangle className="w-4 h-4" aria-hidden /> {data.pendentesUnicos} pendente{data.pendentesUnicos > 1 ? 's' : ''}
              </span>
            )}
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            {/* Varredura automática do portal (cron 12:30 · 17:30 · 22:30) — registro server-side da edge. */}
            <UltimaExecucao acao="reposicao.varrer_portal_sayerlack" />
            <Button size="sm" variant="ghost" onClick={() => void refetch()} disabled={isFetching} aria-label="Atualizar pedidos do portal">
              <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} aria-hidden />
            </Button>
            <ImportarPedidoPortalDialog />
          </div>
        </div>
        {data && (
          <p className="text-xs text-muted-foreground" data-testid="pedidos-portal-consultado">
            Consultado às {hora(data.consultadoEm)}
            {ef ? ` · última rodada automática com leitura provada: ${quando(ef.em)}` : ' · nenhuma rodada automática com leitura provada'}
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {isLoading && <p className="text-muted-foreground">Carregando…</p>}
        {error && (
          <div className="flex flex-wrap items-center gap-2 text-status-error" role="alert">
            <AlertTriangle className="w-4 h-4" aria-hidden />
            {velho
              ? `A última atualização falhou — o que está abaixo é de ${hora(data.consultadoEm)} e pode estar desatualizado.`
              : 'Não consegui ler os pedidos do portal — pode haver pendência que não estou mostrando.'}
            <Button size="sm" variant="outline" onClick={() => void refetch()} disabled={isFetching}>
              <RefreshCw className="w-3.5 h-3.5 mr-1" aria-hidden /> Tentar de novo
            </Button>
          </div>
        )}

        {data && ul && ultimaFalhou && (
          <p className="flex items-start gap-1 text-status-error" role="alert" data-testid="pedidos-portal-ultima-falhou">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden />
            <span className="break-words">
              A rodada automática de {quando(ul.em)} falhou{ul.erro ? `: ${ul.erro}` : ''}. Veja o runbook
              “pedido do portal não entrou” (cron parado).
            </span>
          </p>
        )}

        {data && data.canceladoComPo.length > 0 && (
          <section aria-label="Cancelados no portal com pedido de compra">
            <p className="font-medium text-status-error mb-1">Cancelado no portal, mas com pedido de compra no Omie</p>
            <ul className="divide-y rounded-md border">
              {data.canceladoComPo.map((p) => (
                <li key={p.pedidoId} className="p-2">
                  <p className="font-medium">
                    Pedido {p.protocolo} · <Link className="underline" to={linkDoPedido(p.pedidoId)}>#{p.pedidoId}</Link>
                    {p.omieNumero ? ` · pedido de compra ${p.omieNumero}` : ''}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    A Sayerlack cancelou ({quando(p.situacaoEm)}). Cancele o pedido de compra no Omie se ele não vai chegar.
                  </p>
                </li>
              ))}
            </ul>
            <Corte mostrados={data.canceladoComPo.length} total={data.totalCanceladoComPo} />
          </section>
        )}

        {data && data.alterado.length > 0 && (
          <section aria-label="Alterados no portal">
            <p className="font-medium text-status-error mb-1">Alterado no portal (não bate com o pedido do app)</p>
            <ul className="divide-y rounded-md border">
              {data.alterado.map((p) => {
                const difs = lerDiferencas(p.diferencas);
                return (
                  <li key={p.pedidoId} className="flex flex-col gap-2 p-2 sm:flex-row sm:items-start sm:justify-between" data-testid="pedidos-portal-alterado">
                    <div className="min-w-0">
                      <p className="font-medium">
                        Pedido {p.protocolo} · <Link className="underline" to={linkDoPedido(p.pedidoId)}>#{p.pedidoId}</Link>
                        {p.omieNumero ? ` · pedido de compra ${p.omieNumero}` : ''}
                      </p>
                      {difs === null ? (
                        <p className="text-xs text-status-warning">Não consegui ler as diferenças — abra o pedido.</p>
                      ) : (
                        <ul className="text-xs text-muted-foreground break-words">
                          {difs.slice(0, 3).map((d, i) => <li key={i}>{descreverDiferenca(d)}</li>)}
                          {difs.length > 3 && <li>e mais {difs.length - 3} diferença{difs.length - 3 > 1 ? 's' : ''}</li>}
                        </ul>
                      )}
                      <p className="text-xs text-muted-foreground">
                        {p.semPo
                          ? 'O app não cria o pedido de compra enquanto o portal diverge. Abra o pedido e aceite o portal (ou corrija no portal).'
                          : 'O pedido de compra no Omie foi feito com o pedido antigo. Confira-o no Omie se o portal é o que vale.'}
                        {` · visto ${quando(p.detectadaEm)}`}
                      </p>
                      {p.pendenciaMensagem && (
                        <p className="text-xs text-muted-foreground break-words">
                          {p.pendenciaMensagem}
                          {p.pendenciaTentativas ? ` · ${p.pendenciaTentativas} tentativa${p.pendenciaTentativas > 1 ? 's' : ''}` : ''}
                        </p>
                      )}
                    </div>
                    <Button asChild size="sm" variant="outline" className="shrink-0">
                      <Link to={linkDoPedido(p.pedidoId)}>Abrir o pedido</Link>
                    </Button>
                  </li>
                );
              })}
            </ul>
            <Corte mostrados={data.alterado.length} total={data.totalAlterado} />
          </section>
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
            <Corte mostrados={data.pendencias.length} total={data.totalPendencias} />
          </section>
        )}

        {data && data.semPo.length > 0 && (
          <section aria-label="No app sem pedido de compra">
            <p className="font-medium text-status-warning mb-1">No app, sem pedido de compra no Omie</p>
            <ul className="divide-y rounded-md border">
              {data.semPo.map((p) => (
                <li key={p.pedidoId} className="flex flex-col gap-2 p-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="font-medium">
                      Pedido {p.protocolo} · <Link className="underline" to={linkDoPedido(p.pedidoId)}>#{p.pedidoId}</Link>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {p.origem === 'app' ? 'Enviado pelo app' : 'Importado'} {quando(p.desde)} · status {p.status ?? '?'}
                    </p>
                    {p.pendenciaMensagem && (
                      <p className="text-xs text-muted-foreground break-words">
                        {p.pendenciaMensagem}
                        {p.pendenciaTentativas ? ` · ${p.pendenciaTentativas} tentativa${p.pendenciaTentativas > 1 ? 's' : ''}` : ''}
                      </p>
                    )}
                  </div>
                  {p.divergenciaAberta ? (
                    // 6.11: re-disparar seria recusado (a divergência trava o claim) — resolve-se no pedido.
                    <Button asChild size="sm" variant="outline" className="shrink-0">
                      <Link to={linkDoPedido(p.pedidoId)}>Alterado no portal — abrir</Link>
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" className="shrink-0" onClick={() => setImportarProtocolo(p.protocolo)}>
                      Criar pedido de compra
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            <Corte mostrados={data.semPo.length} total={data.totalSemPo} />
          </section>
        )}

        {data && data.canceladoSemPo.length > 0 && (
          <section aria-label="Cancelados no portal sem pedido de compra">
            <p className="font-medium text-status-warning mb-1">Cancelado no portal (o app não vai comprar)</p>
            <ul className="divide-y rounded-md border">
              {data.canceladoSemPo.map((p) => (
                <li key={p.pedidoId} className="p-2">
                  <p className="font-medium">
                    Pedido {p.protocolo} · <Link className="underline" to={linkDoPedido(p.pedidoId)}>#{p.pedidoId}</Link>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    A Sayerlack cancelou ({quando(p.situacaoEm)}). O app não vai criar o pedido de compra; o pedido fica parado até ser encerrado.
                  </p>
                </li>
              ))}
            </ul>
            <Corte mostrados={data.canceladoSemPo.length} total={data.totalCanceladoSemPo} />
          </section>
        )}

        {data && (data.aguardando.total > 0 || (espera?.partes.length ?? 0) > 0) && (
          <p className="text-xs text-muted-foreground" data-testid="pedidos-portal-espera">
            Em espera (não é erro ainda):{' '}
            {[
              data.aguardando.total > 0 ? `${data.aguardando.total} enviado(s) há menos de 1 h aguardando o pedido de compra` : null,
              ...(espera?.partes ?? []),
            ].filter(Boolean).join(' · ')}.
          </p>
        )}

        {data && data.semAliquota.skus > 0 && (
          <p className="text-xs text-status-warning" data-testid="pedidos-portal-sem-aliquota">
            {data.semAliquota.skus} SKU{data.semAliquota.skus > 1 ? 's' : ''} Sayerlack sem alíquota de IPI
            {data.semAliquota.ncms.length > 0 ? ` (NCM ${data.semAliquota.ncms.join(', ')})` : ''}: pedido com eles não entra (CP006).
          </p>
        )}

        {data && veredito && !velho && veredito.tom === 'ok' && (
          <p className="flex items-center gap-1 text-status-success" data-testid="pedidos-portal-veredito" data-tom="ok">
            <CheckCircle2 className="w-4 h-4" aria-hidden /> Nada pendente do portal.
          </p>
        )}
        {data && veredito && veredito.tom === 'sem_prova' && (
          <p className="flex items-start gap-1 text-status-warning" data-testid="pedidos-portal-veredito" data-tom="sem_prova">
            <HelpCircle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden />
            <span>Nenhuma pendência registrada, mas não posso afirmar que não há: {veredito.motivo}</span>
          </p>
        )}

        {data && data.importados.length > 0 && (
          <Collapsible open={verImportados} onOpenChange={setVerImportados}>
            <CollapsibleTrigger className="flex min-h-[44px] items-center gap-1 text-xs text-muted-foreground hover:text-foreground sm:min-h-0">
              {verImportados ? <ChevronDown className="w-3.5 h-3.5" aria-hidden /> : <ChevronRight className="w-3.5 h-3.5" aria-hidden />}
              Importados nos últimos 14 dias ({data.totalImportados})
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ul className="mt-1 divide-y rounded-md border text-xs">
                {data.importados.map((p) => (
                  <li key={p.pedidoId} className="flex flex-wrap items-center justify-between gap-2 p-2">
                    <span>
                      Pedido {p.protocolo} · <Link className="underline" to={linkDoPedido(p.pedidoId)}>#{p.pedidoId}</Link>
                      {p.omieNumero ? ` · pedido de compra ${p.omieNumero}` : ' · sem pedido de compra'}
                    </span>
                    <span className="text-muted-foreground tabular-nums">
                      {p.valorTotal != null ? formatBRL(p.valorTotal) : '—'} · {p.origem === 'cron' ? 'automático' : 'botão'} · {quando(p.importadoEm)}
                    </span>
                  </li>
                ))}
              </ul>
              <Corte mostrados={data.importados.length} total={data.totalImportados} />
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
