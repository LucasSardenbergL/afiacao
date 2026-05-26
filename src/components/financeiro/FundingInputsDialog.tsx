// src/components/financeiro/FundingInputsDialog.tsx
// Espelha RegimeInputsDialog.tsx: Dialog shadcn, campos planos, save via mutation, toast sonner.
import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useFundingInputs, useSalvarFundingInputs } from '@/hooks/useFunding';
import type { FundingInputs } from '@/services/financeiroService';

const num = (v: string): number => {
  const n = Number(v.trim().replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};

const DEFAULTS: FundingInputs = {
  fontes: {
    antecipacao: {
      taxa_desconto_mensal_perc: 0,
      tarifa_fixa: 0,
      tipo: 'desconto',
      coobrigacao: false,
      ativo: false,
    },
    capital_giro: { cet_anual_perc: 0, ativo: false },
    cheque_especial: { cet_anual_perc: 0, ativo: false },
  },
  reserva_dias_min: 15,
  gap_estrutural_semanas_min: 6,
};

function merge(base: FundingInputs, over: FundingInputs | null): FundingInputs {
  if (!over) return base;
  return {
    fontes: {
      antecipacao: { ...base.fontes.antecipacao, ...over.fontes?.antecipacao },
      capital_giro: { ...base.fontes.capital_giro, ...over.fontes?.capital_giro },
      cheque_especial: { ...base.fontes.cheque_especial, ...over.fontes?.cheque_especial },
    },
    reserva_dias_min: over.reserva_dias_min ?? base.reserva_dias_min,
    gap_estrutural_semanas_min: over.gap_estrutural_semanas_min ?? base.gap_estrutural_semanas_min,
  };
}

export function FundingInputsDialog({ company }: { company: string }) {
  const [open, setOpen] = useState(false);
  const { data: inputsSalvos } = useFundingInputs(company);
  const salvar = useSalvarFundingInputs();

  // Estado local em string para os campos numéricos (exatamente como RegimeInputsDialog).
  const [ant, setAnt] = useState({
    taxa_desconto_mensal_perc: '',
    tarifa_fixa: '',
    tipo: 'desconto' as 'desconto' | 'factoring',
    coobrigacao: false,
    ativo: false,
  });
  const [cg, setCg] = useState({ cet_anual_perc: '', ativo: false });
  const [ce, setCe] = useState({ cet_anual_perc: '', ativo: false });
  const [reserva_dias_min, setReservaDias] = useState('15');
  const [gap_semanas, setGapSemanas] = useState('6');

  // Preenche o formulário quando os dados chegam do servidor.
  useEffect(() => {
    const merged = merge(DEFAULTS, inputsSalvos ?? null);
    setAnt({
      taxa_desconto_mensal_perc: String(merged.fontes.antecipacao.taxa_desconto_mensal_perc),
      tarifa_fixa: String(merged.fontes.antecipacao.tarifa_fixa),
      tipo: merged.fontes.antecipacao.tipo,
      coobrigacao: merged.fontes.antecipacao.coobrigacao,
      ativo: merged.fontes.antecipacao.ativo,
    });
    setCg({
      cet_anual_perc: String(merged.fontes.capital_giro.cet_anual_perc),
      ativo: merged.fontes.capital_giro.ativo,
    });
    setCe({
      cet_anual_perc: String(merged.fontes.cheque_especial.cet_anual_perc),
      ativo: merged.fontes.cheque_especial.ativo,
    });
    setReservaDias(String(merged.reserva_dias_min));
    setGapSemanas(String(merged.gap_estrutural_semanas_min));
  }, [inputsSalvos]);

  const handleSalvar = async () => {
    const funding_inputs: FundingInputs = {
      fontes: {
        antecipacao: {
          taxa_desconto_mensal_perc: num(ant.taxa_desconto_mensal_perc),
          tarifa_fixa: num(ant.tarifa_fixa),
          tipo: ant.tipo,
          coobrigacao: ant.coobrigacao,
          ativo: ant.ativo,
        },
        capital_giro: {
          cet_anual_perc: num(cg.cet_anual_perc),
          ativo: cg.ativo,
        },
        cheque_especial: {
          cet_anual_perc: num(ce.cet_anual_perc),
          ativo: ce.ativo,
        },
      },
      reserva_dias_min: num(reserva_dias_min) || 15,
      gap_estrutural_semanas_min: num(gap_semanas) || 6,
    };
    try {
      await salvar.mutateAsync({ company, funding_inputs });
      setOpen(false);
    } catch {
      // toast já disparado no onError do hook
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Inputs ({company})
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Fontes de funding — {company}</DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="col-span-2 text-xs text-muted-foreground">
            Taxas em % (ex: 2,5 = 2,5% a.m.). Valores monetários em R$. Campo vazio → usa default do
            sistema.
          </div>

          {/* ── Antecipação ── */}
          <div className="col-span-2 font-medium text-xs uppercase tracking-wide text-muted-foreground pt-2">
            Antecipação / desconto de recebíveis
          </div>

          <div className="col-span-2 flex items-center gap-2">
            <Switch
              id="ant-ativo"
              checked={ant.ativo}
              onCheckedChange={(v) => setAnt((s) => ({ ...s, ativo: v }))}
            />
            <Label htmlFor="ant-ativo">Fonte ativa</Label>
          </div>

          <div>
            <Label>Taxa de desconto (% a.m.)</Label>
            <Input
              value={ant.taxa_desconto_mensal_perc}
              onChange={(e) => setAnt((s) => ({ ...s, taxa_desconto_mensal_perc: e.target.value }))}
              inputMode="decimal"
              disabled={!ant.ativo}
            />
          </div>

          <div>
            <Label>Tarifa fixa (R$ por título)</Label>
            <Input
              value={ant.tarifa_fixa}
              onChange={(e) => setAnt((s) => ({ ...s, tarifa_fixa: e.target.value }))}
              inputMode="decimal"
              disabled={!ant.ativo}
            />
          </div>

          <div>
            <Label>Tipo de operação</Label>
            <Select
              value={ant.tipo}
              onValueChange={(v) => setAnt((s) => ({ ...s, tipo: v as 'desconto' | 'factoring' }))}
              disabled={!ant.ativo}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="desconto">Desconto (com IOF)</SelectItem>
                <SelectItem value="factoring">Factoring (sem IOF)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-end gap-2 pb-1">
            <Switch
              id="ant-coobrigacao"
              checked={ant.coobrigacao}
              onCheckedChange={(v) => setAnt((s) => ({ ...s, coobrigacao: v }))}
              disabled={!ant.ativo}
            />
            <Label htmlFor="ant-coobrigacao">Coobrigação</Label>
          </div>

          {/* ── Capital de giro ── */}
          <div className="col-span-2 font-medium text-xs uppercase tracking-wide text-muted-foreground pt-2">
            Capital de giro (benchmark de gap)
          </div>

          <div className="col-span-2 flex items-center gap-2">
            <Switch
              id="cg-ativo"
              checked={cg.ativo}
              onCheckedChange={(v) => setCg((s) => ({ ...s, ativo: v }))}
            />
            <Label htmlFor="cg-ativo">Fonte ativa</Label>
          </div>

          <div className="col-span-2">
            <Label>CET anual (% a.a.)</Label>
            <Input
              value={cg.cet_anual_perc}
              onChange={(e) => setCg((s) => ({ ...s, cet_anual_perc: e.target.value }))}
              inputMode="decimal"
              disabled={!cg.ativo}
            />
          </div>

          {/* ── Cheque especial ── */}
          <div className="col-span-2 font-medium text-xs uppercase tracking-wide text-muted-foreground pt-2">
            Cheque especial (benchmark de gap)
          </div>

          <div className="col-span-2 flex items-center gap-2">
            <Switch
              id="ce-ativo"
              checked={ce.ativo}
              onCheckedChange={(v) => setCe((s) => ({ ...s, ativo: v }))}
            />
            <Label htmlFor="ce-ativo">Fonte ativa</Label>
          </div>

          <div className="col-span-2">
            <Label>CET anual (% a.a.)</Label>
            <Input
              value={ce.cet_anual_perc}
              onChange={(e) => setCe((s) => ({ ...s, cet_anual_perc: e.target.value }))}
              inputMode="decimal"
              disabled={!ce.ativo}
            />
          </div>

          {/* ── Parâmetros gerais ── */}
          <div className="col-span-2 font-medium text-xs uppercase tracking-wide text-muted-foreground pt-2">
            Parâmetros gerais
          </div>

          <div>
            <Label>Reserva mínima (dias de burn)</Label>
            <Input
              value={reserva_dias_min}
              onChange={(e) => setReservaDias(e.target.value)}
              inputMode="numeric"
            />
          </div>

          <div>
            <Label>Limiar para "estrutural" (semanas)</Label>
            <Input
              value={gap_semanas}
              onChange={(e) => setGapSemanas(e.target.value)}
              inputMode="numeric"
            />
          </div>
        </div>

        <DialogFooter>
          <Button onClick={handleSalvar} disabled={salvar.isPending}>
            {salvar.isPending ? 'Salvando…' : 'Salvar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
