import { useEffect, useMemo, useState } from 'react';
import { Truck } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/EmptyState';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { useCicloCpEmpresa, useCicloCpTitulos, useCicloFornecedorResumo, type CpEmpresa } from '@/hooks/useFinanceiroCicloFornecedor';
import {
  confiancaFornecedor, custoDoPrazo, inicioRegimeDesconto, montarFilaCustoPrazo, taxaDescontoObservada,
  type ResumoFornecedor, type TituloCp,
} from '@/lib/financeiro/ciclo-fornecedor-helpers';
import { COMPANIES, type Company } from '@/contexts/CompanyContext';
import { track } from '@/lib/analytics';
import { brl, dias, nomeFornecedor } from './ciclo-format';
import { CicloFornecedorDrill } from './CicloFornecedorDrill';
import { CicloPontualidade } from './CicloPontualidade';

const CAVEAT =
  'Só compras (mercadoria, matéria-prima, frete e serviço de compra). Prazo com fornecedor tem preço: aqui aparece o custo do prazo — desconto perdido, juros e multa —, não uma meta de alongar. Desconto perdido é cenário (taxa observada × valor); desconto obtido e juros/multa são apurados.';

const pctTaxa = (t: number) => `${(t * 100).toFixed(1).replace('.', ',').replace(',0', '')}%`;

function Kpi({ rotulo, valor, nota }: { rotulo: string; valor: string; nota?: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{rotulo}</div>
      <div className="font-mono text-lg">{valor}</div>
      {nota && <div className="text-xs text-muted-foreground">{nota}</div>}
    </div>
  );
}

function soma(xs: ResumoFornecedor[], campo: 'descontoObtido12m' | 'encargoPago12m' | 'valorVencidoAberto'): number | null {
  let s = 0;
  let algum = false;
  for (const x of xs) { const v = x[campo]; if (v !== null) { s += v; algum = true; } }
  return algum ? s : null; // nenhum fornecedor com o dado → ausente, nunca R$ 0
}

