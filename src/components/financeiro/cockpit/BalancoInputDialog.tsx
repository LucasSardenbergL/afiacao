// Input master-only do balanço (ANC/PNC/PL) para o selo de cobertura estrutural do giro (Fleuriet).
// Upsert por (company, data_ref) em fin_balanco_inputs. A microcopy alerta as armadilhas de
// classificação (empréstimo de sócio, parcelamento fiscal, ativo não operacional) — Codex.
import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';

const num = (v: string): number | null => (v.trim() === '' || Number.isNaN(Number(v)) ? null : Number(v));

export function BalancoInputDialog({ company, empresaLabel, onSaved }: { company: string; empresaLabel: string; onSaved?: () => void }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [f, setF] = useState({ data_ref: '', anc: '', pnc: '', pl: '', observacao: '' });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((s) => ({ ...s, [k]: e.target.value }));

  const salvar = async () => {
    const anc = num(f.anc), pnc = num(f.pnc), pl = num(f.pl);
    if (!f.data_ref || anc == null || pnc == null || pl == null) {
      toast.error('Preencha data, ANC, PNC e PL.');
      return;
    }
    setSaving(true);
    try {
      const uid = (await supabase.auth.getUser()).data.user?.id ?? null;
      const { error } = await supabase.from('fin_balanco_inputs').upsert({
        company, data_ref: f.data_ref,
        ativo_nao_circulante: anc, passivo_nao_circulante: pnc, patrimonio_liquido: pl,
        observacao: f.observacao || null, updated_at: new Date().toISOString(), updated_by: uid,
      }, { onConflict: 'company,data_ref' });
      if (error) throw error;
      toast.success('Balanço salvo. Recalculando cobertura…');
      setOpen(false);
      onSaved?.();
    } catch (e) {
      toast.error('Falha ao salvar balanço', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm" variant="outline">Informar balanço ({empresaLabel})</Button></DialogTrigger>
      <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Balanço (Fleuriet) — {empresaLabel}</DialogTitle></DialogHeader>
        <div className="grid grid-cols-1 gap-3 text-sm">
          <div className="text-xs text-muted-foreground">Contas permanentes do balancete, em R$. A classificação casa com o NCG do sistema a ±7 dias desta data.</div>
          <div>
            <Label>Data de referência</Label>
            <Input type="date" value={f.data_ref} onChange={set('data_ref')} />
            <p className="text-xs text-muted-foreground mt-1">Data do balancete.</p>
          </div>
          <div>
            <Label>Ativo Não Circulante (R$)</Label>
            <Input value={f.anc} onChange={set('anc')} inputMode="decimal" />
            <p className="text-xs text-muted-foreground mt-1">Realizável LP + investimentos + imobilizado + intangível. Só operacional; exclua imóvel/veículo não operacional e reavaliação.</p>
          </div>
          <div>
            <Label>Passivo Não Circulante (R$)</Label>
            <Input value={f.pnc} onChange={set('pnc')} inputMode="decimal" />
            <p className="text-xs text-muted-foreground mt-1">Exigível de longo prazo (&gt;12m). Parcelamento fiscal: só a parcela de LP; a de curto prazo não entra aqui.</p>
          </div>
          <div>
            <Label>Patrimônio Líquido (R$)</Label>
            <Input value={f.pl} onChange={set('pl')} inputMode="decimal" />
            <p className="text-xs text-muted-foreground mt-1">Capital + reservas + lucros. Empréstimo de sócio só conta como PL se formalmente capitalizado/subordinado; senão é passivo.</p>
          </div>
          <div>
            <Label>Observação (opcional)</Label>
            <Input value={f.observacao} onChange={set('observacao')} />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={salvar} disabled={saving}>{saving ? 'Salvando…' : 'Salvar'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
