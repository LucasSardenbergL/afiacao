import { useState, useEffect } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { supabase } from '@/integrations/supabase/client';

const fmt = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtDate = (d: string | null) => d ? new Date(d + 'T00:00:00').toLocaleDateString('pt-BR') : '—';

export type DrillDownType = 
  | 'caixa' 
  | 'cr_aberto' 
  | 'cp_aberto' 
  | 'cr_vencido' 
  | 'inadimplencia'
  | 'aging_critico'
  | null;

interface Props {
  type: DrillDownType;
  onClose: () => void;
}

const TITLES: Record<string, string> = {
  caixa: 'Caixa Disponível — Contas Correntes',
  cr_aberto: 'Contas a Receber (Abertos)',
  cp_aberto: 'Contas a Pagar (Abertos)',
  cr_vencido: 'Contas a Receber — Vencidos (Inadimplentes)',
  inadimplencia: 'Contas a Receber — Vencidos (Inadimplentes)',
  aging_critico: 'Aging Crítico — Vencidos +60 dias',
};

export function CockpitDrillDown({ type, onClose }: Props) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<any[]>([]);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    if (!type) return;
    setLoading(true);
    loadData(type).then(({ rows, total }) => {
      setData(rows);
      setTotal(total);
      setLoading(false);
    });
  }, [type]);

  if (!type) return null;

  return (
    <Sheet open={!!type} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="bottom" className="h-[80vh] overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-3">
            {TITLES[type] || 'Detalhamento'}
            <Badge variant="secondary" className="text-xs">
              {data.length} registros · Total: {fmt(total)}
            </Badge>
          </SheetTitle>
        </SheetHeader>

        <div className="mt-4">
          {loading ? (
            <div className="space-y-2">
              {[1,2,3,4,5].map(i => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : type === 'caixa' ? (
            <CaixaTable data={data} />
          ) : type === 'cr_aberto' || type === 'cr_vencido' || type === 'inadimplencia' || type === 'aging_critico' ? (
            <CRTable data={data} />
          ) : type === 'cp_aberto' ? (
            <CPTable data={data} />
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

async function loadData(type: DrillDownType): Promise<{ rows: any[]; total: number }> {
  if (type === 'caixa') {
    const { data } = await supabase
      .from('fin_contas_correntes' as any)
      .select('*')
      .eq('ativo', true)
      .order('company');
    const rows = data || [];
    return { rows, total: rows.reduce((s: number, r: any) => s + (r.saldo_atual || 0), 0) };
  }

  if (type === 'cr_aberto') {
    const { data } = await supabase
      .from('fin_contas_receber' as any)
      .select('*')
      .in('status_titulo', ['A VENCER', 'ATRASADO', 'VENCE HOJE'])
      .order('data_vencimento', { ascending: true })
      .limit(500);
    const rows = data || [];
    return { rows, total: rows.reduce((s: number, r: any) => s + ((r.valor_documento || 0) - (r.valor_recebido || 0)), 0) };
  }

  if (type === 'cp_aberto') {
    const { data } = await supabase
      .from('fin_contas_pagar' as any)
      .select('*')
      .in('status_titulo', ['A VENCER', 'ATRASADO', 'VENCE HOJE'])
      .order('data_vencimento', { ascending: true })
      .limit(500);
    const rows = data || [];
    return { rows, total: rows.reduce((s: number, r: any) => s + ((r.valor_documento || 0) - (r.valor_pago || 0)), 0) };
  }

  if (type === 'cr_vencido' || type === 'inadimplencia') {
    const { data } = await supabase
      .from('fin_contas_receber' as any)
      .select('*')
      .eq('status_titulo', 'ATRASADO')
      .order('data_vencimento', { ascending: true })
      .limit(500);
    const rows = data || [];
    return { rows, total: rows.reduce((s: number, r: any) => s + ((r.valor_documento || 0) - (r.valor_recebido || 0)), 0) };
  }

  if (type === 'aging_critico') {
    const cutoff60 = new Date();
    cutoff60.setDate(cutoff60.getDate() - 60);
    const { data } = await supabase
      .from('fin_contas_receber' as any)
      .select('*')
      .eq('status_titulo', 'ATRASADO')
      .lt('data_vencimento', cutoff60.toISOString().split('T')[0])
      .order('data_vencimento', { ascending: true })
      .limit(500);
    const rows = data || [];
    return { rows, total: rows.reduce((s: number, r: any) => s + ((r.valor_documento || 0) - (r.valor_recebido || 0)), 0) };
  }

  return { rows: [], total: 0 };
}

function CaixaTable({ data }: { data: any[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Empresa</TableHead>
          <TableHead>Banco</TableHead>
          <TableHead>Descrição</TableHead>
          <TableHead className="text-right">Saldo</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.map((r, i) => (
          <TableRow key={i}>
            <TableCell><Badge variant="outline">{r.company}</Badge></TableCell>
            <TableCell className="text-sm">{r.banco || '—'}</TableCell>
            <TableCell className="text-sm">{r.descricao || '—'}</TableCell>
            <TableCell className={`text-right font-medium ${(r.saldo_atual || 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
              {fmt(r.saldo_atual || 0)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function CRTable({ data }: { data: any[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Empresa</TableHead>
          <TableHead>Cliente</TableHead>
          <TableHead>Doc</TableHead>
          <TableHead>Vencimento</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Valor</TableHead>
          <TableHead className="text-right">Recebido</TableHead>
          <TableHead className="text-right">Saldo</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.map((r, i) => {
          const saldo = (r.valor_documento || 0) - (r.valor_recebido || 0);
          return (
            <TableRow key={i}>
              <TableCell><Badge variant="outline" className="text-[10px]">{r.company}</Badge></TableCell>
              <TableCell className="text-sm max-w-[200px] truncate">{r.nome_cliente || '—'}</TableCell>
              <TableCell className="text-xs text-muted-foreground">{r.numero_documento || '—'}</TableCell>
              <TableCell className="text-sm">{fmtDate(r.data_vencimento)}</TableCell>
              <TableCell>
                <Badge variant={r.status_titulo === 'ATRASADO' ? 'destructive' : 'outline'} className="text-[10px]">
                  {r.status_titulo}
                </Badge>
              </TableCell>
              <TableCell className="text-right text-sm">{fmt(r.valor_documento || 0)}</TableCell>
              <TableCell className="text-right text-sm text-muted-foreground">{fmt(r.valor_recebido || 0)}</TableCell>
              <TableCell className="text-right font-medium text-sm">{fmt(saldo)}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function CPTable({ data }: { data: any[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Empresa</TableHead>
          <TableHead>Fornecedor</TableHead>
          <TableHead>Doc</TableHead>
          <TableHead>Vencimento</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Valor</TableHead>
          <TableHead className="text-right">Pago</TableHead>
          <TableHead className="text-right">Saldo</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.map((r, i) => {
          const saldo = (r.valor_documento || 0) - (r.valor_pago || 0);
          return (
            <TableRow key={i}>
              <TableCell><Badge variant="outline" className="text-[10px]">{r.company}</Badge></TableCell>
              <TableCell className="text-sm max-w-[200px] truncate">{r.nome_fornecedor || '—'}</TableCell>
              <TableCell className="text-xs text-muted-foreground">{r.numero_documento || '—'}</TableCell>
              <TableCell className="text-sm">{fmtDate(r.data_vencimento)}</TableCell>
              <TableCell>
                <Badge variant={r.status_titulo === 'ATRASADO' ? 'destructive' : 'outline'} className="text-[10px]">
                  {r.status_titulo}
                </Badge>
              </TableCell>
              <TableCell className="text-right text-sm">{fmt(r.valor_documento || 0)}</TableCell>
              <TableCell className="text-right text-sm text-muted-foreground">{fmt(r.valor_pago || 0)}</TableCell>
              <TableCell className="text-right font-medium text-sm">{fmt(saldo)}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
