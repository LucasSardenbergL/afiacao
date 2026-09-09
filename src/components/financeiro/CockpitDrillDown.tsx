import { useState, useEffect } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Info } from 'lucide-react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { supabase } from '@/integrations/supabase/client';
import { BAIXA_OMIE_LIST, baixaOuIndisponivel } from '@/lib/financeiro/procedencia-baixa';
import type {
  FinContaCorrenteRow,
  FinContaPagarRow,
  FinContaReceberRow,
} from '@/services/financeiroTypes';

type DrillRow = FinContaCorrenteRow | FinContaPagarRow | FinContaReceberRow;

const fmt = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/**
 * ⚠️ `valor_recebido`/`valor_pago` de `fin_contas_{receber,pagar}` são 0 em 100% do acervo — o
 * LIST do Omie não devolve a baixa (#396, medido em prod 2026-09-09). O `saldo` que este
 * drill-down calculava (`valor_documento - valor_recebido`) tinha o subtraendo sempre zerado, e
 * portanto mostrava o valor de FACE inclusive para título liquidado; a coluna "Recebido"/"Pago"
 * mostrava R$ 0,00 sobre R$ 27,8M/R$ 28,9M. Ver `@/lib/financeiro/procedencia-baixa`.
 *
 * O gatilho é a PROCEDÊNCIA declarada, jamais `v === 0`: no dia em que a ingestão existir, esta
 * constante muda e um zero medido volta a sair como R$ 0,00 — que é o fato.
 */
const BAIXA_INDISPONIVEL = !BAIXA_OMIE_LIST.ingereBaixa;

/** Valor de baixa (ou do saldo derivado dela) sob a procedência da fonte deste drill-down. */
const fmtBaixa = (v: number) => {
  const apurado = baixaOuIndisponivel(v, BAIXA_OMIE_LIST);
  return apurado === null ? '—' : fmt(apurado);
};
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
  const [data, setData] = useState<DrillRow[]>([]);
  /** `null` = a fonte não ingere a baixa e o total seria a MESMA subtração fabricada. */
  const [total, setTotal] = useState<number | null>(0);

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
              {data.length} registros · Total: {total === null ? '—' : fmt(total)}
            </Badge>
          </SheetTitle>
        </SheetHeader>

        {/* A degradação precisa DIZER por quê — e só nos tipos que leem a baixa: o drill-down de
            CAIXA soma `saldo_atual` de `fin_contas_correntes`, outra fonte, que não degrada. */}
        {!loading && BAIXA_INDISPONIVEL && type !== 'caixa' && data.length > 0 && (
          <p className="flex items-start gap-2 text-xs text-muted-foreground mt-3">
            <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>
              <strong className="font-medium">{type === 'cp_aberto' ? 'Pago' : 'Recebido'}</strong>,{' '}
              <strong className="font-medium">Saldo</strong> e o total acima:{' '}
              {BAIXA_OMIE_LIST.motivo}. Exibidos como “—” —{' '}
              <strong className="font-medium">não são R$ 0,00</strong>. Valor e vencimento seguem medidos.
            </span>
          </p>
        )}

        <div className="mt-4">
          {loading ? (
            <div className="space-y-2">
              {[1,2,3,4,5].map(i => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : type === 'caixa' ? (
            <CaixaTable data={data as FinContaCorrenteRow[]} />
          ) : type === 'cr_aberto' || type === 'cr_vencido' || type === 'inadimplencia' || type === 'aging_critico' ? (
            <CRTable data={data as FinContaReceberRow[]} />
          ) : type === 'cp_aberto' ? (
            <CPTable data={data as FinContaPagarRow[]} />
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

async function loadData(type: DrillDownType): Promise<{ rows: DrillRow[]; total: number | null }> {
  if (type === 'caixa') {
    const { data } = await supabase
      .from('fin_contas_correntes')
      .select('*')
      .eq('ativo', true)
      .order('company');
    const rows = data ?? [];
    return { rows, total: rows.reduce((s, r) => s + (r.saldo_atual || 0), 0) };
  }

  if (type === 'cr_aberto') {
    const { data } = await supabase
      .from('fin_contas_receber')
      .select('*')
      .in('status_titulo', ['A VENCER', 'ATRASADO', 'VENCE HOJE'])
      .order('data_vencimento', { ascending: true })
      .limit(500);
    const rows = data ?? [];
    return { rows, total: baixaOuIndisponivel(
      rows.reduce((s, r) => s + ((r.valor_documento || 0) - (r.valor_recebido || 0)), 0),
      BAIXA_OMIE_LIST,
    ) };
  }

  if (type === 'cp_aberto') {
    const { data } = await supabase
      .from('fin_contas_pagar')
      .select('*')
      .in('status_titulo', ['A VENCER', 'ATRASADO', 'VENCE HOJE'])
      .order('data_vencimento', { ascending: true })
      .limit(500);
    const rows = data ?? [];
    return { rows, total: baixaOuIndisponivel(
      rows.reduce((s, r) => s + ((r.valor_documento || 0) - (r.valor_pago || 0)), 0),
      BAIXA_OMIE_LIST,
    ) };
  }

  if (type === 'cr_vencido' || type === 'inadimplencia') {
    const { data } = await supabase
      .from('fin_contas_receber')
      .select('*')
      .eq('status_titulo', 'ATRASADO')
      .order('data_vencimento', { ascending: true })
      .limit(500);
    const rows = data ?? [];
    return { rows, total: baixaOuIndisponivel(
      rows.reduce((s, r) => s + ((r.valor_documento || 0) - (r.valor_recebido || 0)), 0),
      BAIXA_OMIE_LIST,
    ) };
  }

  if (type === 'aging_critico') {
    const cutoff60 = new Date();
    cutoff60.setDate(cutoff60.getDate() - 60);
    const { data } = await supabase
      .from('fin_contas_receber')
      .select('*')
      .eq('status_titulo', 'ATRASADO')
      .lt('data_vencimento', cutoff60.toISOString().split('T')[0])
      .order('data_vencimento', { ascending: true })
      .limit(500);
    const rows = data ?? [];
    return { rows, total: baixaOuIndisponivel(
      rows.reduce((s, r) => s + ((r.valor_documento || 0) - (r.valor_recebido || 0)), 0),
      BAIXA_OMIE_LIST,
    ) };
  }

  return { rows: [], total: 0 };
}

function CaixaTable({ data }: { data: FinContaCorrenteRow[] }) {
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
            <TableCell className={`text-right font-medium ${(r.saldo_atual || 0) >= 0 ? 'text-status-success' : 'text-status-error'}`}>
              {fmt(r.saldo_atual || 0)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function CRTable({ data }: { data: FinContaReceberRow[] }) {
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
              <TableCell className="text-right text-sm text-muted-foreground">{fmtBaixa(r.valor_recebido || 0)}</TableCell>
              <TableCell className="text-right font-medium text-sm">{fmtBaixa((r.valor_documento || 0) - (r.valor_recebido || 0))}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function CPTable({ data }: { data: FinContaPagarRow[] }) {
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
              <TableCell className="text-right text-sm text-muted-foreground">{fmtBaixa(r.valor_pago || 0)}</TableCell>
              <TableCell className="text-right font-medium text-sm">{fmtBaixa((r.valor_documento || 0) - (r.valor_pago || 0))}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
