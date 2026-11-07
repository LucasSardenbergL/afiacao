import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Inbox, Loader2 } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { AvisoLeituraFalhou } from '@/components/leitura/AvisoLeituraFalhou';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { track } from '@/lib/analytics';
import { estadoDeLeitura, naoConsegui } from '@/lib/leitura/estado-de-leitura';
import { dataBr } from '@/lib/radar/sucessao';
import {
  AVISO_REPROCESSO, aplicarFamilia, chaveItem, mensagemRecusaPlano, mesmoRascunho, rascunhoDoPlano, regrasDoRascunho,
  resumoRascunho, type DestinoDoEvento, type ItemDaAntiga, type PlanoDoEvento, type Rascunho,
} from '@/lib/radar/sucessao-plano';
import { cn } from '@/lib/utils';
import { useRadarPlanoSucessao, useRadarPublicarPlano, useRadarRevogarPlano } from '@/queries/useRadarSucessoes';

const FICA = '';   // valor do <select> = "fica com a antiga"

/**
 * O plano de rateio de UMA sucessão (evento): por item que a antiga comprou antes do corte, para qual empresa nova o
 * histórico passa. Gestor/master (o gate é da RPC). Na lente "Ver como" é só leitura: a escrita é do usuário REAL e o
 * write-guard bloquearia de qualquer jeito — aqui os botões nem habilitam.
 */
