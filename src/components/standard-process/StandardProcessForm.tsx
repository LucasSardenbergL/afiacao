import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, Save, Send, Plus, Trash2 } from 'lucide-react';
import { useSaveStandardProcess } from '@/hooks/useSaveStandardProcess';
import { useKbProductSpecsList } from '@/hooks/useKbProductSpecsList';
import type { StandardProcess, StandardProcessEtapa, StandardProcessStatus } from '@/lib/standard-process/types';

const headerSchema = z.object({
  name: z.string().min(3),
  description: z.string().optional(),
  segmento: z.string().min(1),
  porte_alvo: z.string().default(''),          // CSV
  tags: z.string().default(''),
  expected_outcomes: z.string().default(''),
  prerequisites: z.string().default(''),
  target_audience: z.string().optional(),
});

// z.input = shape do formulário (campos com .default() são opcionais na entrada);
// z.infer (=z.output) = valores após parse/defaults (todos presentes). O resolver do
// zod transforma input→output, então useForm recebe os 3 genéricos: <input, ctx, output>.
type HeaderInput = z.input<typeof headerSchema>;
type HeaderValues = z.infer<typeof headerSchema>;

const emptyEtapa = (ordem: number): StandardProcessEtapa => ({
  ordem,
  nome: '',
  tipo: 'aplicacao',
  produtos: [],
  parametros: {},
  equipamentos: [],
  observacoes: '',
  produtos_kb: [],
  rationale: '',
});

interface Props {
  initial?: StandardProcess;
  onSaved?: () => void;
}

const splitCsv = (s: string | undefined) => (s ?? '').split(',').map((t) => t.trim()).filter(Boolean);
const joinCsv = (a: string[] | undefined) => (a ?? []).join(', ');

