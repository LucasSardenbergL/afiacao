import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
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
import { Etapa } from "./types";
import { TIPOS_PARCEIRO, tipoLabel } from "./shared";

export function TrocaParceiroDialog({
  etapa,
  onClose,
  onConfirm,
  saving,
}: {
  etapa: Etapa | null;
  onClose: () => void;
  onConfirm: (args: {
    novoParceiro: string;
    novoTipo: string;
    novoContato: string;
    novoLt: number;
    novaUnidade: string;
    dataTroca: string;
  }) => void;
  saving: boolean;
}) {
  const [novoParceiro, setNovoParceiro] = useState("");
  const [novoTipo, setNovoTipo] = useState("transportadora_terceira");
  const [novoContato, setNovoContato] = useState("");
  const [novoLt, setNovoLt] = useState(etapa?.lt_dias ?? 1);
  const [unidade, setUnidade] = useState(etapa?.lt_unidade ?? "uteis");
  const [dataTroca, setDataTroca] = useState(
    new Date().toISOString().split("T")[0],
  );

  useMemo(() => {
    if (etapa) {
      setNovoParceiro("");
      setNovoTipo("transportadora_terceira");
      setNovoContato("");
      setNovoLt(etapa.lt_dias);
      setUnidade(etapa.lt_unidade);
      setDataTroca(new Date().toISOString().split("T")[0]);
    }
  }, [etapa]);

  return (
    <Dialog open={!!etapa} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Trocar parceiro</DialogTitle>
          <DialogDescription>
            Mantém a estrutura da etapa, registra o histórico do parceiro anterior e
            cria nova entrada com a nova vigência.
          </DialogDescription>
        </DialogHeader>
        {etapa && (
          <div className="space-y-3">
            <Card className="bg-muted/40">
              <CardContent className="pt-4 text-sm space-y-1">
                <div>
                  <span className="text-muted-foreground">Etapa atual:</span>{" "}
                  <span className="font-medium">{etapa.descricao}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Parceiro atual:</span>{" "}
                  {etapa.parceiro_nome ?? "—"} ({tipoLabel(etapa.parceiro_tipo)})
                </div>
                <div>
                  <span className="text-muted-foreground">LT atual:</span>{" "}
                  {etapa.lt_dias} {etapa.lt_unidade}
                </div>
              </CardContent>
            </Card>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Novo parceiro</Label>
                <Input
                  value={novoParceiro}
                  onChange={(e) => setNovoParceiro(e.target.value)}
                />
              </div>
              <div>
                <Label>Tipo</Label>
                <Select value={novoTipo} onValueChange={setNovoTipo}>
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
              <Label>Contato</Label>
              <Input
                value={novoContato}
                onChange={(e) => setNovoContato(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label>Novo LT</Label>
                <Input
                  type="number"
                  min={0}
                  value={novoLt}
                  onChange={(e) => setNovoLt(Number(e.target.value) || 0)}
                  onFocus={(e) => e.target.select()}
                />
              </div>
              <div>
                <Label>Unidade</Label>
                <Select value={unidade} onValueChange={setUnidade}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="uteis">Úteis</SelectItem>
                    <SelectItem value="corridos">Corridos</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Data da troca</Label>
                <Input
                  type="date"
                  value={dataTroca}
                  onChange={(e) => setDataTroca(e.target.value)}
                />
              </div>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            onClick={() =>
              onConfirm({
                novoParceiro,
                novoTipo,
                novoContato,
                novoLt,
                novaUnidade: unidade,
                dataTroca,
              })
            }
            disabled={saving || !novoParceiro.trim() || novoLt < 0}
          >
            {saving ? "Salvando..." : "Confirmar troca"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