export function RadarSucessaoPlano({ eventoId, aberto, onFechar }: {
  eventoId: string; aberto: boolean; onFechar: () => void;
}) {
  const { isImpersonating } = useImpersonation();
  const { plano, itens } = useRadarPlanoSucessao(aberto ? eventoId : null);
  const estadoPlano = estadoDeLeitura(plano);
  const estadoItens = estadoDeLeitura(itens);

  useEffect(() => {
    if (aberto) track('radar.sucessao_plano_aberto', { lente: isImpersonating });
  }, [aberto, isImpersonating]);

  return (
    <Sheet open={aberto} onOpenChange={(o) => { if (!o) onFechar(); }}>
      <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto" data-testid="radar-sucessao-plano">
        <SheetHeader>
          <SheetTitle>Plano de rateio do histórico</SheetTitle>
          <SheetDescription>
            Para cada item que a empresa antiga comprou antes do corte, diga qual empresa nova herda o histórico. Item
            sem destino fica com a antiga. Não muda pedido, preço nem financeiro: só de quem é o histórico nas
            sugestões de venda.
          </SheetDescription>
        </SheetHeader>
        <div className="mt-4 space-y-4">
          {(estadoPlano === 'carregando' || estadoItens === 'carregando') && (
            <div className="space-y-2"><Skeleton className="h-5 w-64" /><Skeleton className="h-40 w-full" /></div>
          )}
          {(naoConsegui(estadoPlano) || naoConsegui(estadoItens)) && (
            <AvisoLeituraFalhou oque="o plano de rateio desta sucessão"
              estado={naoConsegui(estadoPlano) ? estadoPlano : estadoItens} className="mb-0" />
          )}
          {plano.data && itens.data && !itens.data.ativo && (
            <EmptyState icon={Inbox} title="Sucessão sem declaração ativa"
              description="Todas as declarações deste evento foram revogadas: não há histórico para ratear." />
          )}
          {plano.data && itens.data?.ativo && (
            <Editor key={`${plano.data.revisao}`} plano={plano.data} itens={itens.data.itens}
              destinos={itens.data.destinos} antigoNome={itens.data.antigoNome ?? itens.data.antigoDocumento}
              tipo={itens.data.tipo} dataCorte={itens.data.dataCorte} antigoResolvido={itens.data.antigoResolvido}
              sugestoesHoje={itens.data.sugestoesHoje} somenteLeitura={isImpersonating} />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Editor({ plano, itens, destinos, antigoNome, tipo, dataCorte, antigoResolvido, sugestoesHoje, somenteLeitura }: {
  plano: PlanoDoEvento; itens: ItemDaAntiga[]; destinos: DestinoDoEvento[]; antigoNome: string | null;
  tipo: 'cisao' | 'sucessao' | null; dataCorte: string | null; antigoResolvido: boolean;
  sugestoesHoje: { herdadas: number; mostradas: number } | null; somenteLeitura: boolean;
}) {
  const inicial = useMemo(() => rascunhoDoPlano(plano), [plano]);
  const [rascunho, setRascunho] = useState<Rascunho>(inicial);
  const [motivo, setMotivo] = useState('');
  const publicar = useRadarPublicarPlano();
  const familias = useMemo(
    () => [...new Set(itens.map((i) => i.familia).filter((f): f is string => !!f))].sort((a, b) => a.localeCompare(b)),
    [itens],
  );
  const mudou = !mesmoRascunho(rascunho, inicial);
  // Destino que saiu da sucessão (declaração revogada depois do plano): o rascunho ainda o tem, e o servidor recusaria
  // (destino_fora_do_evento). A tela MOSTRA o valor real e trava a publicação até o gestor escolher outro (Codex, P2).
  const validos = new Set(destinos.map((d) => d.novoDocumento));
  const invalidos = itens.filter((i) => rascunho[chaveItem(i)] && !validos.has(rascunho[chaveItem(i)])).length
    + Object.keys(rascunho).filter((k) => !itens.some((i) => chaveItem(i) === k) && !validos.has(rascunho[k])).length;
  const vazio = Object.keys(rascunho).length === 0;
  const vigente = plano.revisao > 0 && !plano.revogado;
  const ultima = plano.revisoes[0] ?? null;

  const enviar = async () => {
    try {
      const r = await publicar.mutateAsync({
        eventoId: plano.eventoId, revisao: plano.revisao, regras: regrasDoRascunho(rascunho),
        motivo: motivo.trim() || null,
      });
      if (!r.ok) { toast.info(mensagemRecusaPlano(r)); return; }
      toast.success(`Plano publicado (revisão ${r.revisao})`, { description: AVISO_REPROCESSO });
      setMotivo('');
    } catch (e) {
      toast.error('Não foi possível publicar o plano', { description: e instanceof Error ? e.message : undefined });
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded border p-3 text-sm space-y-1" data-testid="radar-plano-estado">
        <div className="font-medium">
          {tipo === 'sucessao' ? 'Sucessão' : 'Cisão'} de {antigoNome ?? 'cliente da base'} · corte em {dataBr(dataCorte)}
        </div>
        <div className={cn('text-xs', vigente ? 'text-status-success' : 'text-muted-foreground')}>
          {plano.revisao === 0 && 'Sem plano publicado: todo o histórico fica com a antiga.'}
          {plano.revogado && `Plano revogado (revisão ${plano.revisao}): todo o histórico voltou para a antiga.`}
          {vigente && `Plano vigente: revisão ${plano.revisao}, ${ultima?.regras ?? 0} item(ns), publicado por `
            + `${ultima?.publicadoPorNome ?? 'alguém da gestão'} em ${dataBr(ultima?.publicadoEm ?? null)}.`}
        </div>
        {sugestoesHoje && (
          <div className="text-xs text-muted-foreground" data-testid="radar-plano-sensor">
            Hoje: {sugestoesHoje.herdadas} sugestão(ões) herdada(s) na lista dos vendedores
            · {sugestoesHoje.mostradas} já mostrada(s).
          </div>
        )}
        {destinos.filter((d) => d.estado !== 'ativa').map((d) => (
          <div key={d.destinoSucessaoId} className="text-xs text-status-warning">
            {d.novoNome ?? d.novoDocumento} ainda não herda
            {d.impedimento === 'novo_sem_cadastro' ? ': falta o cadastro no Omie' : d.impedimento === 'corte_futuro'
              ? ': a data de corte ainda não chegou' : ''}. Os itens dele ficam com a antiga até lá.
          </div>
        ))}
        {!antigoResolvido && (
          <div className="text-xs text-status-error">
            O CNPJ antigo não aponta para um cliente único no cadastro: o plano não pode ser publicado.
          </div>
        )}
      </div>

      {itens.length === 0 ? (
        <EmptyState icon={Inbox} title="Nenhuma compra antes do corte"
          description="A empresa antiga não tem pedido antes da data de corte: não há histórico para passar adiante." />
      ) : (
        <>
          {familias.length > 0 && !somenteLeitura && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-muted-foreground">Família inteira:</span>
              {familias.map((f) => (
                <label key={f} className="flex items-center gap-1 rounded border px-1.5 py-0.5">
                  {f}
                  <select aria-label={`Destino da família ${f}`} className="bg-transparent text-xs"
                    value="" onChange={(e) => {
                      setRascunho(aplicarFamilia(rascunho, itens, f, e.target.value || null));
                    }}>
                    <option value="" disabled>aplicar…</option>
                    <option value={FICA}>fica com a antiga</option>
                    {destinos.map((d) => (
                      <option key={d.novoDocumento} value={d.novoDocumento}>{d.novoNome ?? d.novoDocumento}</option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          )}
          <ul className="divide-y rounded border text-sm" data-testid="radar-plano-itens">
            {itens.map((i) => {
              const k = chaveItem(i);
              return (
                <li key={k} className="flex items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate">{i.descricao ?? `Código ${i.omieCodigoProduto}`}</div>
                    <div className="text-xs text-muted-foreground">
                      {i.empresa} · {i.familia ?? 'sem família'} · {i.pedidos} pedido(s) · último em {dataBr(i.ultimoPedido)}
                    </div>
                  </div>
                  <select aria-label={`Destino de ${i.descricao ?? i.omieCodigoProduto}`} disabled={somenteLeitura}
                    className="h-8 max-w-[12rem] rounded border bg-background px-1 text-xs"
                    value={rascunho[k] ?? FICA}
                    onChange={(e) => {
                      const n = { ...rascunho };
                      if (e.target.value) n[k] = e.target.value; else delete n[k];
                      setRascunho(n);
                    }}>
                    <option value={FICA}>Fica com a antiga</option>
                    {rascunho[k] && !validos.has(rascunho[k]) && (
                      <option value={rascunho[k]}>{rascunho[k]} (saiu da sucessão)</option>
                    )}
                    {destinos.map((d) => (
                      <option key={d.novoDocumento} value={d.novoDocumento}>
                        {d.novoNome ?? d.novoDocumento}{d.estado !== 'ativa' ? ' (pendente)' : ''}
                      </option>
                    ))}
                  </select>
                </li>
              );
            })}
          </ul>
          {invalidos > 0 && (
            <p className="text-xs text-status-error" data-testid="radar-plano-invalidos">
              {invalidos} item(ns) apontam para uma empresa que saiu da sucessão: escolha outro destino ou
              "Fica com a antiga" antes de publicar.
            </p>
          )}
          <p className="text-xs text-muted-foreground" data-testid="radar-plano-resumo">
            {resumoRascunho(rascunho, itens, destinos)}
          </p>
        </>
      )}

      {somenteLeitura ? (
        <p className="text-xs text-muted-foreground" data-testid="radar-plano-lente">
          Na lente "Ver como" o plano é só leitura.
        </p>
      ) : (
        <div className="space-y-2">
          <Label htmlFor="plano-motivo">Motivo desta revisão (opcional)</Label>
          <Textarea id="plano-motivo" rows={2} value={motivo} onChange={(e) => setMotivo(e.target.value)} />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={!mudou || vazio || !antigoResolvido || invalidos > 0 || publicar.isPending}
              onClick={enviar}
              data-testid="radar-plano-publicar">
              {publicar.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />} Publicar revisão {plano.revisao + 1}
            </Button>
            {vigente && <RevogarPlano eventoId={plano.eventoId} revisao={plano.revisao} />}
            {vazio && mudou && (
              <span className="text-xs text-muted-foreground">Para devolver tudo à antiga, revogue o plano.</span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{AVISO_REPROCESSO} Sugestão já mostrada ao vendedor não muda.</p>
        </div>
      )}

      {plano.revisoes.length > 0 && (
        <div className="space-y-1">
          <div className="text-xs font-medium">Histórico das revisões</div>
          <ul className="space-y-0.5 text-xs text-muted-foreground" data-testid="radar-plano-revisoes">
            {plano.revisoes.map((v) => (
              <li key={v.revisao}>
                Revisão {v.revisao} · {v.revoga ? 'revogou o plano' : `${v.regras} item(ns)`} · {v.publicadoPorNome
                  ?? 'alguém da gestão'} em {dataBr(v.publicadoEm)}{v.motivo ? `: ${v.motivo}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function RevogarPlano({ eventoId, revisao }: { eventoId: string; revisao: number }) {
  const [aberto, setAberto] = useState(false);
  const [motivo, setMotivo] = useState('');
  const revogar = useRadarRevogarPlano();
  const confirmar = async () => {
    try {
      const r = await revogar.mutateAsync({ eventoId, revisao, motivo: motivo.trim() });
      if (!r.ok) { toast.info(mensagemRecusaPlano(r)); return; }
      toast.success('Plano revogado: o histórico volta todo para a antiga', { description: AVISO_REPROCESSO });
      setAberto(false); setMotivo('');
    } catch (e) {
      toast.error('Não foi possível revogar o plano', { description: e instanceof Error ? e.message : undefined });
    }
  };
  return (
    <Popover open={aberto} onOpenChange={setAberto}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" data-testid="radar-plano-revogar">Revogar plano</Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 space-y-2">
        <Label htmlFor="plano-revogar-motivo">Por que revogar o plano?</Label>
        <Textarea id="plano-revogar-motivo" rows={2} value={motivo} onChange={(e) => setMotivo(e.target.value)} />
        <Button size="sm" variant="destructive" disabled={!motivo.trim() || revogar.isPending} onClick={confirmar}
          data-testid="radar-plano-revogar-confirmar">
          {revogar.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />} Revogar plano
        </Button>
      </PopoverContent>
    </Popover>
  );
}
