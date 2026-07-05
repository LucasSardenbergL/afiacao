// src/components/financeiro/dashboard/ClassificacaoCustoDialog.tsx
// F3 — UI master p/ classificar as categorias de despesa (fixo/variavel/misto/nao_operacional).
// Ordenada por valor (maior primeiro), mostra a descrição de fin_categorias (código é opaco — §0.3),
// cobertura, e EXIGE observação p/ nao_operacional (delta-E2/E4: anti-"balde de fuga"). Warn ao marcar
// um código de descrição obviamente operacional como nao_operacional.
import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { AlertTriangle, Check } from 'lucide-react';
import {
  useDreCategoriasClassificar,
  useSalvarDreClassificacao,
  type CategoriaClassificar,
} from '@/hooks/usePontoEquilibrio';
import type { TipoCusto } from '@/lib/financeiro/ponto-equilibrio-helpers';
import { fmtCompact } from '@/components/financeiro/dashboard/format';

const TIPOS: { value: TipoCusto; label: string }[] = [
  { value: 'variavel', label: 'Variável' },
  { value: 'fixo', label: 'Fixo' },
  { value: 'misto', label: 'Misto (semivariável)' },
  { value: 'nao_operacional', label: 'Não-operacional (dívida/financiamento)' },
];

// Palavras que denunciam custo OPERACIONAL — warn se marcado nao_operacional (delta-E4).
const OPERACIONAL_RX = /compra|mercadoria|folha|sal[áa]rio|aluguel|frete|energia|imposto|icms|pis|cofins|iss/i;

export function ClassificacaoCustoDialog({
  company,
  open,
  onOpenChange,
}: {
  company: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { categorias, isLoading } = useDreCategoriasClassificar(company);
  const classificadoPct = 1 - somaNaoClassificado(categorias);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Classificar custos — {company.toUpperCase()}</DialogTitle>
          <DialogDescription>
            Marque cada categoria como fixo, variável, misto ou não-operacional. Cobertura por valor:{' '}
            <strong>{(classificadoPct * 100).toFixed(0)}%</strong> (o PE exige ≥ 95%). Não-operacional (amortização
            de dívida, parcelamento) é <strong>excluído</strong> do PE e exige justificativa.
          </DialogDescription>
        </DialogHeader>

        <div className="overflow-y-auto -mx-6 px-6 divide-y">
          {isLoading ? (
            <p className="text-sm text-muted-foreground py-8 text-center">Carregando categorias…</p>
          ) : categorias.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">Sem despesas no período.</p>
          ) : (
            categorias.map((c) => <LinhaClassificacao key={c.codigo} company={company} cat={c} />)
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function somaNaoClassificado(cats: CategoriaClassificar[]): number {
  const total = cats.reduce((s, c) => s + c.valorTTM, 0);
  if (total <= 0) return 0;
  return cats.reduce((s, c) => s + (c.tipo == null ? c.valorTTM : 0), 0) / total;
}

function LinhaClassificacao({ company, cat }: { company: string; cat: CategoriaClassificar }) {
  const salvar = useSalvarDreClassificacao();
  const [tipo, setTipo] = useState<TipoCusto | null>(cat.tipo);
  const [obs, setObs] = useState(cat.observacao ?? '');

  const precisaObs = tipo === 'nao_operacional';
  const obsVazia = precisaObs && obs.trim().length === 0;
  const warnOperacional = tipo === 'nao_operacional' && OPERACIONAL_RX.test(cat.descricao);
  const mudou = tipo !== cat.tipo || (precisaObs && obs !== (cat.observacao ?? ''));
  const podeSalvar = tipo != null && !obsVazia && mudou;

  return (
    <div className="py-3 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">{cat.descricao || '(sem descrição)'}</p>
          <p className="text-[11px] text-muted-foreground font-mono">
            {cat.codigo} · {fmtCompact(cat.valorTTM)} · {(cat.pctDespesas * 100).toFixed(1)}%
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {cat.tipo == null && cat.pctDespesas > 0.05 && (
            <Badge variant="outline" className="text-[10px] text-status-warning border-status-warning/40">
              material
            </Badge>
          )}
          <Select value={tipo ?? undefined} onValueChange={(v) => setTipo(v as TipoCusto)}>
            <SelectTrigger className="w-[210px] h-8 text-xs">
              <SelectValue placeholder="Classificar…" />
            </SelectTrigger>
            <SelectContent>
              {TIPOS.map((t) => (
                <SelectItem key={t.value} value={t.value} className="text-xs">
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {precisaObs && (
        <div className="space-y-1 pl-1">
          <Input
            value={obs}
            onChange={(e) => setObs(e.target.value)}
            placeholder="Justificativa obrigatória (ex.: amortização de principal — financiamento)"
            className="h-8 text-xs"
          />
          {warnOperacional && (
            <p className="flex items-center gap-1 text-[11px] text-status-warning">
              <AlertTriangle className="w-3 h-3 shrink-0" />
              A descrição parece um custo operacional — confirme que é mesmo financiamento/dívida antes de excluir.
            </p>
          )}
        </div>
      )}

      {mudou && (
        <div className="flex justify-end">
          <Button
            size="sm"
            className="h-7 gap-1 text-xs"
            disabled={!podeSalvar || salvar.isPending}
            onClick={() =>
              tipo &&
              salvar.mutate({ company, categoria_codigo: cat.codigo, tipo, observacao: precisaObs ? obs.trim() : null })
            }
          >
            <Check className="w-3 h-3" />
            Salvar
          </Button>
        </div>
      )}
    </div>
  );
}
