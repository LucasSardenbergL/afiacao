// Dialog de adicionar/editar mapeamento SKU.
// Extraído verbatim de src/pages/AdminSkuMapeamento.tsx (god-component split).
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Loader2 } from 'lucide-react';
import type { SkuMapForm } from './config';

interface MapeamentoFormDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  isEditing: boolean;
  form: SkuMapForm;
  setForm: React.Dispatch<React.SetStateAction<SkuMapForm>>;
  onCancel: () => void;
  onSave: () => void;
  isSaving: boolean;
}

export function MapeamentoFormDialog({
  open,
  onOpenChange,
  isEditing,
  form,
  setForm,
  onCancel,
  onSave,
  isSaving,
}: MapeamentoFormDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEditing ? 'Editar mapeamento' : 'Novo mapeamento'}</DialogTitle>
          <DialogDescription>
            Liga um código Omie ao código equivalente no portal do fornecedor.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Empresa</Label>
            <Input value={form.empresa} onChange={(e) => setForm({ ...form, empresa: e.target.value.toUpperCase() })} />
          </div>
          <div>
            <Label>Fornecedor</Label>
            <Input value={form.fornecedor_nome} onChange={(e) => setForm({ ...form, fornecedor_nome: e.target.value })} />
          </div>
          <div>
            <Label>SKU Omie</Label>
            <Input value={form.sku_omie} onChange={(e) => setForm({ ...form, sku_omie: e.target.value })} disabled={isEditing} />
          </div>
          <div>
            <Label>SKU Portal</Label>
            <Input value={form.sku_portal} onChange={(e) => setForm({ ...form, sku_portal: e.target.value })} />
          </div>
          <div>
            <Label>Unidade Portal</Label>
            <Input value={form.unidade_portal} onChange={(e) => setForm({ ...form, unidade_portal: e.target.value.toUpperCase() })} />
          </div>
          <div>
            <Label>Fator de conversão</Label>
            <Input
              type="number"
              step="0.0001"
              value={form.fator_conversao}
              onChange={(e) => setForm({ ...form, fator_conversao: Number(e.target.value) })}
            />
          </div>
          <div className="col-span-2 flex items-center gap-2">
            <Switch checked={form.ativo} onCheckedChange={(v) => setForm({ ...form, ativo: v })} />
            <Label>Ativo</Label>
          </div>
          <div className="col-span-2">
            <Label>Observações</Label>
            <Textarea value={form.observacoes} onChange={(e) => setForm({ ...form, observacoes: e.target.value })} rows={2} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>Cancelar</Button>
          <Button
            onClick={onSave}
            disabled={isSaving || !form.empresa || !form.fornecedor_nome || !form.sku_omie}
          >
            {isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
