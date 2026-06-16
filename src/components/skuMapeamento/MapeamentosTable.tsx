// Card + tabela de mapeamentos SKU.
// Extraído verbatim de src/pages/AdminSkuMapeamento.tsx (god-component split).
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Loader2 } from 'lucide-react';
import type { Mapeamento } from './types';

interface MapeamentosTableProps {
  isLoading: boolean;
  filtrados: Mapeamento[];
  totalCount: number;
  descricoes: Map<string, string> | undefined;
  onEdit: (m: Mapeamento) => void;
}

export function MapeamentosTable({ isLoading, filtrados, totalCount, descricoes, onEdit }: MapeamentosTableProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Mapeamentos</CardTitle>
        <CardDescription>{filtrados.length} de {totalCount} registros</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Empresa</TableHead>
                  <TableHead>Fornecedor</TableHead>
                  <TableHead>SKU Omie</TableHead>
                  <TableHead>Descrição</TableHead>
                  <TableHead>SKU Portal</TableHead>
                  <TableHead>Unid.</TableHead>
                  <TableHead>Fator</TableHead>
                  <TableHead>Ativo</TableHead>
                  <TableHead>Observações</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtrados.map((m) => {
                  const desc = descricoes?.get(m.sku_omie);
                  return (
                    <TableRow key={m.id}>
                      <TableCell><Badge variant="outline">{m.empresa}</Badge></TableCell>
                      <TableCell className="text-xs">{m.fornecedor_nome}</TableCell>
                      <TableCell className="font-mono text-xs">{m.sku_omie}</TableCell>
                      <TableCell className="text-xs max-w-[260px] truncate" title={desc ?? ''}>{desc ?? '—'}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {m.sku_portal
                          ? <span>{m.sku_portal}</span>
                          : <Badge variant="destructive">vazio</Badge>}
                      </TableCell>
                      <TableCell>{m.unidade_portal}</TableCell>
                      <TableCell>{Number(m.fator_conversao)}</TableCell>
                      <TableCell>
                        {m.ativo
                          ? <Badge className="bg-status-success">Ativo</Badge>
                          : <Badge variant="secondary">Inativo</Badge>}
                      </TableCell>
                      <TableCell className="text-xs max-w-[220px] truncate" title={m.observacoes ?? ''}>
                        {m.observacoes ?? '—'}
                      </TableCell>
                      <TableCell>
                        <Button size="sm" variant="ghost" onClick={() => onEdit(m)}>Editar</Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {filtrados.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={10} className="text-center text-muted-foreground py-10">
                      Nenhum mapeamento encontrado.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
