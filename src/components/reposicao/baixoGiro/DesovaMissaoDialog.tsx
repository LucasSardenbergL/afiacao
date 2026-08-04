// Missão de desova (programa Cabreúva-Colacor, PR2 — fase 1 SEM preço): a fila de
// excesso vira TAREFA rastreável pro comercial via o writer canônico de tarefas
// (useTarefaMutations.criarTarefas — insert + track + invalidate). categoria 'outro'
// → auto_satisfy 'off' (conclusão manual, humano no loop); customer_user_id null
// (missão é SKU-cêntrica). Preço NÃO é tocado aqui — desconto/queima é decisão do
// comercial na ponta; a fase 2 (campanha com piso) fica pro épico.
import { useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useSalespeople } from '@/hooks/useCoverage';
import { useTarefaMutations } from '@/hooks/useTarefas';
import { autoSatisfyDaCategoria } from '@/lib/tarefas/categoria-map';
import { formatarMissaoDesova } from '@/lib/reposicao/desova-helpers';
import { track } from '@/lib/analytics';
import type { RowExcesso } from './types';

function dataMaisDias(dias: number): string {
  const d = new Date(Date.now() + dias * 86400000);
  return d.toISOString().slice(0, 10);
}

export function DesovaMissaoDialog({ open, onOpenChange, alvos, empresa }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  alvos: RowExcesso[];
  empresa: string; // convenção de tarefas: lowercase ('oben')
}) {
  const { data: salespeople = [] } = useSalespeople();
  const { criarTarefas } = useTarefaMutations();
  const [assignedTo, setAssignedTo] = useState('');
  const [dueDate, setDueDate] = useState(() => dataMaisDias(14));
  const [saving, setSaving] = useState(false);

  const missao = useMemo(() => formatarMissaoDesova(alvos.map((a) => ({
    sku_codigo_omie: a.sku_codigo_omie,
    sku_descricao: a.sku_descricao,
    excedente_un: a.excedente_un,
    capital_excedente: a.capital_excedente,
    tempo_digerir_dias: a.tempo_digerir_dias,
    dias_sem_vender: a.dias_sem_vender,
  }))), [alvos]);

  const salvar = async () => {
    if (!assignedTo || alvos.length === 0) return;
    setSaving(true);
    try {
      await criarTarefas([{
        descricao: missao.descricao,
        categoria: 'outro',
        customer_user_id: null,
        assigned_to: assignedTo,
        empresa,
        modo: 'data',
        due_date: dueDate || null,
        interacao_tipo: null,
        auto_satisfy_mode: autoSatisfyDaCategoria('outro'),
        target_texto: null,
      }]);
      track('reposicao.desova_missao_criada', {
        skus: alvos.length,
        capital_medido: missao.capitalTotal,
        capital_incompleto: missao.capitalIncompleto,
      });
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Criar missão de desova</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <p className="text-sm font-medium">{missao.titulo}</p>
          <pre className="text-xs bg-muted rounded p-2 whitespace-pre-wrap max-h-48 overflow-y-auto">{missao.descricao}</pre>
          <div>
            <label className="text-sm font-medium">Responsável</label>
            <Select value={assignedTo} onValueChange={setAssignedTo}>
              <SelectTrigger className="mt-1"><SelectValue placeholder="Selecione quem executa a desova" /></SelectTrigger>
              <SelectContent>
                {salespeople.map((s) => (
                  <SelectItem key={s.user_id} value={s.user_id}>{s.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-sm font-medium">Prazo</label>
            <Input type="date" className="mt-1" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </div>
          <p className="text-xs text-muted-foreground">
            A missão NÃO altera preço — queima/kit/oferta é decisão do responsável. Conclusão manual no board de tarefas.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
            <Button onClick={salvar} disabled={!assignedTo || saving || alvos.length === 0}>
              {saving ? 'Criando…' : 'Criar missão'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
