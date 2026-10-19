import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { pontualidadePorMes, type TituloCp } from '@/lib/financeiro/ciclo-fornecedor-helpers';
import { brl } from './ciclo-format';

const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);

/** Pontualidade dos NOSSOS pagamentos por mês de vencimento. % em dia só entre títulos com data de baixa confiável
 *  (a cobertura diz quanto do valor é datável); mês corrente marcado como parcial. */
export function CicloPontualidade({ titulos, hoje, rotulo }: { titulos: TituloCp[]; hoje: string; rotulo: string }) {
  const meses = pontualidadePorMes(titulos, hoje).slice(-12);
  if (meses.length === 0) return <p className="text-xs text-muted-foreground">Sem títulos vencidos para medir pontualidade.</p>;
  return (
    <Table aria-label={rotulo}>
      <TableHeader><TableRow>
        <TableHead>Mês de vencimento</TableHead><TableHead className="text-right">Venceu</TableHead>
        <TableHead className="text-right">Em dia</TableHead><TableHead className="text-right">Atrasado</TableHead>
        <TableHead className="text-right">Data confiável</TableHead><TableHead className="text-right">Em aberto</TableHead>
      </TableRow></TableHeader>
      <TableBody>
        {meses.map((m) => (
          <TableRow key={m.mes}>
            <TableCell>{m.mes.slice(0, 7)}{m.mesParcial ? ' (parcial)' : ''}</TableCell>
            <TableCell className="text-right font-mono">{brl(m.valorVencido)}</TableCell>
            <TableCell className="text-right font-mono">{pct(m.pctEmDia)}</TableCell>
            <TableCell className="text-right font-mono">{pct(m.pctAtrasado)}</TableCell>
            <TableCell className="text-right font-mono">{pct(m.coberturaData)}</TableCell>
            <TableCell className="text-right font-mono">{m.valorAberto > 0 ? <span className="text-status-error">{brl(m.valorAberto)}</span> : '—'}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
