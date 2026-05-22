import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Etapa } from "./types";
import { TIPOS_PARCEIRO } from "./shared";

export function EtapaFormDialog({
  open,
  modo,
  fornecedor,
  etapa,
  onClose,
  onSave,
  saving,
}: {
  open: boolean;
  modo: "criar" | "editar";
  fornecedor: string;
  etapa: Etapa | null;
  onClose: () => void;
  onSave: (e: Partial<Etapa>) => void;
  saving: boolean;
}) {
  const [descricao, setDescricao] = useState(etapa?.descricao ?? "");
  const [parceiroNome, setParceiroNome] = useState(etapa?.parceiro_nome ?? "");
  const [parceiroTipo, setParceiroTipo] = useState(etapa?.parceiro_tipo ?? "outros");
  const [parceiroContato, setParceiroContato] = useState(etapa?.parceiro_contato ?? "");
  const [ltDias, setLtDias] = useState<number>(etapa?.lt_dias ?? 1);
  const [unidade, setUnidade] = useState(etapa?.lt_unidade ?? "uteis");
  const [observacoes, setObservacoes] = useState(etapa?.observacoes ?? "");

  // resetar quando muda etapa
  useMemo(() => {
    if (open) {
      setDescricao(etapa?.descricao ?? "");
      setParceiroNome(etapa?.parceiro_nome ?? "");
      setParceiroTipo(etapa?.parceiro_tipo ?? "outros");
      setParceiroContato(etapa?.parceiro_contato ?? "");
      setLtDias(etapa?.lt_dias ?? 1);
      setUnidade(etapa?.lt_unidade ?? "uteis");
      setObservacoes(etapa?.observacoes ?? "");
    }
  }, [open, etapa]);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {modo === "criar" ? "Adicionar etapa" : "Editar etapa"}
          </DialogTitle>
          <DialogDescription>{fornecedor}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Descrição</Label>
            <Input
              value={descricao}
              onChange={(e) => setDescricao(e.target.value)}
              placeholder="Ex: Sayerlack → Intermediária"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Parceiro</Label>
              <Input
                value={parceiroNome}
                onChange={(e) => setParceiroNome(e.target.value)}
                placeholder="Nome"
              />
            </div>
            <div>
              <Label>Tipo</Label>
              <Select value={parceiroTipo} onValueChange={setParceiroTipo}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TIPOS_PARCEIRO.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <Label>Contato (email ou telefone)</Label>
            <Input
              value={parceiroContato}
              onChange={(e) => setParceiroContato(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>LT (dias)</Label>
              <Input
                type="number"
                min={0}
                value={ltDias}
                onChange={(e) => setLtDias(Number(e.target.value) || 0)}
                onFocus={(e) => e.target.select()}
              />
            </div>
            <div>
              <Label>Unidade</Label>
              <RadioGroup
                value={unidade}
                onValueChange={setUnidade}
                className="flex gap-4 mt-2"
              >
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="uteis" id="u-uteis" />
                  <Label htmlFor="u-uteis" className="font-normal text-sm">
                    Úteis
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="corridos" id="u-corridos" />
                  <Label htmlFor="u-corridos" className="font-normal text-sm">
                    Corridos
                  </Label>
                </div>
              </RadioGroup>
            </div>
          </div>
          <div>
            <Label>Observações</Label>
            <Textarea
              value={observacoes}
              onChange={(e) => setObservacoes(e.target.value)}
              rows={2}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            onClick={() =>
              onSave({
                descricao,
                parceiro_nome: parceiroNome || null,
                parceiro_tipo: parceiroTipo,
                parceiro_contato: parceiroContato || null,
                lt_dias: ltDias,
                lt_unidade: unidade,
                observacoes: observacoes || null,
              })
            }
            disabled={saving || !descricao.trim() || ltDias < 0}
          >
            {saving ? "Salvando..." : "Salvar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