export function StandardProcessForm({ initial, onSaved }: Props) {
  const save = useSaveStandardProcess();
  const { data: specs } = useKbProductSpecsList();

  const { register, handleSubmit, formState: { errors } } = useForm<HeaderInput, unknown, HeaderValues>({
    resolver: zodResolver(headerSchema),
    defaultValues: {
      name: initial?.name ?? '',
      description: initial?.description ?? '',
      segmento: initial?.segmento ?? '',
      porte_alvo: joinCsv(initial?.porte_alvo),
      tags: joinCsv(initial?.tags),
      expected_outcomes: joinCsv(initial?.expected_outcomes),
      prerequisites: joinCsv(initial?.prerequisites),
      target_audience: initial?.target_audience ?? '',
    },
  });

  const [etapas, setEtapas] = useState<StandardProcessEtapa[]>(
    initial?.etapas?.length ? initial.etapas : [emptyEtapa(1)]
  );

  const addEtapa = () => setEtapas((prev) => [...prev, emptyEtapa(prev.length + 1)]);
  const removeEtapa = (idx: number) => setEtapas((prev) => prev.filter((_, i) => i !== idx).map((e, i) => ({ ...e, ordem: i + 1 })));
  const updateEtapa = (idx: number, patch: Partial<StandardProcessEtapa>) =>
    setEtapas((prev) => prev.map((e, i) => (i === idx ? { ...e, ...patch } : e)));

  const onSubmit = (status: StandardProcessStatus) => (values: HeaderValues) => {
    save.mutate(
      {
        id: initial?.id,
        name: values.name,
        description: values.description || undefined,
        segmento: values.segmento,
        porte_alvo: splitCsv(values.porte_alvo),
        tags: splitCsv(values.tags),
        etapas,
        expected_outcomes: splitCsv(values.expected_outcomes),
        target_audience: values.target_audience || undefined,
        prerequisites: splitCsv(values.prerequisites),
        status,
      },
      { onSuccess: () => onSaved?.() }
    );
  };

  return (
    <form className="space-y-4">
      <Card className="p-3 space-y-3">
        <div className="text-xs uppercase tracking-wide text-muted-foreground font-medium">Identificação</div>
        <div className="grid grid-cols-2 gap-2">
          <div className="col-span-2">
            <Label htmlFor="name" className="text-xs">Nome *</Label>
            <Input id="name" {...register('name')} placeholder="Ex: Sayerlack PU 2K alto padrão moveleiro" />
            {errors.name && <div className="text-2xs text-status-error">{errors.name.message}</div>}
          </div>
          <div className="col-span-2">
            <Label htmlFor="description" className="text-xs">Descrição</Label>
            <Textarea id="description" rows={2} {...register('description')} placeholder="1-2 frases" />
          </div>
          <div>
            <Label htmlFor="segmento" className="text-xs">Segmento *</Label>
            <Input id="segmento" {...register('segmento')} placeholder="moveleiro, automotivo, industrial..." />
          </div>
          <div>
            <Label htmlFor="porte" className="text-xs">Portes alvo (vírgula)</Label>
            <Input id="porte" {...register('porte_alvo')} placeholder="pequeno, medio" />
          </div>
          <div className="col-span-2">
            <Label htmlFor="audience" className="text-xs">Público alvo</Label>
            <Input id="audience" {...register('target_audience')} placeholder="Ex: Marcenarias 50-500 peças/mês" />
          </div>
          <div>
            <Label htmlFor="tags" className="text-xs">Tags (vírgula)</Label>
            <Input id="tags" {...register('tags')} placeholder="pu_2k, cabine_simples" />
          </div>
          <div>
            <Label htmlFor="outcomes" className="text-xs">Resultados esperados (vírgula)</Label>
            <Input id="outcomes" {...register('expected_outcomes')} placeholder="alto brilho, resistência química" />
          </div>
          <div className="col-span-2">
            <Label htmlFor="prereq" className="text-xs">Pré-requisitos (vírgula)</Label>
            <Input id="prereq" {...register('prerequisites')} placeholder="cabine simples, compressor 1HP+" />
          </div>
        </div>
      </Card>

      <Card className="p-3 space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-xs uppercase tracking-wide text-muted-foreground font-medium">Etapas ({etapas.length})</div>
          <Button type="button" variant="outline" size="sm" onClick={addEtapa} className="gap-1.5">
            <Plus className="w-3.5 h-3.5" /> Adicionar etapa
          </Button>
        </div>

        {etapas.map((e, idx) => (
          <Card key={idx} className="p-2.5 space-y-2 border-dashed">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-2xs font-mono text-muted-foreground">#{e.ordem}</span>
                <Input
                  className="h-8 text-xs"
                  value={e.nome}
                  onChange={(ev) => updateEtapa(idx, { nome: ev.target.value })}
                  placeholder="Nome da etapa"
                />
              </div>
              <Button type="button" variant="ghost" size="sm" onClick={() => removeEtapa(idx)} className="h-7 w-7 p-0 text-status-error">
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-2xs">Tipo</Label>
                <Select value={e.tipo} onValueChange={(v) => updateEtapa(idx, { tipo: v as StandardProcessEtapa['tipo'] })}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {['preparacao', 'aplicacao', 'secagem', 'lixamento', 'mistura', 'inspecao', 'embalagem', 'outro'].map((t) => (
                      <SelectItem key={t} value={t}>{t}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-2xs">Equipamentos (vírgula)</Label>
                <Input
                  className="h-8 text-xs"
                  value={joinCsv(e.equipamentos)}
                  onChange={(ev) => updateEtapa(idx, { equipamentos: splitCsv(ev.target.value) })}
                  placeholder="pistola HVLP, cabine"
                />
              </div>
              <div>
                <Label className="text-2xs">Produtos descritivos (vírgula)</Label>
                <Input
                  className="h-8 text-xs"
                  value={joinCsv(e.produtos)}
                  onChange={(ev) => updateEtapa(idx, { produtos: splitCsv(ev.target.value) })}
                  placeholder="primer PU, catalisador"
                />
              </div>
              <div>
                <Label className="text-2xs">Códigos KB (vírgula)</Label>
                <Input
                  className="h-8 text-xs"
                  value={joinCsv(e.produtos_kb)}
                  onChange={(ev) => updateEtapa(idx, { produtos_kb: splitCsv(ev.target.value) })}
                  placeholder="FO20.6827.00, FC.6952"
                />
                {specs && specs.length > 0 && (
                  <div className="text-[10px] text-muted-foreground mt-0.5">
                    Disponíveis: {specs.slice(0, 5).map((s) => s.product_code).join(', ')}{specs.length > 5 ? '…' : ''}
                  </div>
                )}
              </div>
              <div>
                <Label className="text-2xs">Tempo (min)</Label>
                <Input
                  className="h-8 text-xs"
                  type="number"
                  value={e.parametros.tempo_minutos ?? ''}
                  onChange={(ev) => updateEtapa(idx, { parametros: { ...e.parametros, tempo_minutos: ev.target.value ? Number(ev.target.value) : undefined } })}
                />
              </div>
              <div>
                <Label className="text-2xs">Temp (°C)</Label>
                <Input
                  className="h-8 text-xs"
                  type="number"
                  value={e.parametros.temperatura_c ?? ''}
                  onChange={(ev) => updateEtapa(idx, { parametros: { ...e.parametros, temperatura_c: ev.target.value ? Number(ev.target.value) : undefined } })}
                />
              </div>
              <div className="col-span-2">
                <Label className="text-2xs">Rationale (por quê)</Label>
                <Input
                  className="h-8 text-xs"
                  value={e.rationale ?? ''}
                  onChange={(ev) => updateEtapa(idx, { rationale: ev.target.value })}
                  placeholder="Ex: PU 2K resiste melhor a risco em móveis altos"
                />
              </div>
              <div className="col-span-2">
                <Label className="text-2xs">Observações</Label>
                <Textarea
                  className="text-xs"
                  rows={2}
                  value={e.observacoes}
                  onChange={(ev) => updateEtapa(idx, { observacoes: ev.target.value })}
                  placeholder="Notas, alertas, dicas"
                />
              </div>
            </div>
          </Card>
        ))}
      </Card>

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={handleSubmit(onSubmit('draft'))} disabled={save.isPending} className="gap-1.5">
          {save.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          Salvar rascunho
        </Button>
        <Button type="button" size="sm" onClick={handleSubmit(onSubmit('in_review'))} disabled={save.isPending} className="gap-1.5">
          <Send className="w-3.5 h-3.5" />
          Enviar pra revisão
        </Button>
      </div>
    </form>
  );
}
