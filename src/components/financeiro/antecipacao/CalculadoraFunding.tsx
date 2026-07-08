// src/components/financeiro/antecipacao/CalculadoraFunding.tsx
// F4 Job B — comparação de custo de FUNDING de uma oferta hipotética. NUNCA "vale a pena" (isso
// depende do uso do caixa, §4) — só "mais caro / dentro do seu custo de funding". Compara no MESMO
// período (P1-3): a taxa da oferta vs o hurdle convertido para os mesmos dias. Hurdle editável é
// PRIMÁRIO; o F1 (custo médio do CET) apenas SUGERE, com unidade explícita.
import { useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Calculator, ArrowRight } from 'lucide-react';
import { compararFunding } from '@/lib/financeiro/antecipacao-helpers';
import { useHurdleSugerido } from '@/hooks/useAntecipacoes';
import type { Company, FundingInput, HurdleUnidade } from '@/lib/financeiro/antecipacao-types';

const num = (v: string): number => {
  const n = Number(v.trim().replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};
const pctToDec = (v: string): number => num(v) / 100; // usuário digita 2,5 → 0,025
const pct = (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(2)}%`);
const brl = (v: number | null) =>
  v == null ? '—' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const UNIDADE_LABEL: Record<HurdleUnidade, string> = {
  efetiva_aa: '% a.a. (efetiva)',
  nominal_aa: '% a.a. (nominal/linear)',
  efetiva_am: '% a.m. (efetiva)',
};

const MOTIVO_MSG: Record<string, string> = {
  dados_invalidos: 'Preencha a face, o prazo e a oferta (líquido ou taxa) para calcular.',
  inputs_conflitantes: 'A taxa e o líquido informados não batem — deixe só um deles.',
  hurdle_unidade_invalida: 'Selecione a unidade do hurdle para comparar.',
  hurdle_indisponivel: 'Informe um hurdle (ou use a sugestão do F1) para comparar o funding.',
  fluxo_nao_suportado: 'Fluxo não suportado nesta calculadora.',
};

export function CalculadoraFunding({ company }: { company: Company }) {
  const [valorTitulo, setValorTitulo] = useState('');
  const [dias, setDias] = useState('');
  const [custosAvulsos, setCustosAvulsos] = useState('');
  const [modo, setModo] = useState<'liquido' | 'taxa'>('liquido');
  const [liquido, setLiquido] = useState('');
  const [taxaOfertada, setTaxaOfertada] = useState('');
  const [taxaUnidade, setTaxaUnidade] = useState<HurdleUnidade>('efetiva_am');
  const [hurdleValor, setHurdleValor] = useState('');
  const [hurdleUnidade, setHurdleUnidade] = useState<HurdleUnidade>('efetiva_aa');

  const sugestao = useHurdleSugerido(company);

  const input: FundingInput = useMemo(
    () => ({
      valor_titulo: num(valorTitulo),
      dias: Math.round(num(dias)),
      custos_avulsos: num(custosAvulsos),
      liquido_ofertado: modo === 'liquido' ? num(liquido) : null,
      taxa_ofertada:
        modo === 'taxa' ? { valor: pctToDec(taxaOfertada), unidade: taxaUnidade } : null,
      hurdle: hurdleValor.trim() ? { valor: pctToDec(hurdleValor), unidade: hurdleUnidade } : null,
    }),
    [valorTitulo, dias, custosAvulsos, modo, liquido, taxaOfertada, taxaUnidade, hurdleValor, hurdleUnidade],
  );

  const r = useMemo(() => compararFunding(input), [input]);
  const temCusto = r.custo != null; // custo aparece mesmo sem hurdle

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Calculator className="w-4 h-4 text-status-info" />
          Comparar uma oferta de antecipação
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="space-y-1">
            <Label htmlFor="cf-face">Face do título (R$)</Label>
            <Input id="cf-face" inputMode="decimal" placeholder="Ex.: 100000" value={valorTitulo} onChange={(e) => setValorTitulo(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="cf-dias">Prazo (dias)</Label>
            <Input id="cf-dias" inputMode="numeric" placeholder="Ex.: 30" value={dias} onChange={(e) => setDias(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="cf-avulsos">Custos avulsos (R$)</Label>
            <Input id="cf-avulsos" inputMode="decimal" placeholder="IOF/tarifa" value={custosAvulsos} onChange={(e) => setCustosAvulsos(e.target.value)} />
          </div>
        </div>

        <div className="space-y-2 rounded-md border border-border p-3">
          <Label className="text-sm">Como o banco informou a oferta?</Label>
          <RadioGroup value={modo} onValueChange={(v) => setModo(v as 'liquido' | 'taxa')} className="flex gap-4">
            <div className="flex items-center gap-2">
              <RadioGroupItem value="liquido" id="cf-modo-liq" />
              <Label htmlFor="cf-modo-liq" className="font-normal text-sm">Líquido a receber</Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="taxa" id="cf-modo-taxa" />
              <Label htmlFor="cf-modo-taxa" className="font-normal text-sm">Taxa</Label>
            </div>
          </RadioGroup>

          {modo === 'liquido' ? (
            <div className="space-y-1">
              <Label htmlFor="cf-liquido">Líquido ofertado (R$)</Label>
              <Input id="cf-liquido" inputMode="decimal" placeholder="Ex.: 97000" value={liquido} onChange={(e) => setLiquido(e.target.value)} />
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label htmlFor="cf-taxa">Taxa da oferta</Label>
                <Input id="cf-taxa" inputMode="decimal" placeholder="Ex.: 2,0" value={taxaOfertada} onChange={(e) => setTaxaOfertada(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>Unidade</Label>
                <Select value={taxaUnidade} onValueChange={(v) => setTaxaUnidade(v as HurdleUnidade)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(Object.keys(UNIDADE_LABEL) as HurdleUnidade[]).map((u) => (
                      <SelectItem key={u} value={u}>{UNIDADE_LABEL[u]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
        </div>

        {/* Hurdle editável (primário); F1 sugere */}
        <div className="space-y-2 rounded-md border border-border p-3">
          <div className="flex items-center justify-between">
            <Label className="text-sm">Seu custo de funding alternativo (hurdle)</Label>
            {sugestao.motivo === 'ok' && sugestao.valor != null && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => {
                  setHurdleValor((sugestao.valor! * 100).toFixed(2).replace('.', ','));
                  setHurdleUnidade('efetiva_aa');
                }}
              >
                Usar F1 ({pct(sugestao.valor)} a.a.)
              </Button>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="cf-hurdle">Taxa</Label>
              <Input id="cf-hurdle" inputMode="decimal" placeholder="Ex.: 18,5" value={hurdleValor} onChange={(e) => setHurdleValor(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Unidade</Label>
              <Select value={hurdleUnidade} onValueChange={(v) => setHurdleUnidade(v as HurdleUnidade)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(UNIDADE_LABEL) as HurdleUnidade[]).map((u) => (
                    <SelectItem key={u} value={u}>{UNIDADE_LABEL[u]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        {/* Resultado */}
        <div className="rounded-md border border-border p-3 space-y-2">
          {temCusto ? (
            <>
              <div className="grid grid-cols-3 gap-3">
                <Metric label="Custo da oferta" value={brl(r.custo)} tone="error" />
                <Metric label="Taxa do período" value={pct(r.taxa_periodo)} />
                <Metric label="Efetiva (a.a.)" value={pct(r.taxa_efetiva_aa)} />
              </div>
              {r.motivo === 'ok' && r.veredito != null ? (
                <div
                  className={`flex items-center gap-2 text-sm rounded p-2 ${
                    r.veredito === 'mais_caro'
                      ? 'bg-status-warning-bg text-status-warning-fg'
                      : 'bg-status-success-bg text-status-success'
                  }`}
                >
                  <ArrowRight className="w-4 h-4 shrink-0" />
                  <span>
                    Oferta {pct(r.taxa_periodo)} vs seu funding {pct(r.hurdle_taxa_periodo)} no mesmo prazo —{' '}
                    <strong>
                      {r.veredito === 'mais_caro'
                        ? 'mais caro que sua alternativa de crédito'
                        : 'dentro do seu custo de funding'}
                    </strong>
                    .
                  </span>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">{MOTIVO_MSG[r.motivo] ?? ''}</p>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{MOTIVO_MSG[r.motivo] ?? MOTIVO_MSG.dados_invalidos}</p>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground">
          Comparação de <strong>custo de funding</strong> — não é um veredito de "vale a pena" (isso depende do
          uso do caixa: cobrir buraco, aproveitar desconto de fornecedor, etc.).
        </p>
      </CardContent>
    </Card>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'error' }) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-base font-semibold tabular-nums ${tone === 'error' ? 'text-status-error' : ''}`}>{value}</p>
    </div>
  );
}
