// Modal "Registrar evento de negociação".
// Extraído de src/pages/AdminReposicaoPromocaoDetail.tsx (god-component split).
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
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
import {
  TIPO_EVENTO_LABELS,
  type NovoEventoForm,
} from "@/components/reposicao/promocaoDetail/types";

type EventoDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: NovoEventoForm;
  onChange: (next: NovoEventoForm) => void;
  userEmail: string;
  onSubmit: () => void;
  submitting: boolean;
};

export function EventoDialog({
  open,
  onOpenChange,
  value,
  onChange,
  userEmail,
  onSubmit,
  submitting,
}: EventoDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Registrar evento de negociação</DialogTitle>
          <DialogDescription>
            Adicione um marco da negociação ao histórico da campanha.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Tipo de evento</Label>
            <Select
              value={value.tipo_evento}
              onValueChange={(v) => onChange({ ...value, tipo_evento: v })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(TIPO_EVENTO_LABELS).map(([k, v]) => (
                  <SelectItem key={k} value={k}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Desconto proposto %</Label>
              <Input
                type="number"
                step="0.1"
                value={value.desconto_perc_proposto}
                onChange={(e) =>
                  onChange({
                    ...value,
                    desconto_perc_proposto: e.target.value,
                  })
                }
                placeholder="Ex: 25"
              />
            </div>
            <div>
              <Label>Volume mínimo</Label>
              <Input
                type="number"
                step="1"
                value={value.volume_minimo_proposto}
                onChange={(e) =>
                  onChange({
                    ...value,
                    volume_minimo_proposto: e.target.value,
                  })
                }
                placeholder="Opcional"
              />
            </div>
          </div>
          <div>
            <Label>Data do evento</Label>
            <Input
              type="datetime-local"
              value={value.data_evento}
              onChange={(e) =>
                onChange({ ...value, data_evento: e.target.value })
              }
            />
          </div>
          <div>
            <Label>Referência de email</Label>
            <Input
              value={value.email_referencia}
              onChange={(e) =>
                onChange({ ...value, email_referencia: e.target.value })
              }
              placeholder="Assunto ou link (opcional)"
            />
          </div>
          <div>
            <Label>Conteúdo</Label>
            <Textarea
              value={value.conteudo}
              onChange={(e) => onChange({ ...value, conteudo: e.target.value })}
              rows={4}
              placeholder="Descreva o evento, condições propostas, etc."
            />
          </div>
          <div className="text-xs text-muted-foreground">
            Será registrado por: {userEmail}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={onSubmit} disabled={submitting}>
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            Registrar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
