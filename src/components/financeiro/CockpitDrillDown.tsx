import { useState, useEffect } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AvisoLeituraFalhou } from '@/components/leitura/AvisoLeituraFalhou';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { supabase } from '@/integrations/supabase/client';
import { BAIXA_OMIE_LIST, baixaOuIndisponivel } from '@/lib/financeiro/procedencia-baixa';
import { addDias, hojeSP } from '@/lib/time/sp-day';
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

/**
 * Quantas linhas a tabela mostra. É JANELA, não o universo: CR aberto passa de 1.100 títulos e CP
 * aberto de 1.000 (prod, 2026-10-11). Por isso cada leitura pede `count: 'exact'` no MESMO request
 * — sem o 2º sinal, "500 registros" é indistinguível do fim (money-path §"leitura que TRUNCA").
 */
const JANELA = 500;

/**
 * O que o drill-down leu. `total` é `null` quando não pode ser afirmado: a fonte não ingere a baixa
 * (a subtração seria fabricada) OU a lista não é o universo inteiro (somar a janela daria a soma de
 * 500 títulos rotulada como "Total"). `universo` é o `count` do servidor — `null` = desconhecido.
 */
type Leitura = { rows: DrillRow[]; total: number | null; universo: number | null };

/** `tipo` = de QUAL drill-down é a leitura: o estado de um tipo nunca é desenhado sob outro. */
type Estado =
  | { fase: 'carregando' }
  | { fase: 'erro'; tipo: DrillDownType }
  | ({ fase: 'pronta'; tipo: DrillDownType } & Leitura);

