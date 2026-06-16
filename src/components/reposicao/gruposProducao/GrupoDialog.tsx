// Modal de criação/edição de grupo de produção.
// Extraído de src/pages/AdminReposicaoGruposProducao.tsx (god-component split).
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Loader2 } from "lucide-react";
import type { Grupo } from "./types";

export function GrupoDialog({
  editing, setEditing, isNew, onSalvar, salvarPending,
}: {
  editing: Partial<Grupo> | null;
  setEditing: (g: Partial<Grupo> | null) => void;
  isNew: boolean;
  onSalvar: (g: Partial<Grupo>) => void;
  salvarPending: boolean;
}) {
  return (
    <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isNew ? "Novo grupo" : "Editar grupo"}</DialogTitle>
          <DialogDescription>
            Define o lead time de produção e janela de corte do fornecedor.
          </DialogDescription>
        </DialogHeader>
        {editing && (
          <div className="space-y-3">
            <div>
              <Label>Fornecedor *</Label>
              <Input
                value={editing.fornecedor_nome || ""}
                onChange={(e) => setEditing({ ...editing, fornecedor_nome: e.target.value })}
                placeholder="Ex.: RENNER SAYERLACK S/A"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Código do grupo *</Label>
                <Input
                  value={editing.grupo_codigo || ""}
                  onChange={(e) => setEditing({ ...editing, grupo_codigo: e.target.value })}
                  placeholder="ex.: sayerlack_rapido"
                />
              </div>
              <div>
                <Label>LT produção (dias) *</Label>
                <Input
                  type="number"
                  min={1}
                  value={editing.lt_producao_dias ?? 5}
                  onChange={(e) =>
                    setEditing({ ...editing, lt_producao_dias: Number(e.target.value) })
                  }
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Unidade</Label>
                <Select
                  value={editing.lt_producao_unidade || "uteis"}
                  onValueChange={(v) => setEditing({ ...editing, lt_producao_unidade: v })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="uteis">Dias úteis</SelectItem>
                    <SelectItem value="corridos">Dias corridos</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Horário de corte</Label>
                <Input
                  type="time"
                  value={editing.horario_corte?.slice(0, 5) || ""}
                  onChange={(e) =>
                    setEditing({ ...editing, horario_corte: e.target.value || null })
                  }
                />
              </div>
            </div>
            <div>
              <Label>Descrição</Label>
              <Input
                value={editing.descricao || ""}
                onChange={(e) => setEditing({ ...editing, descricao: e.target.value })}
              />
            </div>
            <div>
              <Label>Observações</Label>
              <Textarea
                rows={2}
                value={editing.observacoes || ""}
                onChange={(e) => setEditing({ ...editing, observacoes: e.target.value })}
              />
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => setEditing(null)}>Cancelar</Button>
          <Button
            onClick={() => editing && onSalvar(editing)}
            disabled={salvarPending}
          >
            {salvarPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
