// src/components/financeiro/RegimeInputsDialog.tsx
import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { useUpdateRegimeInputs } from '@/hooks/useRegimeTributario';
import type { RegimeInputs } from '@/services/financeiroService';

const num = (v: string): number | null => (v.trim() === '' || Number.isNaN(Number(v)) ? null : Number(v));

const ANEXOS: Array<NonNullable<RegimeInputs['anexo_simples']>> = ['I', 'II', 'III', 'IV', 'V'];
const ANEXO_VAZIO = '__vazio__';

export function RegimeInputsDialog({ company, atual }: { company: string; atual: RegimeInputs }) {
  const [open, setOpen] = useState(false);
  const update = useUpdateRegimeInputs();
  // Campos planos (percentuais em fração, ex.: 0.20 = 20%).
  const [f, setF] = useState({
    folha_cpp_anual: atual.folha_cpp_anual != null ? String(atual.folha_cpp_anual) : '',
    massa_fator_r_anual: atual.massa_fator_r_anual != null ? String(atual.massa_fator_r_anual) : '',
    encargo_patronal_pct: atual.encargo_patronal_pct != null ? String(atual.encargo_patronal_pct) : '',
    presuncao_irpj: atual.presuncao_irpj != null ? String(atual.presuncao_irpj) : '',
    presuncao_csll: atual.presuncao_csll != null ? String(atual.presuncao_csll) : '',
    credito_pis_cofins_estimado: atual.credito_pis_cofins_estimado != null ? String(atual.credito_pis_cofins_estimado) : '',
    receita_tributavel_pis_cofins_pct: atual.receita_tributavel_pis_cofins_pct != null ? String(atual.receita_tributavel_pis_cofins_pct) : '',
    anexo_simples: atual.anexo_simples ?? '',
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((s) => ({ ...s, [k]: e.target.value }));

  const salvar = async () => {
    const regime_inputs: RegimeInputs = {
      folha_cpp_anual: num(f.folha_cpp_anual),
      massa_fator_r_anual: num(f.massa_fator_r_anual),
      encargo_patronal_pct: num(f.encargo_patronal_pct),
      presuncao_irpj: num(f.presuncao_irpj),
      presuncao_csll: num(f.presuncao_csll),
      credito_pis_cofins_estimado: num(f.credito_pis_cofins_estimado),
      receita_tributavel_pis_cofins_pct: num(f.receita_tributavel_pis_cofins_pct),
      anexo_simples: (f.anexo_simples || null) as RegimeInputs['anexo_simples'],
    };
    try {
      await update.mutateAsync({ company, regime_inputs });
      toast.success('Inputs salvos. Recalculando…');
      setOpen(false);
    } catch (e) {
      toast.error('Falha ao salvar inputs', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm" variant="outline">Inputs ({company})</Button></DialogTrigger>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Inputs de regime — {company}</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="col-span-2 text-xs text-muted-foreground">Taxas em fração (0.20 = 20%). Valores em R$/ano. Campo vazio = sem override (usa default/derivado).</div>
          <div><Label>Folha p/ CPP (anual)</Label><Input value={f.folha_cpp_anual} onChange={set('folha_cpp_anual')} inputMode="decimal" /></div>
          <div><Label>Massa do fator-r (salários+pró-labore+CPP+FGTS, anual)</Label><Input value={f.massa_fator_r_anual} onChange={set('massa_fator_r_anual')} inputMode="decimal" /></div>
          <div><Label>Encargo patronal % (default 0,20 = CPP estrita)</Label><Input value={f.encargo_patronal_pct} onChange={set('encargo_patronal_pct')} inputMode="decimal" /></div>
          <div><Label>Presunção IRPJ</Label><Input value={f.presuncao_irpj} onChange={set('presuncao_irpj')} inputMode="decimal" /></div>
          <div><Label>Presunção CSLL</Label><Input value={f.presuncao_csll} onChange={set('presuncao_csll')} inputMode="decimal" /></div>
          <div><Label>Crédito PIS/COFINS estimado (Real)</Label><Input value={f.credito_pis_cofins_estimado} onChange={set('credito_pis_cofins_estimado')} inputMode="decimal" /></div>
          <div><Label>% receita tributável PIS/COFINS (1 − monofásico/ST)</Label><Input value={f.receita_tributavel_pis_cofins_pct} onChange={set('receita_tributavel_pis_cofins_pct')} inputMode="decimal" /></div>
          <div>
            <Label>Anexo Simples (override)</Label>
            <Select
              value={f.anexo_simples === '' ? ANEXO_VAZIO : f.anexo_simples}
              onValueChange={(v) => setF((s) => ({ ...s, anexo_simples: v === ANEXO_VAZIO ? '' : v }))}
            >
              <SelectTrigger><SelectValue placeholder="(vazio)" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ANEXO_VAZIO}>(vazio)</SelectItem>
                {ANEXOS.map((ax) => <SelectItem key={ax} value={ax}>{ax}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={salvar} disabled={update.isPending}>{update.isPending ? 'Salvando…' : 'Salvar'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
