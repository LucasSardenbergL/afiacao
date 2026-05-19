import { useState, useEffect } from 'react';
import { useCompany } from '@/contexts/CompanyContext';
import { useAuth } from '@/contexts/AuthContext';
import { useCashflowConfig, useUpdateCashflowConfig } from '@/hooks/useCashflowConfig';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from 'sonner';

type Props = { open: boolean; onOpenChange: (open: boolean) => void };

export function ConfigCashflowDialog({ open, onOpenChange }: Props) {
  const { activeCompany } = useCompany();
  const { isMaster } = useAuth();
  const { data: config } = useCashflowConfig(activeCompany);
  const update = useUpdateCashflowConfig();

  const [thresholds, setThresholds] = useState(config?.thresholds);
  const [overrides, setOverrides] = useState(config?.overrides_cenario);
  const [adiantamentos, setAdiantamentos] = useState<string>('');

  useEffect(() => {
    if (config) {
      setThresholds(config.thresholds);
      setOverrides(config.overrides_cenario);
      setAdiantamentos(config.adiantamento_categorias_codigos.join(', '));
    }
  }, [config]);

  if (!isMaster) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader><DialogTitle>Permissão insuficiente</DialogTitle></DialogHeader>
          <p className="text-sm">Apenas master pode editar configuração de cashflow.</p>
          <DialogFooter><Button onClick={() => onOpenChange(false)}>OK</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  const handleSave = async () => {
    if (!thresholds || !overrides) return;
    try {
      await update.mutateAsync({
        company: activeCompany,
        patch: {
          thresholds,
          overrides_cenario: overrides,
          adiantamento_categorias_codigos: adiantamentos.split(',').map(s => s.trim()).filter(Boolean),
        },
      });
      toast.success('Configuração salva');
      onOpenChange(false);
    } catch (err) {
      toast.error('Falha: ' + String((err as Error).message ?? err));
    }
  };

  if (!thresholds || !overrides) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Configuração de Cashflow — {activeCompany}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-sm">Thresholds de alertas</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-2 gap-3">
              <div>
                <Label>Caixa negativo (semanas pra alertar)</Label>
                <Input type="number" min="1" max="13" value={thresholds.caixa_negativo_semanas} onChange={e => setThresholds({ ...thresholds, caixa_negativo_semanas: Number(e.target.value) })} />
              </div>
              <div>
                <Label>Dias cobertura mínimo</Label>
                <Input type="number" min="0" value={thresholds.dias_cobertura_min} onChange={e => setThresholds({ ...thresholds, dias_cobertura_min: Number(e.target.value) })} />
              </div>
              <div>
                <Label>Inadimplência máxima (%)</Label>
                <Input type="number" step="0.1" min="0" max="100" value={thresholds.inadimplencia_max_pct} onChange={e => setThresholds({ ...thresholds, inadimplencia_max_pct: Number(e.target.value) })} />
              </div>
              <div>
                <Label>Concentração top1 máxima (%)</Label>
                <Input type="number" step="0.1" min="0" max="100" value={thresholds.concentracao_top1_max_pct} onChange={e => setThresholds({ ...thresholds, concentracao_top1_max_pct: Number(e.target.value) })} />
              </div>
              <div>
                <Label>PMR crescimento máx 90d (%)</Label>
                <Input type="number" step="0.1" min="0" value={thresholds.pmr_crescimento_max_pct_90d} onChange={e => setThresholds({ ...thresholds, pmr_crescimento_max_pct_90d: Number(e.target.value) })} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-sm">Deltas de cenário (% sobre realista)</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-2 gap-3">
              <div>
                <Label>Otimista: recebimento no prazo Δ%</Label>
                <Input type="number" step="1" value={overrides.otimista.recebimento_no_prazo_pct_delta} onChange={e => setOverrides({ ...overrides, otimista: { ...overrides.otimista, recebimento_no_prazo_pct_delta: Number(e.target.value) } })} />
              </div>
              <div>
                <Label>Otimista: inadimplência Δ%</Label>
                <Input type="number" step="1" value={overrides.otimista.inadimplencia_pct_delta} onChange={e => setOverrides({ ...overrides, otimista: { ...overrides.otimista, inadimplencia_pct_delta: Number(e.target.value) } })} />
              </div>
              <div>
                <Label>Pessimista: recebimento no prazo Δ%</Label>
                <Input type="number" step="1" value={overrides.pessimista.recebimento_no_prazo_pct_delta} onChange={e => setOverrides({ ...overrides, pessimista: { ...overrides.pessimista, recebimento_no_prazo_pct_delta: Number(e.target.value) } })} />
              </div>
              <div>
                <Label>Pessimista: inadimplência Δ%</Label>
                <Input type="number" step="1" value={overrides.pessimista.inadimplencia_pct_delta} onChange={e => setOverrides({ ...overrides, pessimista: { ...overrides.pessimista, inadimplencia_pct_delta: Number(e.target.value) } })} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-sm">Códigos Omie de adiantamentos a fornecedores</CardTitle></CardHeader>
            <CardContent>
              <Label>Códigos separados por vírgula</Label>
              <Input placeholder="2.01.01, 2.01.02" value={adiantamentos} onChange={e => setAdiantamentos(e.target.value)} />
              <p className="text-xs text-muted-foreground mt-1">CPs com esses códigos serão tratados como ACO (adiantamentos) em vez de PCO.</p>
            </CardContent>
          </Card>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button onClick={handleSave}>Salvar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
