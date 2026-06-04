import { useMemo, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Check, MessageSquare, Clock, AlertTriangle } from 'lucide-react';
import { useMinhasTarefas, useTarefaSugestoes, useTarefaMutations } from '@/hooks/useTarefas';
import { buildWhatsappTaskMessage, buildWaMeUrl } from '@/lib/tarefas/whatsapp';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import type { TarefaEstado } from '@/lib/tarefas/types';

export function MinhasTarefasCard() {
  const { isImpersonating } = useImpersonation();  // "Ver como" = somente leitura
  const { data: tarefas = [], isLoading } = useMinhasTarefas();
  const ids = useMemo(() => tarefas.map(t => t.id), [tarefas]);
  const { data: sugestoes = [] } = useTarefaSugestoes(ids);
  const { concluir, resolverSugestao, adiar } = useTarefaMutations();
  const [adiarAlvo, setAdiarAlvo] = useState<TarefaEstado | null>(null);
  const [adiarData, setAdiarData] = useState('');
  const [adiarMotivo, setAdiarMotivo] = useState('');

  if (isLoading || tarefas.length === 0) return null; // empty → não polui o topo

  const sugByTarefa = new Map<string, typeof sugestoes[number]>();
  for (const s of sugestoes) if (!sugByTarefa.has(s.tarefa_id)) sugByTarefa.set(s.tarefa_id, s);

  const onWhats = (t: TarefaEstado) => {
    window.open(buildWaMeUrl(null, buildWhatsappTaskMessage(t)), '_blank');
    concluir(t.id, 'whatsapp');
  };

  return (
    <Card className="p-4 border-status-warning/40">
      <div className="flex items-center gap-2 mb-3">
        <Clock className="w-4 h-4" />
        <h2 className="font-display text-lg">Minhas tarefas</h2>
        <span className="text-2xs text-muted-foreground">{tarefas.length}</span>
        {isImpersonating && <span className="ml-auto text-2xs text-muted-foreground">Somente leitura (Ver como)</span>}
      </div>
      <ul className="space-y-2">
        {tarefas.map(t => {
          const sug = sugByTarefa.get(t.id);
          return (
            <li key={t.id} className={`rounded-md border p-3 ${t.atrasada ? 'border-status-error/40 bg-status-error-bg' : 'border-border'}`}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-medium">{t.descricao}</p>
                  <p className="text-2xs text-muted-foreground">
                    {t.atrasada && <AlertTriangle className="inline w-3 h-3 text-status-error mr-1" />}
                    {t.categoria} · vence {t.effective_due}
                  </p>
                </div>
                <div className="flex gap-1 shrink-0">
                  {t.categoria === 'whatsapp'
                    ? <Button size="sm" variant="outline" disabled={isImpersonating} onClick={() => onWhats(t)}><MessageSquare className="w-3 h-3 mr-1" />Mandar</Button>
                    : <Button size="sm" variant="outline" disabled={isImpersonating} onClick={() => concluir(t.id, 'manual')}><Check className="w-3 h-3 mr-1" />Feito</Button>}
                  <Button size="sm" variant="ghost" disabled={isImpersonating} onClick={() => { setAdiarAlvo(t); setAdiarData(''); setAdiarMotivo(''); }}>Adiar</Button>
                </div>
              </div>
              {sug && (
                <div className="mt-2 rounded-md bg-status-info-bg border border-status-info/40 p-2">
                  <p className="text-2xs">{sug.motivo ?? 'Possível cumprimento detectado'} — confirma?</p>
                  <div className="flex gap-1 mt-1">
                    <Button size="sm" disabled={isImpersonating} onClick={() => resolverSugestao(sug.id, t.id, true)}>Sim, fiz</Button>
                    <Button size="sm" variant="ghost" disabled={isImpersonating} onClick={() => resolverSugestao(sug.id, t.id, false)}>Não</Button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <Dialog open={!!adiarAlvo} onOpenChange={(o) => !o && setAdiarAlvo(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Adiar tarefa</DialogTitle></DialogHeader>
          <div className="space-y-2">
            <Input type="date" value={adiarData} onChange={(e) => setAdiarData(e.target.value)} />
            <Textarea placeholder="Motivo (ex: cliente pediu pra semana que vem)" value={adiarMotivo} onChange={(e) => setAdiarMotivo(e.target.value)} />
          </div>
          <DialogFooter>
            <Button disabled={!adiarData || !adiarMotivo} onClick={async () => {
              if (!adiarAlvo) return;
              await adiar(adiarAlvo.id, new Date(adiarData + 'T12:00:00').toISOString(), adiarMotivo);
              setAdiarAlvo(null);
            }}>Adiar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
