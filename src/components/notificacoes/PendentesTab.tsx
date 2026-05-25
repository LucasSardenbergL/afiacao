// Aba de alertas pendentes (filtros + tabela).
// Extraída verbatim de src/pages/AdminNotificacoes.tsx (god-component split).
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { SeveridadeBadge } from './badges';
import { relTime } from './format';
import type { AlertaRow } from './types';

interface PendentesTabProps {
  loading: boolean;
  pendentesFiltrados: AlertaRow[];
  filtroSev: string;
  onFiltroSevChange: (v: string) => void;
  filtroEmpresa: string;
  onFiltroEmpresaChange: (v: string) => void;
  filtroTipo: string;
  onFiltroTipoChange: (v: string) => void;
  empresasOpts: string[];
  tiposOpts: string[];
  onSelectAlerta: (a: AlertaRow) => void;
}

export function PendentesTab({
  loading,
  pendentesFiltrados,
  filtroSev,
  onFiltroSevChange,
  filtroEmpresa,
  onFiltroEmpresaChange,
  filtroTipo,
  onFiltroTipoChange,
  empresasOpts,
  tiposOpts,
  onSelectAlerta,
}: PendentesTabProps) {
  return (
    <Card>
      <CardHeader className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <CardTitle className="text-base">Alertas pendentes</CardTitle>
        <div className="flex flex-wrap gap-2">
          <Select value={filtroSev} onValueChange={onFiltroSevChange}>
            <SelectTrigger className="w-[150px]"><SelectValue placeholder="Severidade" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">Todas severidades</SelectItem>
              <SelectItem value="info">info</SelectItem>
              <SelectItem value="atencao">atenção</SelectItem>
              <SelectItem value="urgente">urgente</SelectItem>
            </SelectContent>
          </Select>
          <Select value={filtroEmpresa} onValueChange={onFiltroEmpresaChange}>
            <SelectTrigger className="w-[150px]"><SelectValue placeholder="Empresa" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">Todas empresas</SelectItem>
              {empresasOpts.map((e) => <SelectItem key={e} value={e}>{e}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={filtroTipo} onValueChange={onFiltroTipoChange}>
            <SelectTrigger className="w-[180px]"><SelectValue placeholder="Tipo" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">Todos tipos</SelectItem>
              {tiposOpts.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-40 w-full" />
        ) : pendentesFiltrados.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">Nenhum alerta pendente.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Severidade</TableHead>
                <TableHead>Empresa</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Título</TableHead>
                <TableHead>Fornecedor</TableHead>
                <TableHead>Criado</TableHead>
                <TableHead className="text-right">Tentativas</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pendentesFiltrados.map((a) => (
                <TableRow
                  key={a.id}
                  className="cursor-pointer"
                  onClick={() => onSelectAlerta(a)}
                >
                  <TableCell><SeveridadeBadge s={a.severidade} /></TableCell>
                  <TableCell><Badge variant="outline">{a.empresa}</Badge></TableCell>
                  <TableCell className="text-xs">{a.tipo}</TableCell>
                  <TableCell className="max-w-[320px] truncate">{a.titulo}</TableCell>
                  <TableCell className="text-xs">{a.fornecedor_nome ?? '—'}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{relTime(a.criado_em)}</TableCell>
                  <TableCell className="text-right">{a.tentativas ?? 0}/3</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
