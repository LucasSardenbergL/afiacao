import { useState } from 'react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useTarefaMutations } from '@/hooks/useTarefas';
import { autoSatisfyDaCategoria } from '@/lib/tarefas/categoria-map';
import type { TarefaCategoria, TarefaModo, TarefaInteracaoTipo } from '@/lib/tarefas/types';

type Rascunho = {
  descricao: string; categoria: TarefaCategoria; modo: TarefaModo;
  due_date?: string; interacao_tipo?: TarefaInteracaoTipo; target_texto?: string;
};

export function CriarTarefaDialog({ open, onOpenChange, cliente, assignedTo, empresa }: {
  open: boolean; onOpenChange: (o: boolean) => void;
  cliente: { customer_user_id: string; nome: string } | null;
  assignedTo: string; empresa: string;
}) {
  const { criarTarefas } = useTarefaMutations();
  const [rascunhos, setRascunhos] = useState<Rascunho[]>([]);
  const [atual, setAtual] = useState<Rascunho>({ descricao: '', categoria: 'ligar', modo: 'interacao', interacao_tipo: 'ligacao' });
  const [saving, setSaving] = useState(false);

  const addRascunho = () => { if (atual.descricao.trim()) { setRascunhos([...rascunhos, atual]); setAtual({ descricao: '', categoria: 'ligar', modo: 'interacao', interacao_tipo: 'ligacao' }); } };

  const salvar = async () => {
    if (!cliente) return;
    const todos = atual.descricao.trim() ? [...rascunhos, atual] : rascunhos;
    if (todos.length === 0) return;
    setSaving(true);
    try {
      await criarTarefas(todos.map(r => ({
        descricao: r.descricao, categoria: r.categoria, customer_user_id: cliente.customer_user_id,
        assigned_to: assignedTo, empresa, modo: r.modo,
        due_date: r.modo === 'data' ? (r.due_date ?? null) : null,
        interacao_tipo: r.modo === 'interacao' ? (r.interacao_tipo ?? 'ligacao') : null,
        auto_satisfy_mode: autoSatisfyDaCategoria(r.categoria),
        target_texto: (r.categoria === 'oferecer' || r.categoria === 'preco') ? (r.target_texto ?? null) : null,
      })));
      setRascunhos([]); onOpenChange(false);
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Nova tarefa{cliente ? ` — ${cliente.nome}` : ''}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <Textarea placeholder="O que a vendedora precisa fazer?" value={atual.descricao}
            onChange={(e) => setAtual({ ...atual, descricao: e.target.value })} />
          <Select value={atual.categoria} onValueChange={(v) => setAtual({ ...atual, categoria: v as TarefaCategoria })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ligar">Ligar</SelectItem>
              <SelectItem value="oferecer">Oferecer item</SelectItem>
              <SelectItem value="preco">Passar preço</SelectItem>
              <SelectItem value="whatsapp">Mandar WhatsApp</SelectItem>
              <SelectItem value="outro">Outro</SelectItem>
            </SelectContent>
          </Select>
          {(atual.categoria === 'oferecer' || atual.categoria === 'preco') && (
            <Input placeholder="Qual item / preço (o app procura isso na transcrição)" value={atual.target_texto ?? ''}
              onChange={(e) => setAtual({ ...atual, target_texto: e.target.value })} />
          )}
          <Select value={atual.modo} onValueChange={(v) => setAtual({ ...atual, modo: v as TarefaModo })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="interacao">Na próxima interação</SelectItem>
              <SelectItem value="data">Data fixa</SelectItem>
            </SelectContent>
          </Select>
          {atual.modo === 'data'
            ? <Input type="date" value={atual.due_date ?? ''} onChange={(e) => setAtual({ ...atual, due_date: e.target.value })} />
            : <Select value={atual.interacao_tipo ?? 'ligacao'} onValueChange={(v) => setAtual({ ...atual, interacao_tipo: v as TarefaInteracaoTipo })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ligacao">Próxima ligação</SelectItem>
                  <SelectItem value="visita">Próxima visita</SelectItem>
                  <SelectItem value="entrega">Próxima entrega</SelectItem>
                </SelectContent>
              </Select>}
          <Button variant="outline" size="sm" onClick={addRascunho} disabled={!atual.descricao.trim()}>+ Adicionar outra pra este cliente</Button>
          {rascunhos.length > 0 && <p className="text-2xs text-muted-foreground">{rascunhos.length} tarefa(s) na fila + a atual</p>}
        </div>
        <DialogFooter>
          <Button onClick={salvar} disabled={saving || !cliente || (!atual.descricao.trim() && rascunhos.length === 0)}>
            Salvar {rascunhos.length + (atual.descricao.trim() ? 1 : 0)} tarefa(s)
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
