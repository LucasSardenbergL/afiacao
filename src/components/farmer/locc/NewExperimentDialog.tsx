// Dialog de criação de um novo experimento comercial.
// Extraído verbatim de src/pages/FarmerLOCC.tsx (god-component split).
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Plus } from 'lucide-react';
import { type NewExperimentInput } from './types';

export const NewExperimentDialog = ({ onCreate, disabled }: { onCreate: (input: NewExperimentInput) => void; disabled?: boolean }) => {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    title: '',
    hypothesis: '',
    primary_metric: 'margem_por_hora',
    min_duration_days: 14,
    min_sample_size: 10,
    min_significance: 0.95,
    control_description: '',
    test_description: '',
  });

  const handleSubmit = () => {
    if (!form.title || !form.hypothesis) return;
    onCreate(form);
    setOpen(false);
    setForm({
      title: '', hypothesis: '', primary_metric: 'margem_por_hora',
      min_duration_days: 14, min_sample_size: 10, min_significance: 0.95,
      control_description: '', test_description: '',
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="h-7 text-[10px]" disabled={disabled} title={disabled ? 'Indisponível em modo Ver como' : undefined}>
          <Plus className="w-3 h-3 mr-1" /> Novo
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">Novo Experimento Comercial</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            placeholder="Título do experimento"
            value={form.title}
            onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
            className="text-xs"
          />
          <Textarea
            placeholder="Hipótese: Ex: 'Ligar 2x por semana para clientes críticos reduz churn em 15%'"
            value={form.hypothesis}
            onChange={e => setForm(f => ({ ...f, hypothesis: e.target.value }))}
            className="text-xs"
            rows={3}
          />
          <Select value={form.primary_metric} onValueChange={v => setForm(f => ({ ...f, primary_metric: v }))}>
            <SelectTrigger className="text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="margem_por_hora">Margem/Hora</SelectItem>
              <SelectItem value="ltv">LTV</SelectItem>
              <SelectItem value="churn">Churn</SelectItem>
              <SelectItem value="receita_incremental">Receita Incremental</SelectItem>
            </SelectContent>
          </Select>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="text-[10px] text-muted-foreground">Duração min (dias)</label>
              <Input type="number" value={form.min_duration_days} onChange={e => setForm(f => ({ ...f, min_duration_days: Number(e.target.value) }))} className="text-xs" />
            </div>
            <div>
              <label className="text-[10px] text-muted-foreground">Amostra min</label>
              <Input type="number" value={form.min_sample_size} onChange={e => setForm(f => ({ ...f, min_sample_size: Number(e.target.value) }))} className="text-xs" />
            </div>
            <div>
              <label className="text-[10px] text-muted-foreground">Signif. min</label>
              <Input type="number" step="0.01" value={form.min_significance} onChange={e => setForm(f => ({ ...f, min_significance: Number(e.target.value) }))} className="text-xs" />
            </div>
          </div>
          <Input
            placeholder="Grupo Controle: Ex: 'Abordagem atual padrão'"
            value={form.control_description}
            onChange={e => setForm(f => ({ ...f, control_description: e.target.value }))}
            className="text-xs"
          />
          <Input
            placeholder="Grupo Teste: Ex: 'Nova abordagem com foco em margem'"
            value={form.test_description}
            onChange={e => setForm(f => ({ ...f, test_description: e.target.value }))}
            className="text-xs"
          />
          <Button className="w-full" size="sm" onClick={handleSubmit}>Criar Experimento</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
