import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { ResumoDia } from '@/services/financeiroExtratoBancario';
import { INDISPONIVEL, formatarCentavos, formatarDataIso } from './formatar';

function Celula({ valor, className }: { valor: number | null; className?: string }) {
  return (
    <TableCell className={`text-right tabular-nums ${valor === null ? 'text-muted-foreground' : ''} ${className ?? ''}`}>
      {formatarCentavos(valor)}
    </TableCell>
  );
}

/**
 * Resumo diário do extrato. Dia não coberto por arquivo aceito → "indisponível" (ausente ≠ zero).
 * A coluna Omie ainda não tem fonte (Task 9b liga `saldo_omie_centavos`): sempre "indisponível".
 */
export function ResumoDiarioExtrato({ dias }: { dias: ResumoDia[] }) {
  return (
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
            <TableCell className="text-right text-muted-foreground">{INDISPONIVEL}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
