// DFC realizado (método direto) — seção da aba "Fluxo de Caixa". Master-only: a view já filtra.
// O que a tela NÃO pode esconder (Codex, 2026-11-22): o saldo é o CONTÁBIL do Omie (não conciliado com o
// banco); parcela de empréstimo vem sem abertura de juros (o total de juros pagos é parcial); o que ficou
// fora das três atividades aparece em linhas próprias, com o motivo — nada some.
import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { fmtCompact } from '@/components/financeiro/dashboard/format';
import { useFinanceiroDFC } from '@/hooks/useFinanceiroDFC';
import { useDisplayAccess } from '@/hooks/useDisplayAccess';
import { mesesFechados } from '@/lib/financeiro/dfc-helpers';
import { ALL_COMPANIES, type CompanySelection } from '@/contexts/CompanyContext';
import { cn } from '@/lib/utils';
import { mensagemDeErro } from '@/lib/erro-mensagem';

const MES_ABREV = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const rotuloMes = (m: string) => `${MES_ABREV[Number(m.slice(5, 7)) - 1]}/${m.slice(2, 4)}`;
const hojeSp = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());

function Valor({ v, forte = false }: { v: number | undefined | null; forte?: boolean }) {
  if (v === undefined || v === null) return <span className="text-muted-foreground">—</span>;
  return (
    <span className={cn('tabular-nums', v < 0 && 'text-status-error', forte && 'font-semibold')}>
      {fmtCompact(v)}
    </span>
  );
}

export function DFCRealizado({ view, versaoDados }: { view: CompanySelection; versaoDados: number }) {
  // Master-only (a view também filtra). Lente "Ver como": leitura segue a persona exibida.
  const { displayIsMaster } = useDisplayAccess();
  const companies = useMemo(() => (view === 'all' ? [...ALL_COMPANIES] : [view]), [view]);
  const meses = useMemo(() => mesesFechados(hojeSp(), 12), []);
  const { data, isLoading, error } = useFinanceiroDFC(companies, meses, versaoDados, displayIsMaster);
  if (!displayIsMaster) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Demonstração do fluxo de caixa — realizado (método direto)</CardTitle>
        <p className="text-xs text-muted-foreground">
          12 meses fechados · {view === 'all' ? 'soma das 3 empresas (o caixa de cada CNPJ não cobre o de outro)' : view} ·
          saldo contábil do Omie, não conciliado com o banco
        </p>
      </CardHeader>
      <CardContent>
        {isLoading && <Skeleton className="h-60" />}
        {error && (
          <p role="alert" className="text-sm text-status-error">
            DFC indisponível — a leitura falhou: {mensagemDeErro(error) ?? 'erro sem mensagem'}
          </p>
        )}
        {data && !data.temDados && (
          <p className="text-sm text-muted-foreground">Sem movimento de caixa no espelho do Omie nos 12 meses fechados — não é saldo zero conferido.</p>
        )}
        {data && data.temDados && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="sticky left-0 bg-card text-left font-medium py-1.5 pr-3 min-w-[220px]">Linha</th>
                  {data.meses.map((m) => <th key={m} className="text-right font-medium px-2">{rotuloMes(m)}</th>)}
                  <th className="text-right font-medium pl-3">12 meses</th>
                </tr>
              </thead>
              <tbody>
                {data.blocos.map((b) => (
                  <BlocoLinhas key={b.atividade} titulo={b.rotulo} meses={data.meses} total={b.total} porMes={b.porMes}
                    linhas={b.linhas.map((l) => ({ chave: l.linha, rotulo: l.rotulo, porMes: l.porMes, total: l.total,
                      nota: l.linha === 'fin_amortizacao' ? 'O Omie não separa principal e juros na parcela: o total de juros pagos é parcial.' : undefined }))} />
                ))}
                <tr className="border-t-2">
                  <td className="sticky left-0 bg-card py-1.5 pr-3 font-semibold">Variação de caixa das atividades</td>
                  {data.meses.map((m) => <td key={m} className="text-right px-2"><Valor v={data.variacao.porMes[m]} forte /></td>)}
                  <td className="text-right pl-3"><Valor v={data.variacao.total} forte /></td>
                </tr>
                {data.fora.length > 0 && (
                  <>
                    <tr><td colSpan={data.meses.length + 2} className="pt-4 pb-1 font-medium text-muted-foreground">Fora das atividades (visível, não somado acima)</td></tr>
                    {data.fora.map((f) => (
                      <tr key={f.linha} className="border-b border-border/40">
                        <td className="sticky left-0 bg-card py-1 pr-3">
                          <span className="inline-flex items-center gap-1">
                            {f.rotulo}
                            <Tooltip>
                              <TooltipTrigger asChild><Info className="w-3 h-3 text-muted-foreground" aria-label={f.explicacao} /></TooltipTrigger>
                              <TooltipContent className="max-w-xs">{f.explicacao} Entradas {fmtCompact(f.entradas)} · saídas {fmtCompact(f.saidas)} · {f.lancamentos} lançamento(s).</TooltipContent>
                            </Tooltip>
                          </span>
                        </td>
                        {data.meses.map((m) => <td key={m} className="text-right px-2"><Valor v={f.porMes[m]} /></td>)}
                        <td className="text-right pl-3"><Valor v={f.total} /></td>
                      </tr>
                    ))}
                  </>
                )}
              </tbody>
            </table>
            <p className="mt-3 text-xs text-muted-foreground">
              Política IFRS 18: juros e parcelas de empréstimo pagos em financiamento; juros e rendimentos recebidos em
              categoria própria vão para investimento (encargos embutidos na baixa do cliente ficam no recebimento
              operacional); parcelamento de tributo em operacional. Baixa cancelada no Omie pode persistir no espelho.
              Sem base para reconciliar saldo inicial + variação = saldo final no histórico (o Omie guarda só o saldo
              atual das contas).
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function BlocoLinhas({ titulo, meses, porMes, total, linhas }: {
  titulo: string;
  meses: string[];
  porMes: Record<string, number>;
  total: number | null;
  linhas: Array<{ chave: string; rotulo: string; porMes: Record<string, number>; total: number; nota?: string }>;
}) {
  return (
    <>
      <tr><td colSpan={meses.length + 2} className="pt-3 pb-1 font-medium">{titulo}</td></tr>
      {linhas.length === 0 && (
        <tr><td colSpan={meses.length + 2} className="pl-3 py-1 text-muted-foreground">Sem movimento classificado na janela.</td></tr>
      )}
      {linhas.map((l) => (
        <tr key={l.chave} className="border-b border-border/40">
          <td className="sticky left-0 bg-card py-1 pl-3 pr-3">
            {l.rotulo}
            {l.nota && <span className="block text-[11px] text-status-warning-fg">{l.nota}</span>}
          </td>
          {meses.map((m) => <td key={m} className="text-right px-2"><Valor v={l.porMes[m]} /></td>)}
          <td className="text-right pl-3"><Valor v={l.total} /></td>
        </tr>
      ))}
      <tr>
        <td className="sticky left-0 bg-card py-1 pr-3 font-medium">Caixa líquido — {titulo.replace('Atividades ', 'atividades ')}</td>
        {meses.map((m) => <td key={m} className="text-right px-2"><Valor v={porMes[m]} forte /></td>)}
        <td className="text-right pl-3"><Valor v={total} forte /></td>
      </tr>
    </>
  );
}
