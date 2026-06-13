import { useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { previewManterLote } from "@/lib/reposicao/baixo-giro-helpers";
import { fmtBRL } from "@/lib/reposicao/sku-param";
import type { RowBaixoGiro } from "./types";

export function ManterEmEstoqueDialog({ open, onOpenChange, alvos, onConfirm, saving }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  alvos: RowBaixoGiro[];
  onConfirm: (args: { codes: number[]; min: number; ponto: number; max: number; motivo: string }) => void;
  saving: boolean;
}) {
  const [min, setMin] = useState("1");
  const [ponto, setPonto] = useState("1");
  const [max, setMax] = useState("2");
  const [motivo, setMotivo] = useState("");

  const preview = useMemo(() => previewManterLote(
    alvos.map((a) => ({ ppAtual: a.ponto_pedido, maxAtual: a.estoque_maximo, posicao: a.saldo ?? 0, custo: a.cmc })),
    Number(ponto) || 0, Number(max) || 0,
  ), [alvos, ponto, max]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Manter em estoque — {alvos.length} item(ns)</DialogTitle></DialogHeader>
        <div className="grid grid-cols-3 gap-3">
          <div><Label>Mínimo</Label><Input type="number" value={min} onChange={(e) => setMin(e.target.value)} /></div>
          <div><Label>Ponto de pedido</Label><Input type="number" value={ponto} onChange={(e) => setPonto(e.target.value)} /></div>
          <div><Label>Máximo</Label><Input type="number" value={max} onChange={(e) => setMax(e.target.value)} /></div>
        </div>
        <div className="rounded-md border bg-accent/30 p-3 text-sm">
          Vai gerar compra de <strong>~{preview.qtdeTotal} un</strong> = <strong>{fmtBRL(preview.valorTotalRs)}</strong> no próximo ciclo
          {preview.semCustoN > 0 && <span className="text-status-warning"> (+{preview.semCustoN} sem custo)</span>}.
        </div>
        <div><Label>Motivo (obrigatório)</Label><Textarea value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ex.: sortimento — não perder venda" /></div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button disabled={!motivo.trim() || saving} onClick={() => onConfirm({ codes: alvos.map((a) => a.sku_codigo_omie), min: Number(min), ponto: Number(ponto), max: Number(max), motivo })}>
            Confirmar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
