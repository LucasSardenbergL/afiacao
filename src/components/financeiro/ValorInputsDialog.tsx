// src/components/financeiro/ValorInputsDialog.tsx
import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { useUpdateValorInputs } from '@/hooks/useValor';
import type { ValorInputs } from '@/services/financeiroService';

const num = (v: string): number | null => (v.trim() === '' || Number.isNaN(Number(v)) ? null : Number(v));

export function ValorInputsDialog({ company, atual }: { company: string; atual?: ValorInputs }) {
  const [open, setOpen] = useState(false);
  const update = useUpdateValorInputs();
  const a = atual ?? {};
  // Campos planos (percentuais em fração, ex.: 0.20 = 20%).
  const [f, setF] = useState({
    ativo_fixo_valor: a.ativo_fixo?.valor != null ? String(a.ativo_fixo.valor) : '',
    ativo_fixo_data: a.ativo_fixo?.data_ref ?? '',
    ativo_fixo_base: a.ativo_fixo?.base ?? 'reposicao',
    ajustes: a.ajustes != null ? String(a.ajustes) : '',
    divida: a.divida != null ? String(a.divida) : '',
    equity: a.equity != null ? String(a.equity) : '',
    kd: a.kd != null ? String(a.kd) : '',
    ke_base_ancora: a.ke?.base?.ancora != null ? String(a.ke.base.ancora) : '',
    ke_base_re: a.ke?.base?.premio_risco_equity != null ? String(a.ke.base.premio_risco_equity) : '',
    ke_base_tam: a.ke?.base?.premio_tamanho_private != null ? String(a.ke.base.premio_tamanho_private) : '',
    ke_base_iliq: a.ke?.base?.premio_iliquidez_controle != null ? String(a.ke.base.premio_iliquidez_controle) : '',
    prolabore_real: a.prolabore_real_mensal != null ? String(a.prolabore_real_mensal) : '',
    prolabore_mercado: a.prolabore_mercado_mensal != null ? String(a.prolabore_mercado_mensal) : '',
    aluguel_mercado: a.aluguel_mercado_mensal != null ? String(a.aluguel_mercado_mensal) : '',
    intercompany_giro: a.intercompany_giro != null ? String(a.intercompany_giro) : '',
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((s) => ({ ...s, [k]: e.target.value }));

  const salvar = async () => {
    const afValor = num(f.ativo_fixo_valor);
    const keBase = (num(f.ke_base_ancora) != null || num(f.ke_base_re) != null)
      ? { ancora: num(f.ke_base_ancora) ?? 0, premio_risco_equity: num(f.ke_base_re) ?? 0, premio_tamanho_private: num(f.ke_base_tam) ?? 0, premio_iliquidez_controle: num(f.ke_base_iliq) ?? 0 }
      : undefined;
    const valor_inputs: ValorInputs = {
      ativo_fixo: afValor != null ? { valor: afValor, data_ref: f.ativo_fixo_data || null, fonte: 'reposicao', base: (f.ativo_fixo_base as 'reposicao' | 'book') || 'reposicao', operacional: true } : null,
      ajustes: num(f.ajustes) ?? 0,
      divida: num(f.divida),
      equity: num(f.equity),
      kd: num(f.kd),
      ke: keBase ? { base: keBase, conservador: keBase, agressivo: keBase } : undefined,
      prolabore_real_mensal: num(f.prolabore_real),
      prolabore_mercado_mensal: num(f.prolabore_mercado),
      aluguel_mercado_mensal: num(f.aluguel_mercado),
      intercompany_giro: num(f.intercompany_giro),
    };
    try {
      await update.mutateAsync({ company, valor_inputs });
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
        <DialogHeader><DialogTitle>Inputs manuais — {company}</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="col-span-2 text-xs text-muted-foreground">Taxas em fração (0.20 = 20%). Valores em R$. Pró-labore/aluguel são MENSAIS.</div>
          <div><Label>Ativo fixo (R$)</Label><Input value={f.ativo_fixo_valor} onChange={set('ativo_fixo_valor')} inputMode="decimal" /></div>
          <div><Label>AF — data ref</Label><Input value={f.ativo_fixo_data} onChange={set('ativo_fixo_data')} placeholder="2026-01-01" /></div>
          <div><Label>Ajustes/exclusões (R$)</Label><Input value={f.ajustes} onChange={set('ajustes')} inputMode="decimal" /></div>
          <div><Label>Dívida (R$)</Label><Input value={f.divida} onChange={set('divida')} inputMode="decimal" /></div>
          <div><Label>PL / equity (R$)</Label><Input value={f.equity} onChange={set('equity')} inputMode="decimal" /></div>
          <div><Label>Kd (fração)</Label><Input value={f.kd} onChange={set('kd')} inputMode="decimal" /></div>
          <div className="col-span-2 mt-2 font-medium">Ke (base) decomposto</div>
          <div><Label>Âncora (CDI/NTN-B)</Label><Input value={f.ke_base_ancora} onChange={set('ke_base_ancora')} inputMode="decimal" /></div>
          <div><Label>Prêmio risco equity</Label><Input value={f.ke_base_re} onChange={set('ke_base_re')} inputMode="decimal" /></div>
          <div><Label>Prêmio tamanho</Label><Input value={f.ke_base_tam} onChange={set('ke_base_tam')} inputMode="decimal" /></div>
          <div><Label>Prêmio iliquidez/controle</Label><Input value={f.ke_base_iliq} onChange={set('ke_base_iliq')} inputMode="decimal" /></div>
          <div className="col-span-2 mt-2 font-medium">Normalização (comingling)</div>
          <div><Label>Pró-labore real (R$/mês)</Label><Input value={f.prolabore_real} onChange={set('prolabore_real')} inputMode="decimal" /></div>
          <div><Label>Pró-labore mercado (R$/mês)</Label><Input value={f.prolabore_mercado} onChange={set('prolabore_mercado')} inputMode="decimal" /></div>
          <div><Label>Aluguel mercado (R$/mês)</Label><Input value={f.aluguel_mercado} onChange={set('aluguel_mercado')} inputMode="decimal" /></div>
          <div><Label>Intercompany no giro (R$)</Label><Input value={f.intercompany_giro} onChange={set('intercompany_giro')} inputMode="decimal" /></div>
        </div>
        <DialogFooter>
          <Button onClick={salvar} disabled={update.isPending}>{update.isPending ? 'Salvando…' : 'Salvar'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