function Empresa({ company, resumo, titulos, cp, hoje, onAbrir }: {
  company: Company; resumo: ResumoFornecedor[]; titulos: TituloCp[]; cp: CpEmpresa | undefined; hoje: string;
  onAbrir: (f: ResumoFornecedor) => void;
}) {
  const nome = COMPANIES[company].shortName;
  const doCompany = useMemo(() => resumo.filter((r) => r.company === company), [resumo, company]);
  const titulosCompany = useMemo(() => titulos.filter((t) => t.company === company), [titulos, company]);
  const analise = useMemo(() => {
    const porForn = new Map<number, TituloCp[]>();
    for (const t of titulosCompany) porForn.set(t.fornecedor, [...(porForn.get(t.fornecedor) ?? []), t]);
    const itens = doCompany.map((r) => {
      const ts = porForn.get(r.fornecedor) ?? [];
      return { resumo: r, custo: custoDoPrazo(ts, r, hoje), obs: taxaDescontoObservada(ts, inicioRegimeDesconto(ts), hoje) };
    });
    const obs = new Map(itens.map((i) => [i.resumo.fornecedor, i.obs]));
    return { ...montarFilaCustoPrazo(itens), obs };
  }, [doCompany, titulosCompany, hoje]);

  const rodape = cp && (
    <p className="text-xs text-muted-foreground">
      {cp.nForaLista ?? '—'} títulos de 2.01.* fora da lista ({brl(cp.valorForaLista)}) · {cp.nSemCategoria ?? '—'} sem categoria ({brl(cp.valorSemCategoria)}) — não entram nesta conta.
    </p>
  );

  if (doCompany.length === 0) {
    return (
      <section className="space-y-2" aria-label={`Fornecedores — ${nome}`}>
        <EmptyState tone="operational" icon={Truck} title="Sem compras em 12 meses"
          description={`Nenhum título de compra (mercadoria, matéria-prima, frete ou serviço de compra) emitido em 12 meses na ${nome}.`} />
        {rodape}
      </section>
    );
  }

  const ordenados = [...doCompany].sort((a, b) => (b.compras12m ?? -1) - (a.compras12m ?? -1));
  return (
    <section className="space-y-3" aria-label={`Fornecedores — ${nome}`}>
      <h3 className="text-sm font-medium">{nome}</h3>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Kpi rotulo="PMP de compras" valor={cp?.pmpComprasPond == null ? '—' : `${cp.pmpComprasPond.toFixed(1).replace('.', ',')} d`} />
        <Kpi rotulo="1 dia de PMP de compras" valor={brl(cp?.rsPorDia)} nota="cenário" />
        <Kpi rotulo="Desconto obtido (12m)" valor={brl(soma(doCompany, 'descontoObtido12m'))} nota="apurado" />
        <Kpi rotulo="Juros + multa pagos (12m)" valor={brl(soma(doCompany, 'encargoPago12m'))} nota="apurado" />
        <Kpi rotulo="Vencido em aberto" valor={brl(soma(doCompany, 'valorVencidoAberto'))} />
      </div>

      <div role="region" aria-label={`Onde o prazo está custando — ${nome}`} className="space-y-2 rounded-md border p-3">
        <h4 className="text-sm font-medium">Onde o prazo está custando</h4>
        <div className="text-xs text-muted-foreground">custo apurado</div>
        {analise.fila.length === 0 && <p className="text-xs text-muted-foreground">Nenhum fornecedor com custo de prazo medido.</p>}
        <ul className="space-y-1">
          {analise.fila.map(({ resumo: r, custo, totalRs }) => {
            const o = analise.obs.get(r.fornecedor);
            const perdido = custo.perdidoAtraso ?? 0;
            const encargo = custo.encargoPago ?? 0;
            return (
              <li key={r.fornecedor} className="flex flex-wrap items-baseline gap-x-2">
                <span>{nomeFornecedor(r)}</span>
                <span className="font-mono">{brl(totalRs)}</span>
                <span className="text-xs text-muted-foreground">
                  {perdido > 0 && encargo > 0 && `desconto perdido por atraso ${brl(perdido)} (cenário) + juros/multa ${brl(encargo)} (apurado)`}
                  {perdido > 0 && encargo <= 0 && 'desconto perdido por atraso · cenário'}
                  {perdido <= 0 && encargo > 0 && 'juros/multa pagos · apurado'}
                  {o?.taxa != null && ` · desconto de pontualidade observado: ${pctTaxa(o.taxa)} (${o.nDocumentos} NFs)`}
                  {r.valorVencidoAberto ? ` · vencido em aberto ${brl(r.valorVencidoAberto)}` : ''}
                </span>
              </li>
            );
          })}
        </ul>
        {analise.conferirBoleto.length > 0 && (
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">conferir boleto</div>
            <ul className="space-y-1 text-xs">
              {analise.conferirBoleto.map(({ resumo: r, valor }) => (
                <li key={r.fornecedor}>{nomeFornecedor(r)}: {brl(valor)} pago em dia sem desconto — conferir boleto · cenário</li>
              ))}
            </ul>
          </div>
        )}
        {analise.semEvidencia.length > 0 && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">Sem evidência ({analise.semEvidencia.length})</summary>
            <ul className="mt-1 space-y-0.5">
              {analise.semEvidencia.map((r) => <li key={r.fornecedor}>{nomeFornecedor(r)}</li>)}
            </ul>
          </details>
        )}
      </div>

      <Table aria-label={`Fornecedores ${nome}`}>
        <TableHeader><TableRow>
          <TableHead>Fornecedor</TableHead><TableHead className="text-right">Compras 12m</TableHead>
          <TableHead className="text-right">Concedido</TableHead><TableHead className="text-right">Real</TableHead>
          <TableHead className="text-right">Atraso</TableHead><TableHead className="text-right">Desconto obtido</TableHead>
          <TableHead className="text-right">Juros/multa</TableHead><TableHead className="text-right">Vencido aberto</TableHead>
          <TableHead className="text-right">A vencer</TableHead><TableHead>Confiança</TableHead>
        </TableRow></TableHeader>
        <TableBody>
          {ordenados.map((r) => {
            const conf = confiancaFornecedor(r);
            return (
              <TableRow key={r.fornecedor}>
                <TableCell>
                  <button type="button" className="text-left underline-offset-2 hover:underline" onClick={() => onAbrir(r)}>{nomeFornecedor(r)}</button>
                </TableCell>
                <TableCell className="text-right font-mono">{brl(r.compras12m)}</TableCell>
                <TableCell className="text-right font-mono">{dias(r.prazoConcedidoPond)}</TableCell>
                <TableCell className="text-right font-mono">{dias(r.prazoRealPond)}</TableCell>
                <TableCell className="text-right font-mono">{dias(r.atrasoPondPos)}</TableCell>
                <TableCell className="text-right font-mono">{brl(r.descontoObtido12m)}</TableCell>
                <TableCell className="text-right font-mono">{brl(r.encargoPago12m)}</TableCell>
                <TableCell className="text-right font-mono">{r.valorVencidoAberto ? <span className="text-status-error">{brl(r.valorVencidoAberto)}</span> : '—'}</TableCell>
                <TableCell className="text-right font-mono">{brl(r.valorAVencer)}</TableCell>
                <TableCell><Badge variant={conf === 'media' ? 'secondary' : 'outline'}>{conf === 'media' ? 'média' : 'baixa'}</Badge></TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <CicloPontualidade titulos={titulosCompany} hoje={hoje} rotulo={`Pontualidade dos pagamentos de compra — ${nome}`} />
      {rodape}
    </section>
  );
}

/** Frente 4 do ciclo: PMP por fornecedor e o custo do prazo (só compras). Uma seção por empresa, sem total. */
export function CicloFornecedoresSecao({ empresas, hoje }: { empresas: Company[]; hoje: string }) {
  const titulos = useCicloCpTitulos();
  const resumo = useCicloFornecedorResumo();
  const cp = useCicloCpEmpresa();
  const [aberto, setAberto] = useState<ResumoFornecedor | null>(null);

  useEffect(() => { track('financeiro.ciclo_fornecedor_secao'); }, []);

  const erro = Boolean(titulos.error || resumo.error);
  const carregando = !erro && (titulos.isLoading || resumo.isLoading || cp.isLoading);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Fornecedores — PMP de compras e custo do prazo</CardTitle>
        <p className="text-xs text-muted-foreground">{CAVEAT}</p>
      </CardHeader>
      <CardContent className="space-y-6 text-sm">
        {erro && <p className="text-status-error text-sm">Não foi possível ler os fornecedores.</p>}
        {carregando && <PageSkeleton variant="list" />}
        {!erro && !carregando && empresas.map((c) => (
          <Empresa key={c} company={c} resumo={resumo.data ?? []} titulos={titulos.data ?? []} cp={cp.data?.[c]} hoje={hoje}
            onAbrir={(f) => { setAberto(f); track('financeiro.ciclo_fornecedor_drill', { empresa: f.company }); }} />
        ))}
        {cp.error && <p className="text-status-error text-xs">Não foi possível ler o PMP de compras por empresa.</p>}
        <CicloFornecedorDrill fornecedor={aberto} titulos={titulos.data ?? []} hoje={hoje} onFechar={() => setAberto(null)} />
      </CardContent>
    </Card>
  );
}
