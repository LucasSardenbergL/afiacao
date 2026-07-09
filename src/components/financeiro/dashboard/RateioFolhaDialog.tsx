// src/components/financeiro/dashboard/RateioFolhaDialog.tsx
// F3 v2 — master lança o rateio de custo fixo compartilhado (parcela da folha da CSC atribuível à OBEN).
// Referência VIVA: a folha 2.03.* da origem (composição, marcando ambíguos) como TETO — nunca pré-preenche.
// Três ações distintas (Codex-C4): Salvar / Confirmar sem folha (R$0) / Remover (desativa → volta a pendente).
import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { AlertTriangle } from 'lucide-react';
import { useSalvarCustoRateio, useFolhaReferencia, type CustoRateioRow } from '@/hooks/usePontoEquilibrio';
import { fmt } from '@/components/financeiro/dashboard/format';

/** Parse fail-closed de R$ digitado (pt-BR): retorna null em ilegível/negativo (nunca fabrica 0). */
function parseValor(s: string): number | null {
  const limpo = s.trim().replace(/\./g, '').replace(',', '.');
  if (limpo === '') return null;
  const n = Number(limpo);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function RateioFolhaDialog({
  company,
  origem,
  rotulo,
  atual,
  open,
  onOpenChange,
}: {
  company: string;
  origem: string;
  rotulo: string;
  atual: CustoRateioRow | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const salvar = useSalvarCustoRateio();
  const ref = useFolhaReferencia(origem);
  const [valor, setValor] = useState(atual ? String(atual.valor_mensal_brl).replace('.', ',') : '');
  const [obs, setObs] = useState(atual?.observacao ?? '');

  const parsed = parseValor(valor);
  const obsOk = obs.trim().length > 0;
  const podeSalvar = parsed != null && parsed > 0 && obsOk && !salvar.isPending;
  const podeZerar = obsOk && !salvar.isPending;

  const gravar = (valor_mensal_brl: number, ativo: boolean) =>
    salvar.mutate(
      {
        company,
        rotulo,
        valor_mensal_brl,
        origem_company: origem,
        observacao: obs.trim() || 'sem folha atribuível',
        ativo,
      },
      { onSuccess: () => onOpenChange(false) },
    );

  const origemLabel = origem.replace('_', ' ').toUpperCase();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Rateio da folha — {company.toUpperCase()}</DialogTitle>
          <DialogDescription>
            A folha da {company.toUpperCase()} roda na {origemLabel}. Lance a parcela mensal atribuível à operação — o
            PE a soma ao custo fixo.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1">
            <label className="text-xs font-medium">Custo mensal normalizado (R$)</label>
            <Input
              inputMode="decimal"
              value={valor}
              onChange={(e) => setValor(e.target.value)}
              placeholder="ex.: 18.000"
            />
            <p className="text-[10px] text-muted-foreground">Anual ÷ 12, já com 13º, férias e encargos.</p>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium">Como chegou nesse valor? (obrigatório)</label>
            <Textarea
              value={obs}
              onChange={(e) => setObs(e.target.value)}
              placeholder="ex.: 70% da folha da CSC = 5 pessoas alocadas na operação da OBEN"
              className="text-xs min-h-[60px]"
            />
          </div>

          {/* Referência viva: composição da folha da origem (TETO, não pré-preenche). */}
          <div className="rounded-lg border p-3 space-y-2 bg-muted/30">
            <p className="text-xs font-medium">
              Referência — folha da {origemLabel}:{' '}
              {ref.isLoading ? '…' : <strong>{fmt(ref.totalMes)}/mês</strong>}
              {!ref.isLoading && ref.totalLimpoMes !== ref.totalMes && (
                <span className="text-muted-foreground"> (sem ambíguos: {fmt(ref.totalLimpoMes)})</span>
              )}
            </p>
            <p className="text-[10px] text-muted-foreground">
              Teto — a parcela da {company.toUpperCase()} é uma fração ({origemLabel} tem operação própria).
            </p>
            <div className="max-h-40 overflow-y-auto divide-y text-[11px]">
              {ref.linhas.map((l) => (
                <div key={l.codigo} className="flex items-center justify-between py-1 gap-2">
                  <span className="truncate">
                    {l.descricao || l.codigo}
                    {l.ambiguo && (
                      <span className="ml-1 inline-flex items-center gap-0.5 text-status-warning">
                        <AlertTriangle className="w-2.5 h-2.5" /> retenção do empregado (já no salário bruto)
                      </span>
                    )}
                  </span>
                  <span className="font-mono shrink-0">{fmt(l.mediaMes)}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap justify-end gap-2 pt-1">
            {atual && (
              <Button
                variant="ghost"
                size="sm"
                disabled={salvar.isPending}
                onClick={() => gravar(atual.valor_mensal_brl, false)}
                className="text-status-error"
              >
                Remover
              </Button>
            )}
            <Button variant="outline" size="sm" disabled={!podeZerar} onClick={() => gravar(0, true)}>
              Confirmar sem folha (R$ 0)
            </Button>
            <Button size="sm" disabled={!podeSalvar} onClick={() => parsed != null && gravar(parsed, true)}>
              Salvar rateio
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
