import { useState, useEffect } from 'react';
import { useCompany } from '@/contexts/CompanyContext';
import { useAuth } from '@/contexts/AuthContext';
import { useCashflowConfig, useUpdateCashflowConfig } from '@/hooks/useCashflowConfig';
import { useEstoqueValor, useSalvarEstoque, estimarEstoqueOmie } from '@/hooks/useEstoqueValor';
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

  const { data: estoqueAtual } = useEstoqueValor(activeCompany);
  const salvarEstoque = useSalvarEstoque(activeCompany);
  const [estoqueValor, setEstoqueValor] = useState<string>('');
  const [estoqueDataRef, setEstoqueDataRef] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [estoqueEstimando, setEstoqueEstimando] = useState(false);
  const [estoqueEstimativa, setEstoqueEstimativa] = useState<{ cobertura_pct: number } | null>(null);

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

  const fmtBRL = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });

  const handleSalvarEstoque = async () => {
    const valor = Number(estoqueValor);
    if (!estoqueValor || Number.isNaN(valor) || !estoqueDataRef) {
      toast.error('Informe valor e data de referência');
      return;
    }
    try {
      await salvarEstoque.mutateAsync(
        estoqueEstimativa
          ? { valor, data_ref: estoqueDataRef, fonte: 'omie_estimado', cobertura_pct: estoqueEstimativa.cobertura_pct }
          : { valor, data_ref: estoqueDataRef }
      );
      toast.success('Valor de estoque salvo');
      setEstoqueValor('');
      setEstoqueEstimativa(null);
    } catch (err) {
      toast.error('Falha: ' + String((err as Error).message ?? err));
    }
  };

  const handleEstimarOmie = async () => {
    setEstoqueEstimando(true);
    try {
      const r = await estimarEstoqueOmie(activeCompany);
      setEstoqueValor(String(r.valor_estimado));
      setEstoqueEstimativa({ cobertura_pct: r.cobertura_pct });
      toast.message(`Estimativa: ${fmtBRL(r.valor_estimado)} · cobertura ${r.cobertura_pct}% (${r.skus_com_custo}/${r.skus_total} SKUs com custo)`);
    } catch (err) {
      toast.error('Falha ao estimar: ' + String((err as Error).message ?? err));
    } finally {
      setEstoqueEstimando(false);
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

          <Card>
            <CardHeader><CardTitle className="text-sm">Valor de estoque (balancete)</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {estoqueAtual ? (
                <p className="text-xs text-muted-foreground">
                  Atual: {fmtBRL(estoqueAtual.valor)} · ref {estoqueAtual.data_ref} · {estoqueAtual.fonte}
                  {estoqueAtual.cobertura_pct != null ? ` · cobertura ${estoqueAtual.cobertura_pct}%` : ''}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">Nenhum valor de estoque registrado ainda.</p>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Valor (R$)</Label>
                  <Input type="number" step="0.01" min="0" placeholder="120000" value={estoqueValor} onChange={e => { setEstoqueValor(e.target.value); setEstoqueEstimativa(null); }} />
                </div>
                <div>
                  <Label>Data de referência</Label>
                  <Input type="date" value={estoqueDataRef} onChange={e => setEstoqueDataRef(e.target.value)} />
                </div>
              </div>
              {estoqueEstimativa && (
                <p className="text-xs text-muted-foreground">Valor pré-preenchido pela estimativa do Omie (cobertura {estoqueEstimativa.cobertura_pct}%). Revise antes de salvar.</p>
              )}
              <div className="flex gap-2">
                <Button variant="outline" onClick={handleEstimarOmie} disabled={estoqueEstimando}>
                  {estoqueEstimando ? 'Estimando…' : 'Estimar do Omie'}
                </Button>
                <Button onClick={handleSalvarEstoque} disabled={salvarEstoque.isPending}>
                  {salvarEstoque.isPending ? 'Salvando…' : 'Salvar'}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">Alimenta o cálculo de NCG / capital de giro. A estimativa do Omie não salva automaticamente.</p>
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
