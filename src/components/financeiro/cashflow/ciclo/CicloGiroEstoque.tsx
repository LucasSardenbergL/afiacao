// Giro de estoque por SKU (frente 3 do ciclo): onde o caixa está preso no estoque, por empresa
// (nunca somado entre CNPJs). Candidatos a SEGURAR COMPRA e a LIQUIDAR + lista "fora do giro"
// (imobilizado / uso e consumo) para o founder acompanhar. A regra é da RPC fin_ciclo_giro_sku.
import { useEffect, useState } from 'react';
import { Inbox } from 'lucide-react';
import { useCicloGiroSku } from '@/hooks/useFinanceiroCiclo';
import { COMPANIES, type Company } from '@/contexts/CompanyContext';
import { EmptyState } from '@/components/EmptyState';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { decodeHtmlEntities } from '@/lib/format';
import { track } from '@/lib/analytics';
import {
  LIMIAR_COBERTURA_ALVO_DIAS, LIMIAR_GIRO_MORTO_DIAS_FIN, LIMIAR_SEGURAR_COMPRA_DIAS, MOTIVO_TEXTO,
  resumirGiro, separarListas, type GiroSku,
} from '@/lib/financeiro/ciclo-giro-helpers';
import { brl, dias } from './ciclo-format';

export type FiltroAcaoGiro = 'todos' | 'liquidar' | 'segurar_compra';
const FILTROS: Array<[FiltroAcaoGiro, string]> = [
  ['todos', 'Todos os SKUs'], ['liquidar', 'Candidatos a liquidar'], ['segurar_compra', 'Candidatos a segurar compra'],
];
const ROTULO_ACAO = { liquidar: 'Candidato a liquidar', segurar_compra: 'Candidato a segurar compra' } as const;
const TOPO = 50;

const nome = (s: GiroSku) => (s.descricao ? decodeHtmlEntities(s.descricao) : `#${s.omieCodigoProduto}`);
const motivo = (m: string | null) => (m ? MOTIVO_TEXTO[m] ?? m : null);
const qtd = (v: number) => v.toLocaleString('pt-BR', { maximumFractionDigits: 2 });

function Traco({ titulo }: { titulo: string | null }) {
  return <span title={titulo ?? undefined}>—</span>;
}

