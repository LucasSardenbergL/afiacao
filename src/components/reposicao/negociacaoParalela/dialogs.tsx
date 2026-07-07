// Dialogs da tela de negociação paralela: fechar sem acordo, converter em campanha.
// Extraídos de src/pages/AdminReposicaoNegociacaoParalela.tsx (god-component split).
// Apresentacionais: recebem estado controlado + callbacks; sem estado próprio.
import type { Dispatch, SetStateAction } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2 } from "lucide-react";
import type { ConvertForm, Sugestao } from "./types";

interface FecharSemAcordoDialogProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  obs: string;
  onObsChange: (v: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

export function FecharSemAcordoDialog({
  open,
  onOpenChange,
  obs,
  onObsChange,
  onCancel,
  onConfirm,
}: FecharSemAcordoDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Fechar sem acordo</DialogTitle>
          <DialogDescription>
            Registre o motivo do encerramento sem acordo. Útil para histórico futuro.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label>Observação (opcional)</Label>
          <Textarea
            rows={4}
            value={obs}
            onChange={(e) => onObsChange(e.target.value)}
            placeholder="Ex: Sayerlack não aceitou contraproposta, alegou margem apertada."
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancelar
          </Button>
          <Button onClick={onConfirm}>Confirmar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface ConverterDialogProps {
  target: Sugestao | null;
  form: ConvertForm;
  setForm: Dispatch<SetStateAction<ConvertForm>>;
  submitting: boolean;
  onOpenChange: (o: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConverterDialog({
  target,
  form,
  setForm,
  submitting,
  onOpenChange,
  onCancel,
  onConfirm,
}: ConverterDialogProps) {
  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Registrar desconto fechado</DialogTitle>
          <DialogDescription>
            Converte a sugestão em uma campanha flat condicional vinculada ao SKU{" "}
            <span className="font-mono">{target?.sku_codigo_omie}</span>.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>Desconto percentual (%)</Label>
            <Input
              type="number"
              min={1}
              max={50}
              step={0.5}
              value={form.desconto_perc}
              onChange={(e) =>
                setForm((f) => ({ ...f, desconto_perc: parseFloat(e.target.value) || 0 }))
              }
            />
          </div>
          <div className="space-y-2">
            <Label>Volume mínimo</Label>
            <Input
              type="number"
              min={0}
              step={1}
              value={form.volume_minimo}
              onChange={(e) =>
                setForm((f) => ({ ...f, volume_minimo: parseFloat(e.target.value) || 0 }))
              }
            />
          </div>
          <div className="space-y-2">
            <Label>Unidade do volume</Label>
            <Select
              value={form.volume_unidade}
              onValueChange={(v) =>
                setForm((f) => ({ ...f, volume_unidade: v as typeof f.volume_unidade }))
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="reais">Reais (R$)</SelectItem>
                <SelectItem value="unidades">Unidades</SelectItem>
                <SelectItem value="kg">Quilos (kg)</SelectItem>
                <SelectItem value="litros">Litros</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Data fim</Label>
            <Input
              type="date"
              value={form.data_fim}
              onChange={(e) => setForm((f) => ({ ...f, data_fim: e.target.value }))}
            />
          </div>
          <div className="space-y-2">
            <Label>Responsável</Label>
            <Input
              value={form.responsavel}
              onChange={(e) => setForm((f) => ({ ...f, responsavel: e.target.value }))}
              placeholder="Nome do vendedor / contato"
            />
          </div>
          <div className="space-y-2">
            <Label>Canal</Label>
            <Select
              value={form.canal}
              onValueChange={(v) =>
                setForm((f) => ({ ...f, canal: v as typeof f.canal }))
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ligacao">Ligação</SelectItem>
                <SelectItem value="whatsapp">WhatsApp</SelectItem>
                <SelectItem value="email">E-mail</SelectItem>
                <SelectItem value="visita_presencial">Visita presencial</SelectItem>
                <SelectItem value="outro">Outro</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="col-span-2 space-y-2">
            <Label>Observações (opcional)</Label>
            <Textarea
              rows={3}
              value={form.observacoes}
              onChange={(e) => setForm((f) => ({ ...f, observacoes: e.target.value }))}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancelar
          </Button>
          <Button onClick={onConfirm} disabled={submitting}>
            {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Converter em campanha
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
