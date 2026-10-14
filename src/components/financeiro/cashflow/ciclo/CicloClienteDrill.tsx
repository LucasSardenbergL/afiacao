import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useCicloTitulosCliente } from '@/hooks/useFinanceiroCiclo';
import { porDia, sugerirAlavanca, type ResumoCliente } from '@/lib/financeiro/ciclo-cliente-helpers';
import type { Company } from '@/contexts/CompanyContext';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { brl } from './ciclo-format';

const ROTULO_SITUACAO: Record<string, string> = {
  paga: 'Paga',
  paga_sem_baixa: 'Paga (sem data de baixa)',
  vencida_aberta: 'Vencida em aberto',
  status_ambiguo: 'Status ambíguo',
};

export function CicloClienteDrill({ cliente, hoje, onFechar }: { cliente: ResumoCliente | null; hoje: string; onFechar: () => void }) {
  const q = useCicloTitulosCliente((cliente?.company as Company | undefined) ?? null, cliente?.omieCodigoCliente ?? null);
  const s = cliente ? sugerirAlavanca(cliente, hoje) : null;
  // Conta aberta do cenário de cobrança: só com os 3 fatos presentes (senão o motivo já aparece acima).
  const dia = cliente ? porDia(cliente.volumeEmitido12m) : null;
  const excesso = cliente?.excessoCarenciaPond ?? null;
  const contaCobranca = s?.alavanca === 'cobrar_atraso' && s.cenario?.reais != null && dia !== null && excesso !== null
    ? `excesso ${excesso.toFixed(1).replace('.', ',')} d × ${brl(dia, 2)}/dia = ${brl(s.cenario.reais)} (cenário, não é previsão)`
    : null;
  return (
    <Sheet open={cliente !== null} onOpenChange={(o) => { if (!o) onFechar(); }}>
      <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{cliente ? cliente.nomeCliente ?? `#${cliente.omieCodigoCliente}` : ''}</SheetTitle>
          <SheetDescription>Parcelas pagas (12 meses), pagas sem data de baixa, vencidas em aberto e com status ambíguo.</SheetDescription>
        </SheetHeader>
        {s && (
          <div className="my-3 rounded-md border p-3 text-sm">
            <div className="font-medium">{s.texto || 'Sem sugestão'}</div>
            {s.cenario && (
              <div className="text-xs text-muted-foreground">
                {s.cenario.rotulo} — {s.cenario.reais === null ? `— (${s.cenario.motivo})` : `${brl(s.cenario.reais)} (${s.cenario.motivo})`}
              </div>
            )}
            {contaCobranca && <div className="text-xs font-mono" data-testid="ciclo-drill-conta">{contaCobranca}</div>}
            {s.degrau && <div className="text-xs">Prazo {s.degrau.de}d → {s.degrau.para}d (parcela única).</div>}
            {s.alavanca === 'degrau_prazo' && !s.degrau && s.cenario && (
              <div className="text-xs">Sem degrau numérico: {s.cenario.motivo}.</div>
            )}
          </div>
        )}
        {q.isLoading && <PageSkeleton variant="list" />}
        {q.error && <p className="text-status-error text-sm">Não foi possível ler as parcelas deste cliente.</p>}
        {q.data && q.data.length === 0 && <p className="text-sm text-muted-foreground">Sem parcelas com dados completos para este cliente.</p>}
        {q.data && q.data.length > 0 && (
          <Table>
            <TableHeader><TableRow>
              <TableHead>NF</TableHead><TableHead>Vencimento</TableHead><TableHead>Situação</TableHead>
              <TableHead className="text-right">Valor</TableHead><TableHead className="text-right">Concedido</TableHead><TableHead className="text-right">Atraso</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {q.data.map((t) => (
                <TableRow key={t.lancamento}>
                  <TableCell>{t.documento ?? '—'}</TableCell>
                  <TableCell>{t.vencimento}</TableCell>
                  <TableCell>
                    {t.situacao === 'vencida_aberta'
                      ? <span className="text-status-error">{ROTULO_SITUACAO.vencida_aberta}{t.diasVencido === null ? '' : ` há ${t.diasVencido}d`}</span>
                      : t.situacao === 'status_ambiguo'
                        ? <span className="text-status-warning">{ROTULO_SITUACAO.status_ambiguo}</span>
                        : ROTULO_SITUACAO[t.situacao] ?? t.situacao.replace(/_/g, ' ')}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {t.situacao === 'vencida_aberta' && t.saldo === null
                      ? <>{brl(t.valor, 2)} <span className="text-xs text-muted-foreground">(valor original; saldo ausente)</span></>
                      : brl(t.situacao === 'vencida_aberta' ? t.saldo : t.valor, 2)}
                  </TableCell>
                  <TableCell className="text-right font-mono">{t.prazoConcedido}d</TableCell>
                  <TableCell className={`text-right font-mono ${t.atraso !== null && t.atraso > 3 ? 'text-status-warning' : ''}`}>
                    {t.atraso === null ? '—' : `${t.atraso.toFixed(0)}d`}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SheetContent>
    </Sheet>
  );
}
