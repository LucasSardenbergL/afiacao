import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { ResumoDia } from '@/services/financeiroExtratoBancario';
import { diferencaDoCorte, formatarCentavos, formatarDataIso, INDISPONIVEL } from './formatar';

function Celula({ valor, className }: { valor: number | null; className?: string }) {
  return (
    <TableCell className={`text-right tabular-nums ${valor === null ? 'text-muted-foreground' : ''} ${className ?? ''}`}>
      {formatarCentavos(valor)}
    </TableCell>
  );
}

/**
 * Resumo diário do extrato. Dia não coberto por arquivo aceito → "indisponível" (ausente ≠ zero).
 * Coluna Omie = foto diária do saldo Omie (`saldo_omie_centavos`); `null` → "indisponível".
 * "Diferença do corte" = saldo Itaú − saldo Omie no último dia coberto com saldo Itaú conhecido; ainda NÃO calibrada.
 */
export function ResumoDiarioExtrato({ dias }: { dias: ResumoDia[] }) {
  const corte = diferencaDoCorte(dias);
  return (
    <>
      <section className="mb-4 rounded-md border p-3 text-sm" data-testid="diferenca-do-corte">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-medium">Diferença do corte</h3>
          <span className="rounded bg-status-warning/10 px-2 py-0.5 text-xs text-status-warning">não calibrada</span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Ainda não medimos a que dia a foto do saldo Omie corresponde; use a diferença só como indício, não como conciliação.
        </p>
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted-foreground">Data de corte</dt>
            <dd className="tabular-nums">{corte.dataCorte === null ? INDISPONIVEL : formatarDataIso(corte.dataCorte)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Saldo Itaú</dt>
            <dd className="tabular-nums">{formatarCentavos(corte.saldoItau)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Saldo Omie</dt>
            <dd className="tabular-nums">{formatarCentavos(corte.saldoOmie)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Diferença</dt>
            <dd className="tabular-nums" data-testid="diferenca-valor">{formatarCentavos(corte.diferenca)}</dd>
          </div>
        </dl>
      </section>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Data</TableHead>
            <TableHead className="text-right">Créditos</TableHead>
            <TableHead className="text-right">Débitos</TableHead>
            <TableHead className="text-right">Saldo do dia</TableHead>
            <TableHead className="text-right">Saldo Omie</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {dias.map((d) => (
            <TableRow key={d.data} data-coberto={d.coberto ? 'sim' : 'nao'}>
              <TableCell className="tabular-nums">{formatarDataIso(d.data)}</TableCell>
              <Celula valor={d.coberto ? d.creditos : null} />
              <Celula valor={d.coberto ? d.debitos : null} />
              <Celula valor={d.coberto ? d.saldoFinal : null} />
              <Celula valor={d.saldoOmie} />
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
}