export function CockpitDrillDown({ type, onClose }: Props) {
  const [lido, setEstado] = useState<Estado>({ fase: 'carregando' });
  /** "Tentar novamente" relê bumpando isto — o efeito não tem retry próprio. */
  const [tentativa, setTentativa] = useState(0);

  useEffect(() => {
    if (!type) return;
    // A resposta de um tipo ANTERIOR (caixa→CR com a 1ª leitura atrasada) não pode pousar sob o
    // título do tipo novo: só a leitura do efeito vigente escreve o estado.
    let vigente = true;
    setEstado({ fase: 'carregando' });
    loadData(type).then(
      (leitura) => { if (vigente) setEstado({ fase: 'pronta', tipo: type, ...leitura }); },
      (erro: unknown) => {
        // A falha era DESCARTADA (`const { data } = …` → `data ?? []`): "0 registros · Total R$ 0,00"
        // no caixa. Agora a tela diz que não leu (money-path: ausente ≠ zero).
        console.error('[CockpitDrillDown] leitura falhou', erro);
        if (vigente) setEstado({ fase: 'erro', tipo: type });
      },
    );
    return () => { vigente = false; };
  }, [type, tentativa]);

  if (!type) return null;

  // O efeito só reseta DEPOIS do render: trocar CR→Caixa desenharia 1 quadro com as linhas de CR na
  // tabela de Caixa (`saldo_atual` undefined → `fmt` lança; Codex, revisão do M-05). Estado de
  // outro tipo conta como "carregando".
  const estado: Estado = lido.fase !== 'carregando' && lido.tipo === type ? lido : { fase: 'carregando' };
  const loading = estado.fase === 'carregando';
  const data = estado.fase === 'pronta' ? estado.rows : [];
  const total = estado.fase === 'pronta' ? estado.total : null;
  const truncada = estado.fase === 'pronta' && (estado.universo === null || estado.universo > estado.rows.length);

  return (
    <Sheet open={!!type} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="bottom" className="h-[80vh] overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-3">
            {TITLES[type] || 'Detalhamento'}
            <Badge variant="secondary" className="text-xs">
              {estado.fase === 'carregando'
                ? 'carregando…'
                : estado.fase === 'erro'
                  ? 'indisponível'
                  : truncada
                    ? `Mostrando ${data.length} de ${estado.universo === null ? '?' : estado.universo.toLocaleString('pt-BR')} · Total: —`
                    : `${data.length} registros · Total: ${total === null ? '—' : fmt(total)}`}
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

        {truncada && (
          <p data-testid="drill-janela" className="flex items-start gap-2 text-xs text-muted-foreground mt-3">
            <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>
              A lista mostra os {data.length} primeiros por vencimento
              {estado.fase === 'pronta' && estado.universo !== null
                ? ` de ${estado.universo.toLocaleString('pt-BR')}`
                : ' (o total de registros não pôde ser contado)'}
              . O <strong className="font-medium">Total</strong> só é somado com a lista completa.
            </span>
          </p>
        )}

        <div className="mt-4">
          {estado.fase === 'erro' ? (
            <div>
              <AvisoLeituraFalhou oque={`o detalhamento (${(TITLES[type] || 'drill-down').toLowerCase()})`} estado="erro" variante="bloco" />
              <Button size="sm" variant="outline" className="mt-3" onClick={() => setTentativa((n) => n + 1)}>
                Tentar novamente
              </Button>
            </div>
          ) : loading ? (
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

/** `error` lança com a fonte no texto; `data: null` sem `error` é resposta malformada, não vazio. */
function exigirLeitura<T>(fonte: string, r: { data: T[] | null; error: { message: string } | null }): T[] {
  if (r.error) throw new Error(`${fonte}: ${r.error.message}`);
  if (r.data == null) throw new Error(`${fonte}: data null sem error — malformada`);
  return r.data;
}

/**
 * Janela de títulos + o universo contado no mesmo request. O total (a subtração da baixa) só sai se
 * a fonte ingere a baixa E a janela é o universo inteiro — nunca a soma de 500 rotulada "Total".
 */
function leituraDeTitulos<T extends DrillRow>(
  fonte: string,
  r: { data: T[] | null; error: { message: string } | null; count: number | null },
  saldo: (row: T) => number,
): Leitura {
  const rows = exigirLeitura(fonte, r);
  const universo = r.count ?? null;
  const completa = universo !== null && universo === rows.length;
  return {
    rows,
    universo,
    total: completa ? baixaOuIndisponivel(rows.reduce((s, row) => s + saldo(row), 0), BAIXA_OMIE_LIST) : null,
  };
}

const STATUS_ABERTO = ['A VENCER', 'ATRASADO', 'VENCE HOJE'];
const saldoReceber = (r: FinContaReceberRow) => (r.valor_documento || 0) - (r.valor_recebido || 0);
const saldoPagar = (r: FinContaPagarRow) => (r.valor_documento || 0) - (r.valor_pago || 0);

async function loadData(type: DrillDownType): Promise<Leitura> {
  if (type === 'caixa') {
    // ~40 contas ativas: sem janela. O `count` confirma que a soma cobre todas as linhas, e uma
    // conta sem `saldo_atual` (coluna nullable) tira o total — somá-la como 0 seria fabricar.
    const r = await supabase
      .from('fin_contas_correntes')
      .select('*', { count: 'exact' })
      .eq('ativo', true)
      .order('company')
      .order('id');
    const rows = exigirLeitura('fin_contas_correntes', r);
    const universo = r.count ?? null;
    return {
      rows,
      universo,
      total:
        universo === rows.length && rows.every((row) => row.saldo_atual !== null)
          ? rows.reduce((s, row) => s + (row.saldo_atual as number), 0)
          : null,
    };
  }

  // `id` desempata o vencimento: sem ele, a janela de 500 não é a mesma entre leituras.
  if (type === 'cr_aberto') {
    const r = await supabase
      .from('fin_contas_receber')
      .select('*', { count: 'exact' })
      .in('status_titulo', STATUS_ABERTO)
      .order('data_vencimento', { ascending: true })
      .order('id')
      .limit(JANELA);
    return leituraDeTitulos('fin_contas_receber (abertos)', r, saldoReceber);
  }

  if (type === 'cp_aberto') {
    const r = await supabase
      .from('fin_contas_pagar')
      .select('*', { count: 'exact' })
      .in('status_titulo', STATUS_ABERTO)
      .order('data_vencimento', { ascending: true })
      .order('id')
      .limit(JANELA);
    return leituraDeTitulos('fin_contas_pagar (abertos)', r, saldoPagar);
  }

  if (type === 'cr_vencido' || type === 'inadimplencia') {
    const r = await supabase
      .from('fin_contas_receber')
      .select('*', { count: 'exact' })
      .eq('status_titulo', 'ATRASADO')
      .order('data_vencimento', { ascending: true })
      .order('id')
      .limit(JANELA);
    return leituraDeTitulos('fin_contas_receber (vencidos)', r, saldoReceber);
  }

  if (type === 'aging_critico') {
    // dia de SP − 60 (data_vencimento é date): setDate local + toISOString UTC punha a borda um dia à frente às 21h+.
    const cutoff60 = addDias(hojeSP(), -60);
    const r = await supabase
      .from('fin_contas_receber')
      .select('*', { count: 'exact' })
      .eq('status_titulo', 'ATRASADO')
      .lt('data_vencimento', cutoff60)
      .order('data_vencimento', { ascending: true })
      .order('id')
      .limit(JANELA);
    return leituraDeTitulos('fin_contas_receber (aging +60)', r, saldoReceber);
  }

  throw new Error(`CockpitDrillDown: tipo sem leitura (${String(type)})`);
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
            {r.saldo_atual === null ? (
              <TableCell className="text-right text-muted-foreground">—</TableCell>
            ) : (
              <TableCell className={`text-right font-medium ${r.saldo_atual >= 0 ? 'text-status-success' : 'text-status-error'}`}>
                {fmt(r.saldo_atual)}
              </TableCell>
            )}
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
