// Popover de desconto extra negociado por item.
// Extraída de src/pages/AdminReposicaoPromocaoDetail.tsx (god-component split).
import { useState, useEffect } from "react";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { ItemRow } from "./types";

export function DescontoExtraCell({
  item,
  onSave,
  userEmail,
}: {
  item: ItemRow;
  onSave: (changes: Partial<ItemRow>) => void;
  userEmail: string;
}) {
  const [open, setOpen] = useState(false);
  const [perc, setPerc] = useState<string>(
    item.desconto_extra_perc?.toString() || "",
  );
  const [obs, setObs] = useState(item.desconto_extra_observacoes || "");
  const [emailRef, setEmailRef] = useState(item.desconto_extra_email_referencia || "");

  useEffect(() => {
    if (open) {
      setPerc(item.desconto_extra_perc?.toString() || "");
      setObs(item.desconto_extra_observacoes || "");
      setEmailRef(item.desconto_extra_email_referencia || "");
    }
  }, [open, item]);

  const handleSave = () => {
    const num = parseFloat(perc);
    if (isNaN(num) || num <= 0 || num > 50) {
      toast.error("Desconto extra deve ser entre 0 e 50%");
      return;
    }
    onSave({
      desconto_extra_perc: num,
      desconto_extra_observacoes: obs || null,
      desconto_extra_email_referencia: emailRef || null,
      desconto_extra_negociado_por: userEmail,
      desconto_extra_negociado_em: new Date().toISOString(),
    });
    setOpen(false);
  };

  const handleRemove = () => {
    onSave({
      desconto_extra_perc: null,
      desconto_extra_observacoes: null,
      desconto_extra_email_referencia: null,
      desconto_extra_negociado_por: null,
      desconto_extra_negociado_em: null,
    });
    setOpen(false);
  };

  const tem = item.desconto_extra_perc !== null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {tem ? (
          <Badge
            variant="outline"
            className="bg-status-info/15 text-status-info border-status-info/30 cursor-pointer"
          >
            base + {item.desconto_extra_perc}%
          </Badge>
        ) : (
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs">
            <Plus className="h-3 w-3" /> extra
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent className="w-80">
        <div className="space-y-3">
          <div className="font-medium text-sm">Desconto extra negociado</div>
          <div>
            <Label className="text-xs">Percentual extra (%)</Label>
            <Input
              type="number"
              step="0.1"
              min="0"
              max="50"
              value={perc}
              onChange={(e) => setPerc(e.target.value)}
              placeholder="Ex: 5"
            />
          </div>
          <div>
            <Label className="text-xs">Observações</Label>
            <Textarea
              value={obs}
              onChange={(e) => setObs(e.target.value)}
              placeholder="Negociado com [nome] em [data]"
              rows={2}
            />
          </div>
          <div>
            <Label className="text-xs">Referência de email (opcional)</Label>
            <Input
              value={emailRef}
              onChange={(e) => setEmailRef(e.target.value)}
              placeholder="Assunto ou link"
            />
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={handleSave} className="flex-1">
              Salvar
            </Button>
            {tem && (
              <Button
                size="sm"
                variant="destructive"
                onClick={handleRemove}
              >
                Remover
              </Button>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
