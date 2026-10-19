import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { descontoNoDrill, type ResumoFornecedor, type TituloCp } from '@/lib/financeiro/ciclo-fornecedor-helpers';
import { brl, dias, nomeFornecedor } from './ciclo-format';
import { CicloPontualidade } from './CicloPontualidade';

const ROTULO_SITUACAO: Record<string, string> = {
  paga: 'Paga',
  paga_sem_baixa: 'Paga (sem data de baixa)',
  paga_parcial: 'Paga em parte',
  vencida_aberta: 'Vencida em aberto',
  a_vencer: 'A vencer',
  status_ambiguo: 'Status ambíguo',
};

export function CicloFornecedorDrill({ fornecedor, titulos, hoje, onFechar }: {
  fornecedor: ResumoFornecedor | null; titulos: TituloCp[]; hoje: string; onFechar: () => void;
}) {
  const doFornecedor = fornecedor === null ? [] : titulos
    .filter((t) => t.company === fornecedor.company && t.fornecedor === fornecedor.fornecedor)
    .sort((a, b) => (a.vencimento < b.vencimento ? 1 : -1));
  return (
    <Sheet open={fornecedor !== null} onOpenChange={(o) => { if (!o) onFechar(); }}>
      <SheetContent className="w-full sm:max-w-3xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{fornecedor ? nomeFornecedor(fornecedor) : ''}</SheetTitle>
          <SheetDescription>Títulos de compra (12 meses): pagos, pagos em parte, vencidos em aberto e a vencer.</SheetDescription>
        </SheetHeader>
        <div className="mt-4 space-y-4 text-sm">
          <CicloPontualidade titulos={doFornecedor} hoje={hoje} rotulo="Pontualidade do fornecedor" />
          <Table>
            <TableHeader><TableRow>
              <TableHead>Documento</TableHead><TableHead>Vencimento</TableHead><TableHead>Baixa</TableHead>
              <TableHead className="text-right">Valor</TableHead><TableHead className="text-right">Prazo</TableHead>
              <TableHead className="text-right">Atraso</TableHead><TableHead className="text-right">Desconto obtido</TableHead>
              <TableHead className="text-right">Juros/multa</TableHead><TableHead className="text-right">Em aberto</TableHead>
              <TableHead>Situação</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {doFornecedor.map((t) => {
                const d = descontoNoDrill(t);
                return (
                <TableRow key={t.lancamento}>
                  <TableCell>{t.documento ?? `#${t.lancamento}`}</TableCell>
                  <TableCell>{t.vencimento}</TableCell>
                  <TableCell>{t.dataBaixa ?? '—'}{t.dataBaixa && !t.dataBaixaConfiavel ? ' (data incerta)' : ''}</TableCell>
                  <TableCell className="text-right font-mono">{brl(t.valor, 2)}</TableCell>
                  <TableCell className="text-right font-mono">{dias(t.prazoConcedido)}</TableCell>
                  <TableCell className="text-right font-mono">{t.dataBaixaConfiavel ? dias(t.atrasoBaixa) : '—'}</TableCell>
                  <TableCell className="text-right font-mono">
                    {brl(d.obtido, 2)}
                    {d.informadoNaoConfirmado !== null && (
                      <span className="block text-xs text-muted-foreground">informado {brl(d.informadoNaoConfirmado, 2)}, não confirmado</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-mono">{brl(t.encargoPago, 2)}</TableCell>
                  <TableCell className="text-right font-mono">
                    {brl(t.valorAberto, 2)}
                    {t.valorAberto !== null && t.fonteValorAberto === 'valor_titulo' && (
                      <span className="text-xs text-muted-foreground" title="Sem o resumo do Omie: o aberto é o valor cheio do título (estimativa)."> (valor do título)</span>
                    )}
                  </TableCell>
                  <TableCell>{ROTULO_SITUACAO[t.situacao] ?? t.situacao}</TableCell>
                </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </SheetContent>
    </Sheet>
  );
}
