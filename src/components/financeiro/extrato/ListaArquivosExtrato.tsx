import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { textoDoMotivoDesconhecido, type ArquivoExtrato, type StatusArquivo } from '@/services/financeiroExtratoBancario';
import { formatarDataIso } from './formatar';

const STATUS: Record<StatusArquivo, { label: string; cor: string }> = {
  aceito: { label: 'Aceito', cor: 'bg-status-success-bg text-status-success' },
  pendente_revisao: { label: 'Pendente de revisão', cor: 'bg-status-warning-bg text-status-warning' },
  recusado: { label: 'Recusado', cor: 'bg-status-error-bg text-status-error' },
};

interface Props {
  arquivos: ArquivoExtrato[];
  conferindoId: string | null;
  onConferir: (arquivoId: string) => void;
}

export function ListaArquivosExtrato({ arquivos, conferindoId, onConferir }: Props) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Status</TableHead>
          <TableHead>Motivo</TableHead>
          <TableHead>Período</TableHead>
          <TableHead className="text-right">Linhas novas</TableHead>
          <TableHead className="text-right">Conferência</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {arquivos.map((a) => (
          <TableRow key={a.id}>
            <TableCell>
              <Badge className={STATUS[a.status].cor} variant="outline">{STATUS[a.status].label}</Badge>
            </TableCell>
            <TableCell className="text-sm text-muted-foreground">{textoDoMotivoDesconhecido(a.motivo) ?? '—'}</TableCell>
            <TableCell className="tabular-nums">
              {formatarDataIso(a.periodoInicio)} a {formatarDataIso(a.periodoFim)}
            </TableCell>
            <TableCell className="text-right tabular-nums">{a.qtdLinhasNovas}</TableCell>
            <TableCell className="text-right">
              {a.status !== 'aceito' ? (
                <span className="text-muted-foreground">—</span>
              ) : a.conferidoEm ? (
                <span className="text-status-success text-sm">Conferido</span>
              ) : (
                <Button size="sm" variant="outline" disabled={conferindoId === a.id} onClick={() => onConferir(a.id)}>
                  Conferi
                </Button>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