function TabelaGiro({ linhas }: { linhas: GiroSku[] }) {
  const [todos, setTodos] = useState(false);
  const visiveis = todos ? linhas : linhas.slice(0, TOPO);
  return (
    <div className="space-y-2">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Código</TableHead><TableHead>Descrição</TableHead>
            <TableHead className="text-right">Saldo</TableHead><TableHead className="text-right">R$ parado</TableHead>
            <TableHead className="text-right">Cobertura (qtd)</TableHead><TableHead className="text-right">Sem saída</TableHead>
            <TableHead className="text-right">R$ acima de {LIMIAR_COBERTURA_ALVO_DIAS}d</TableHead><TableHead>Candidato</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visiveis.map((s) => {
            const mot = motivo(s.motivoConsumo) ?? motivo(s.motivoAcao);
            return (
              <TableRow key={s.omieCodigoProduto}>
                <TableCell className="font-mono text-xs">{s.codigo ?? s.omieCodigoProduto}</TableCell>
                <TableCell className="text-xs">{nome(s)}</TableCell>
                <TableCell className="text-right font-mono text-xs">{qtd(s.saldo)}</TableCell>
                <TableCell className="text-right font-mono text-xs">
                  {s.valorParado === null ? <Traco titulo="sem custo (CMC ausente ou zero)" /> : brl(s.valorParado)}
                </TableCell>
                <TableCell className="text-right font-mono text-xs">
                  {s.diasCobertura === null ? <Traco titulo={mot ?? 'sem consumo em 365 dias'} /> : dias(s.diasCobertura)}
                </TableCell>
                <TableCell className="text-right font-mono text-xs">
                  {s.diasSemSaida === null ? <Traco titulo={mot ?? 'nunca saiu'} /> : dias(s.diasSemSaida)}
                </TableCell>
                <TableCell className="text-right font-mono text-xs">
                  {s.valorExcedente === null ? <Traco titulo={mot} /> : brl(s.valorExcedente)}
                </TableCell>
                <TableCell className="text-xs">
                  {s.acao ? <Badge variant="outline">{ROTULO_ACAO[s.acao]}</Badge>
                    : <span className="text-muted-foreground">{mot ?? '—'}</span>}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {linhas.length > TOPO && (
        <Button variant="ghost" size="sm" onClick={() => setTodos((v) => !v)}>
          {todos ? `Mostrar só os ${TOPO} maiores` : `Ver todos os ${linhas.length}`}
        </Button>
      )}
    </div>
  );
}

function ForaDoGiro({ company, linhas, total }: { company: Company; linhas: GiroSku[]; total: number | null }) {
  if (linhas.length === 0) return null;
  return (
    <details className="rounded-md border px-3 py-2" data-testid={`ciclo-giro-fora-${company}`}>
      <summary className="cursor-pointer text-sm">
        Fora do giro — {linhas.length} SKUs, {brl(total)} (imobilizado, uso e consumo ou sem tipo; não entram no PME)
      </summary>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Código</TableHead><TableHead>Descrição</TableHead><TableHead>Tipo</TableHead><TableHead>Família</TableHead>
            <TableHead className="text-right">Saldo</TableHead><TableHead className="text-right">R$</TableHead><TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {linhas.map((s) => (
            <TableRow key={s.omieCodigoProduto}>
              <TableCell className="font-mono text-xs">{s.codigo ?? s.omieCodigoProduto}</TableCell>
              <TableCell className="text-xs">{nome(s)}</TableCell>
              <TableCell className="text-xs">{s.tipoProduto ?? 'sem tipo'}</TableCell>
              <TableCell className="text-xs">{s.familia ?? '—'}</TableCell>
              <TableCell className="text-right font-mono text-xs">{qtd(s.saldo)}</TableCell>
              <TableCell className="text-right font-mono text-xs">
                {s.valorParado === null ? <Traco titulo="sem custo" /> : brl(s.valorParado)}
              </TableCell>
              <TableCell>{s.divergenciaCadastro && <Badge variant="outline" className="text-status-warning">conferir cadastro</Badge>}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </details>
  );
}

function GiroEmpresa({ company, acao }: { company: Company; acao: FiltroAcaoGiro }) {
  const q = useCicloGiroSku(company);
  useEffect(() => { track('financeiro.ciclo_giro_visto', { empresa: company }); }, [company]);

  if (q.isLoading) return <PageSkeleton variant="list" />;
  if (q.error) {
    return <p className="text-status-error text-sm">Não foi possível ler o giro de estoque de {COMPANIES[company].shortName}.</p>;
  }
  const rows = q.data ?? [];
  if (rows.length === 0) {
    return <EmptyState tone="operational" icon={Inbox} title="Nenhum SKU com saldo" description={`${COMPANIES[company].shortName} não tem estoque positivo no Omie.`} />;
  }
  const r = resumirGiro(rows);
  const { giro, foraGiro } = separarListas(rows);
  const filtrados = acao === 'todos' ? giro : giro.filter((s) => s.acao === acao);
  const totalFora = r.valorForaGiro === null && r.valorSemClassificacao === null ? null
    : (r.valorForaGiro ?? 0) + (r.valorSemClassificacao ?? 0);
  const semFonte = !r.temFonteConsumo ? motivo(giro.find((s) => s.motivoConsumo)?.motivoConsumo ?? 'sem_consumo_por_sku') : null;

  return (
    <section className="space-y-3" data-testid={`ciclo-giro-${company}`} aria-label={`Giro de estoque ${COMPANIES[company].shortName}`}>
      <h3 className="text-sm font-medium">Giro de estoque — {COMPANIES[company].shortName}</h3>
      <div className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div><div className="text-xs text-muted-foreground">Estoque de giro</div><div className="font-mono">{brl(r.valorGiro)}</div>
          {r.skusSemCusto > 0 && <div className="text-xs text-muted-foreground">{r.skusSemCusto} SKU(s) sem custo fora da soma</div>}</div>
        <div><div className="text-xs text-muted-foreground">Candidatos a liquidar (≥ {LIMIAR_GIRO_MORTO_DIAS_FIN}d sem saída)</div>
          <div className="font-mono">{semFonte ? '—' : brl(r.valorLiquidar)}</div></div>
        <div><div className="text-xs text-muted-foreground">Acima de {LIMIAR_COBERTURA_ALVO_DIAS}d nos candidatos a segurar (&gt; {LIMIAR_SEGURAR_COMPRA_DIAS}d)</div>
          <div className="font-mono">{semFonte ? '—' : brl(r.valorExcedenteSegurar)}</div></div>
        <div><div className="text-xs text-muted-foreground">Fora do giro</div>
          <div className="font-mono">{brl(totalFora)}</div></div>
      </div>
      {semFonte && <p className="text-xs text-status-warning">Dias e candidatos indisponíveis: {semFonte}. O R$ parado por SKU continua valendo.</p>}
      <p className="text-xs text-muted-foreground">
        R$ a custo atual (CMC do Omie): cenário — não é previsão. Candidato não é ordem: confira reservas, lead time e demanda contratada antes de agir.
      </p>
      {filtrados.length === 0
        ? <p className="text-xs text-muted-foreground">Nenhum SKU neste filtro.</p>
        : <TabelaGiro linhas={filtrados} />}
      <ForaDoGiro company={company} linhas={foraGiro} total={totalFora} />
    </section>
  );
}

export function CicloGiroEstoque({ empresas, acao, onAcao }: {
  empresas: Company[]; acao: FiltroAcaoGiro; onAcao: (a: FiltroAcaoGiro) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Select value={acao} onValueChange={(v) => { onAcao(v as FiltroAcaoGiro); track('financeiro.ciclo_giro_filtro', { acao: v }); }}>
          <SelectTrigger className="w-60" aria-label="Filtro de giro"><SelectValue /></SelectTrigger>
          <SelectContent>{FILTROS.map(([v, r]) => <SelectItem key={v} value={v}>{r}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      {empresas.map((c) => <GiroEmpresa key={c} company={c} acao={acao} />)}
    </div>
  );
}
