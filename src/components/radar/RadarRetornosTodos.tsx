import { CalendarClock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { AvisoLeituraFalhou } from '@/components/leitura/AvisoLeituraFalhou';
import { estadoDeLeitura } from '@/lib/leitura/estado-de-leitura';
import { mensagemDeErro } from '@/lib/erro-mensagem';
import { nomeDoLead, tituloMunicipio } from '@/lib/radar/prospectar-hoje';
import { useRadarMeusRetornos } from '@/queries/useRadarMeusRetornos';

/**
 * "Ver todos" da agenda "Hoje" (revisão 2026-11-11, item 8): a agenda mostra os 20 primeiros retornos e dizia "+N além
 * destes" sem onde lê-los. Aqui a lista inteira, por vencimento (mais antigo primeiro), em páginas de 50.
 */
export function RadarRetornosTodos({ aberto, onFechar, onAbrir }: {
  aberto: boolean;
  onFechar: () => void;
  onAbrir: (cnpj: string) => void;
}) {
  const q = useRadarMeusRetornos(aberto);
  const itens = q.data?.pages.flatMap((p) => p.itens) ?? [];
  const total = q.data?.pages[0]?.total ?? null;
  const estado = estadoDeLeitura(q);
  return (
    <Dialog open={aberto} onOpenChange={(v) => { if (!v) onFechar(); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto" data-testid="radar-retornos-todos">
        <DialogHeader>
          <DialogTitle>Todos os seus retornos{total != null ? ` (${total})` : ''}</DialogTitle>
          <DialogDescription>Vencidos até hoje, do mais antigo para o mais novo. Toque para abrir a ficha.</DialogDescription>
        </DialogHeader>
        {estado === 'sem-rede' || (q.isError && itens.length === 0) ? (
          q.isError
            ? <p className="text-xs text-status-error">Não consegui ler seus retornos ({mensagemDeErro(q.error) ?? 'erro de leitura'}).</p>
            : <AvisoLeituraFalhou oque="seus retornos" estado="sem-rede" />
        ) : q.isLoading ? (
          <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
        ) : itens.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhum retorno vencido.</p>
        ) : (
          <ul className="space-y-1">
            {itens.map((r) => (
              <li key={r.cnpj}>
                <button type="button" onClick={() => onAbrir(r.cnpj)} data-testid="radar-retorno-todos-item"
                  className="w-full text-left rounded px-2 py-1.5 hover:bg-muted flex flex-wrap items-center gap-x-2 text-sm min-h-11">
                  <CalendarClock className="w-4 h-4 shrink-0 text-status-info" />
                  <span className="font-medium truncate">{nomeDoLead(r)}</span>
                  <span className="text-xs text-muted-foreground">
                    {r.retornoEm.slice(8, 10)}/{r.retornoEm.slice(5, 7)}
                    {r.municipioNome ? ` · ${tituloMunicipio(r.municipioNome)}` : ''}
                  </span>
                  {r.atrasado && <span className="text-xs text-status-warning">atrasado</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        {q.hasNextPage && (
          <Button variant="outline" size="sm" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            {q.isFetchingNextPage ? 'Carregando…' : 'Carregar mais'}
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}
