// src/components/tarefas/VozTarefaDialog.tsx
import { useState, useEffect, useCallback } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Mic, Square, Loader2, Sparkles, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { invokeFunction } from '@/lib/invoke-function';
import { spBusinessDate } from '@/lib/time/sp-day';
import { useGravacaoTranscricao } from '@/hooks/useGravacaoTranscricao';
import { useBuscaClienteOmie } from '@/hooks/useBuscaClienteOmie';
import { useTarefaMutations } from '@/hooks/useTarefas';
import { autoSatisfyDaCategoria } from '@/lib/tarefas/categoria-map';
import { montarRascunhos } from '@/lib/tarefas/voz/montar-rascunhos';
import { casarCliente } from '@/lib/tarefas/voz/match';
import { validarRascunho } from '@/lib/tarefas/voz/validacao';
import type { ExtracaoVozIA, RascunhoVoz, VendedoraOpcao } from '@/lib/tarefas/voz/types';
import type { TarefaCategoria, TarefaModo, TarefaInteracaoTipo } from '@/lib/tarefas/types';

export function VozTarefaDialog({ open, onOpenChange, vendedoras, empresa }: {
  open: boolean; onOpenChange: (o: boolean) => void;
  vendedoras: VendedoraOpcao[]; empresa: string;
}) {
  const { isRecording, isTranscribing, transcricao, setTranscricao, toggle, reset } = useGravacaoTranscricao();
  const { buscar } = useBuscaClienteOmie();
  const { criarTarefas } = useTarefaMutations();
  const [extraindo, setExtraindo] = useState(false);
  const [rascunhos, setRascunhos] = useState<RascunhoVoz[] | null>(null);
  const [naoCoberto, setNaoCoberto] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);
  const hojeSP = spBusinessDate(new Date());

  // reset ao fechar
  useEffect(() => { if (!open) { reset(); setRascunhos(null); setNaoCoberto(null); } }, [open, reset]);

  const resolverClienteDoCard = useCallback(async (r: RascunhoVoz): Promise<RascunhoVoz> => {
    if (!r.cliente_nome_falado) return { ...r, cliente: { customer_user_id: null, nome: null, status: 'sem_match', candidatos: [] } };
    const achados = await buscar(r.cliente_nome_falado);
    const cands = achados.map((a) => ({ customer_user_id: a.user_id, nome: a.nome }));
    return { ...r, cliente: casarCliente(r.cliente_nome_falado, cands) };
  }, [buscar]);

  const extrair = async () => {
    if (!transcricao.trim()) { toast.error('Grave ou digite o comando primeiro.'); return; }
    setExtraindo(true);
    try {
      const out = await invokeFunction<ExtracaoVozIA>('tarefa-extrair-voz', {
        transcricao: transcricao.trim(), hoje: hojeSP, tz: 'America/Sao_Paulo',
        vendedoras: vendedoras.map((v) => ({ nome: v.nome })),
      });
      const base = montarRascunhos(out, { hojeSP, vendedoras });
      const comCliente = await Promise.all(base.map(resolverClienteDoCard));
      setRascunhos(comCliente);
      setNaoCoberto(out.texto_nao_coberto);
      if (comCliente.length === 0) toast.warning('Não detectei nenhuma tarefa. Revise o texto.');
    } catch (e) {
      // degradação: não perde a fala — vira 1 rascunho cru pra ele preencher
      setRascunhos([{
        evidence_text: transcricao, descricao: transcricao, categoria: 'outro',
        cliente_nome_falado: null, cliente: { customer_user_id: null, nome: null, status: 'sem_match', candidatos: [] },
        vendedora: { user_id: null, nome: null, status: 'sem_match' },
        data: { modo: 'interacao', due_date: null, interacao_tipo: 'ligacao', status: 'sem_data' },
        target_texto: null,
      }]);
      toast.error('Não consegui estruturar — revise/preencha manualmente.', { description: e instanceof Error ? e.message : undefined });
    } finally { setExtraindo(false); }
  };

  const patch = (i: number, p: Partial<RascunhoVoz>) =>
    setRascunhos((rs) => rs ? rs.map((r, idx) => idx === i ? { ...r, ...p } : r) : rs);

  const buscarTrocaCliente = async (i: number, query: string) => {
    const r = rascunhos?.[i]; if (!r) return;
    const achados = await buscar(query);
    const cands = achados.map((a) => ({ customer_user_id: a.user_id, nome: a.nome }));
    patch(i, { cliente: casarCliente(query || r.cliente_nome_falado || '', cands) });
  };

  const salvar = async () => {
    if (!rascunhos) return;
    const validos = rascunhos.map((r) => ({ r, v: validarRascunho(r, hojeSP) }));
    const comErro = validos.filter((x) => !x.v.ok);
    if (comErro.length > 0) { toast.error(`Corrija ${comErro.length} tarefa(s) antes de salvar.`); return; }
    setSalvando(true);
    try {
      // agrupa por cliente (criarTarefas é por cliente). Aqui criamos uma chamada por card
      // (simples e correto; cada card tem seu cliente).
      for (const r of rascunhos) {
        await criarTarefas([{
          descricao: r.descricao, categoria: r.categoria, customer_user_id: r.cliente!.customer_user_id,
          assigned_to: r.vendedora.user_id, empresa, modo: r.data.modo,
          due_date: r.data.modo === 'data' ? r.data.due_date : null,
          interacao_tipo: r.data.modo === 'interacao' ? (r.data.interacao_tipo ?? 'ligacao') : null,
          auto_satisfy_mode: autoSatisfyDaCategoria(r.categoria),
          target_texto: (r.categoria === 'oferecer' || r.categoria === 'preco') ? r.target_texto : null,
        }], { transcricao, evidencias: [r.evidence_text] });
      }
      onOpenChange(false);
    } finally { setSalvando(false); }
  };

  const statusBadge = (s: string) =>
    s === 'unico' ? null
    : <Badge variant="outline" className="text-status-warning">{s === 'ambiguo' ? 'confirme' : 'não encontrado'}</Badge>;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Criar tarefa por voz</DialogTitle></DialogHeader>

        {/* Gravação / texto */}
        <div className="space-y-2">
          <div className="relative">
            <Textarea value={transcricao} onChange={(e) => setTranscricao(e.target.value)} disabled={isTranscribing}
              placeholder="Grave ou digite: ex. manda a Regina ligar pra Padaria do Zé amanhã e oferecer a linha nova"
              className="min-h-[90px] pr-12" />
            <button type="button" onClick={toggle} disabled={isTranscribing}
              className={`absolute right-2 top-2 p-2 rounded-full ${isRecording ? 'bg-destructive text-destructive-foreground animate-pulse' : 'bg-muted'}`}>
              {isRecording ? <Square className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            </button>
          </div>
          {isTranscribing && <p className="text-2xs text-muted-foreground flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Transcrevendo…</p>}
          <Button onClick={extrair} disabled={!transcricao.trim() || extraindo || isRecording} className="w-full">
            {extraindo ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Estruturando…</> : <><Sparkles className="w-4 h-4 mr-2" />Detectar tarefas</>}
          </Button>
        </div>

        {/* Revisão */}
        {rascunhos && (
          <div className="space-y-3 mt-2">
            <p className="text-2xs text-muted-foreground">
              Detectei <strong>{rascunhos.length}</strong> tarefa(s).
              {naoCoberto && <span className="text-status-warning"> Não cobri: "{naoCoberto}".</span>}
            </p>
            {rascunhos.map((r, i) => {
              const erros = validarRascunho(r, hojeSP).erros;
              return (
                <div key={i} className={`rounded-md border p-3 space-y-2 ${erros.length ? 'border-status-warning/50' : 'border-border'}`}>
                  <div className="flex items-start justify-between gap-2">
                    <Textarea value={r.descricao} onChange={(e) => patch(i, { descricao: e.target.value })} className="min-h-[40px] text-sm" />
                    <Button size="icon" variant="ghost" onClick={() => setRascunhos((rs) => rs!.filter((_, idx) => idx !== i))}><Trash2 className="w-4 h-4" /></Button>
                  </div>

                  {/* Vendedora */}
                  <div className="flex items-center gap-2">
                    <Select value={r.vendedora.user_id ?? ''} onValueChange={(v) => patch(i, { vendedora: { user_id: v, nome: vendedoras.find((x) => x.user_id === v)?.nome ?? null, status: 'unico' } })}>
                      <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Vendedora" /></SelectTrigger>
                      <SelectContent>{vendedoras.map((v) => <SelectItem key={v.user_id} value={v.user_id}>{v.nome}</SelectItem>)}</SelectContent>
                    </Select>
                    {statusBadge(r.vendedora.status)}
                  </div>

                  {/* Cliente */}
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium truncate">{r.cliente?.customer_user_id ? r.cliente.nome : 'Cliente não definido'}</span>
                      {r.cliente_nome_falado && <span className="text-2xs text-muted-foreground">(falado: "{r.cliente_nome_falado}")</span>}
                      {r.cliente && statusBadge(r.cliente.status)}
                    </div>
                    {(!r.cliente || r.cliente.status !== 'unico') && (
                      <ClienteSwap candidatos={r.cliente?.candidatos ?? []} onPick={(cid, nome) => patch(i, { cliente: { customer_user_id: cid, nome, status: 'unico', candidatos: r.cliente?.candidatos ?? [] } })} onBuscar={(q) => buscarTrocaCliente(i, q)} />
                    )}
                  </div>

                  {/* Categoria + target */}
                  <div className="flex items-center gap-2">
                    <Select value={r.categoria} onValueChange={(v) => patch(i, { categoria: v as TarefaCategoria })}>
                      <SelectTrigger className="h-8 text-xs w-32"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ligar">Ligar</SelectItem><SelectItem value="oferecer">Oferecer</SelectItem>
                        <SelectItem value="preco">Passar preço</SelectItem><SelectItem value="whatsapp">WhatsApp</SelectItem>
                        <SelectItem value="outro">Outro</SelectItem>
                      </SelectContent>
                    </Select>
                    {(r.categoria === 'oferecer' || r.categoria === 'preco') && (
                      <Input className="h-8 text-xs" placeholder="item/preço" value={r.target_texto ?? ''} onChange={(e) => patch(i, { target_texto: e.target.value })} />
                    )}
                  </div>

                  {/* Prazo */}
                  <div className="flex items-center gap-2">
                    <Select value={r.data.modo} onValueChange={(v) => patch(i, { data: { ...r.data, modo: v as TarefaModo, status: v === 'interacao' ? 'sem_data' : r.data.status } })}>
                      <SelectTrigger className="h-8 text-xs w-36"><SelectValue /></SelectTrigger>
                      <SelectContent><SelectItem value="data">Data fixa</SelectItem><SelectItem value="interacao">Próxima interação</SelectItem></SelectContent>
                    </Select>
                    {r.data.modo === 'data'
                      ? <Input type="date" className="h-8 text-xs" value={r.data.due_date ?? ''} onChange={(e) => patch(i, { data: { ...r.data, due_date: e.target.value, status: 'resolvida' } })} />
                      : <Select value={r.data.interacao_tipo ?? 'ligacao'} onValueChange={(v) => patch(i, { data: { ...r.data, interacao_tipo: v as TarefaInteracaoTipo } })}>
                          <SelectTrigger className="h-8 text-xs w-32"><SelectValue /></SelectTrigger>
                          <SelectContent><SelectItem value="ligacao">Próxima ligação</SelectItem><SelectItem value="visita">Próxima visita</SelectItem><SelectItem value="entrega">Próxima entrega</SelectItem></SelectContent>
                        </Select>}
                    {(r.data.status === 'ambigua' || r.data.status === 'nao_resolvida' || r.data.status === 'passado') &&
                      <Badge variant="outline" className="text-status-warning">confirme o prazo</Badge>}
                  </div>

                  {erros.length > 0 && <p className="text-2xs text-status-warning">{erros.join(' ')}</p>}
                </div>
              );
            })}
          </div>
        )}

        <DialogFooter>
          {rascunhos && rascunhos.length > 0 && (
            <Button onClick={salvar} disabled={salvando}>
              {salvando ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Criar {rascunhos.length} tarefa(s)
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Mini-busca de cliente pra trocar o match (reusa o picker Omie). */
function ClienteSwap({ candidatos, onPick, onBuscar }: {
  candidatos: { customer_user_id: string; nome: string }[];
  onPick: (cid: string, nome: string) => void;
  onBuscar: (q: string) => void;
}) {
  const [q, setQ] = useState('');
  useEffect(() => { const t = setTimeout(() => { if (q.length >= 2) onBuscar(q); }, 300); return () => clearTimeout(t); }, [q, onBuscar]);
  const lista = candidatos.filter((c) => c.customer_user_id);
  return (
    <div className="space-y-1">
      <div className="relative">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
        <Input className="h-7 pl-7 text-xs" placeholder="Buscar cliente…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {lista.length > 0 && (
        <div className="border rounded max-h-32 overflow-y-auto">
          {lista.map((c) => (
            <button key={c.customer_user_id} onClick={() => onPick(c.customer_user_id, c.nome)}
              className="w-full text-left px-2 py-1 text-xs hover:bg-muted/50 border-b last:border-b-0">{c.nome}</button>
          ))}
        </div>
      )}
    </div>
  );
}
