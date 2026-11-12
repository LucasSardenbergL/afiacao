import { useEffect, useRef } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, Scale } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useUrlState } from '@/hooks/useUrlState';
import { useVendaContribuicao } from '@/hooks/useVendaContribuicao';
import { registrarNoLedger } from '@/lib/analytics-ledger';
import { mensagemDeErro } from '@/lib/erro-mensagem';
import { cn } from '@/lib/utils';
import {
  EIXOS, EMPRESAS, JANELAS, ORDENS, ROTULO_EIXO, ROTULO_ORDEM, formatarCobertura, formatarPp, formatarTaxa, situacaoContribuicao,
  type Eixo, type Empresa, type Janela, type LinhaContribuicao, type MetricasContribuicao, type Ordem,
} from '@/lib/venda-cliente/contribuicao';
import { formatarReais } from '@/lib/venda-cliente/painel';

const POR_PAGINA = 50;

const umDe = <T extends string>(valores: readonly T[], v: string, padrao: T): T =>
  (valores as readonly string[]).includes(v) ? (v as T) : padrao;

const pp = formatarPp;
const cobertura = formatarCobertura;

const ROTULO_EMPRESA: Record<string, string> = { oben: 'Oben', colacor: 'Colacor', colacor_sc: 'Colacor SC' };

function Bloco({ titulo, valor, pct, nota }: { titulo: string; valor: string; pct?: string; nota: string }) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-muted-foreground">{titulo}</p>
      <p className="text-lg font-medium tabular-nums">
        {valor}
        {pct ? <span className="ml-1.5 text-sm text-muted-foreground">{pct}</span> : null}
      </p>
      <p className="text-xs text-muted-foreground">{nota}</p>
    </div>
  );
}

function notaContribuicao(m: MetricasContribuicao): string {
  switch (situacaoContribuicao(m)) {
    case 'completa':
      return `sobre ${cobertura(m.receita_contribuicao, m.receita_liquida)} da receita líquida (itens com custo E prazo conhecidos)`;
    case 'sem_taxa':
      return 'indisponível: a empresa não tem taxa de capital configurada';
    case 'sem_custo':
      return 'indisponível: nenhum item com receita e custo conhecidos';
    case 'sem_prazo':
      return 'indisponível: nenhum pedido com título casado';
    case 'sem_intersecao':
      return 'indisponível: nenhum item reúne receita, custo e prazo conhecidos';
  }
}

/** Os quatro números de um agrupamento, cada um com o SEU denominador escrito. */
function Resumo({ titulo, m, taxa }: { titulo: string; m: MetricasContribuicao; taxa: number | null | undefined }) {
  const semLiquida = m.itens_sem_preco + m.itens_desconto_nao_apurado + m.itens_desconto_invalido;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-base">
          {titulo}
          {taxa === null ? (
            <Badge variant="outline" className="text-status-warning">sem taxa de capital</Badge>
          ) : taxa !== undefined ? (
            <span className="text-xs font-normal text-muted-foreground">capital {formatarTaxa(taxa)} a.a.</span>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Bloco
          titulo="Receita líquida do desconto"
          valor={formatarReais(m.receita_liquida)}
          nota={`desconto ${formatarReais(m.desconto)} · ${m.pedidos} pedidos${
            semLiquida > 0 ? ` · ${semLiquida} itens sem líquida (bruto ${formatarReais(m.receita_bruta_sem_liquida)})` : ''
          }`}
        />
        <Bloco
          titulo="Margem bruta (CMC)"
          valor={formatarReais(m.margem_bruta)}
          pct={pp(m.margem_bruta_pct)}
          nota={`sobre ${cobertura(m.receita_com_custo, m.receita_liquida)} da receita · custo atual em ${cobertura(m.receita_custo_atual, m.receita_com_custo)} · ${m.itens_sem_custo} itens sem custo`}
        />
        <Bloco
          titulo="Custo do prazo"
          valor={formatarReais(m.custo_prazo)}
          pct={pp(m.custo_prazo_pct)}
          nota={
            m.pedidos_prazo_ok > 0
              ? `sobre ${cobertura(m.receita_com_prazo, m.receita_liquida)} da receita · prazo médio ${m.prazo_medio_dias ?? '—'} d · ${m.pedidos_prazo_ok}/${m.pedidos} pedidos`
              : m.pedidos_taxa_ausente > 0
                ? `prazo médio ${m.prazo_medio_dias ?? '—'} d em ${m.pedidos_taxa_ausente} pedidos, sem taxa para custear`
                : `nenhum pedido com título casado (${m.pedidos_sem_titulo} sem título)`
          }
        />
        <Bloco
          titulo="Contribuição"
          valor={formatarReais(m.contribuicao)}
          pct={pp(m.contribuicao_pct)}
          nota={notaContribuicao(m)}
        />
        {m.itens_abaixo_piso > 0 ? (
          <p className="text-xs text-status-warning sm:col-span-2 lg:col-span-4">
            {m.itens_abaixo_piso} de {m.itens_com_piso} itens abaixo do piso de markup pelo preço líquido · gap{' '}
            {formatarReais(m.gap_piso)} (não é perda realizada; sobrepõe desconto)
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function detalheLinha(eixo: Eixo, l: LinhaContribuicao): string | null {
  const d = l.detalhe;
  if (eixo === 'pedido') {
    const partes = [typeof d.data === 'string' ? d.data.split('-').reverse().join('/') : null, typeof d.comprador === 'string' ? d.comprador : null];
    return partes.filter(Boolean).join(' · ') || null;
  }
  if (eixo === 'sku') {
    // empresa singular só quando o SKU vendeu em UMA empresa; senão a contagem (o agregado é das duas)
    const emp = typeof d.empresa === 'string' ? ROTULO_EMPRESA[d.empresa] ?? d.empresa
      : typeof d.empresas === 'number' && d.empresas > 1 ? `${d.empresas} empresas` : null;
    return [emp, typeof d.familia === 'string' ? d.familia : null].filter(Boolean).join(' · ') || null;
  }
  if (eixo === 'cliente' && typeof d.empresas === 'number' && d.empresas > 1) return `${d.empresas} empresas`;
  return null;
}

/**
 * Aba "Contribuição" do painel do founder: receita líquida do desconto − CMC − custo do prazo, por eixo, com a
 * cobertura de cada camada escrita ao lado do número (nunca um total parcial com rótulo de total).
 */
export function AbaContribuicao() {
  const [url, setUrl] = useUrlState({ cjanela: '12m', ceixo: 'cliente', cempresa: 'todas', cordem: 'contribuicao_asc', cpag: 0 });
  const janela = umDe<Janela>(JANELAS, url.cjanela, '12m');
  const eixo = umDe<Eixo>(EIXOS, url.ceixo, 'cliente');
  const ordem = umDe<Ordem>(ORDENS, url.cordem, 'contribuicao_asc');
  const empresa: Empresa | null = (EMPRESAS as readonly string[]).includes(url.cempresa) ? (url.cempresa as Empresa) : null;
  const pagina = Number.isInteger(url.cpag) && url.cpag > 0 ? url.cpag : 0;
  const q = useVendaContribuicao({ janela, eixo, empresa, ordem, limite: POR_PAGINA, offset: pagina * POR_PAGINA });

  // Sensor de uso no LEDGER (o PostHog é censurado no Chrome do founder): 1× por montagem com dado. A chave
  // 'contribuicao' separa da abertura do painel na deduplicação diária.
  const registrou = useRef(false);
  useEffect(() => {
    if (registrou.current || !q.data || q.data.indisponivel) return;
    registrou.current = true;
    void registrarNoLedger('venda.painel_aberto', 'contribuicao', {
      aba: 'contribuicao',
      janela,
      eixo,
      linhas: q.data.totalLinhas,
    });
  }, [q.data, janela, eixo]);

  const filtros = (
    <div className="flex flex-wrap items-center gap-2">
      <ToggleGroup type="single" size="sm" value={janela} onValueChange={(v) => v && setUrl({ cjanela: v, cpag: 0 })}>
        <ToggleGroupItem value="12m">12 meses</ToggleGroupItem>
        <ToggleGroupItem value="90d">90 dias</ToggleGroupItem>
      </ToggleGroup>
      <Select value={eixo} onValueChange={(v) => setUrl({ ceixo: v, cpag: 0 })}>
        <SelectTrigger className="h-8 w-[140px]" aria-label="Eixo"><SelectValue /></SelectTrigger>
        <SelectContent>
          {EIXOS.map((e) => <SelectItem key={e} value={e}>{ROTULO_EIXO[e]}</SelectItem>)}
        </SelectContent>
      </Select>
      <Select value={empresa ?? 'todas'} onValueChange={(v) => setUrl({ cempresa: v, cpag: 0 })}>
        <SelectTrigger className="h-8 w-[130px]" aria-label="Empresa"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="todas">Todas</SelectItem>
          {EMPRESAS.map((e) => <SelectItem key={e} value={e}>{ROTULO_EMPRESA[e]}</SelectItem>)}
        </SelectContent>
      </Select>
      <Select value={ordem} onValueChange={(v) => setUrl({ cordem: v, cpag: 0 })}>
        <SelectTrigger className="h-8 w-[190px]" aria-label="Ordem"><SelectValue /></SelectTrigger>
        <SelectContent>
          {ORDENS.map((o) => <SelectItem key={o} value={o}>{ROTULO_ORDEM[o]}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );

  const legenda = (
    <p className="text-xs text-muted-foreground">
      Contribuição = receita líquida do desconto − CMC − custo do prazo, <strong>antes de impostos, frete e devoluções</strong>.
      CMC estimado pela posição de estoque anterior ao pedido (até 45 dias); sem ela, custo atual. Custo do prazo =
      vencimentos vigentes dos títulos casados ao pedido, a valor presente pela taxa de capital atual. Direcional —
      não substitui o DRE.
    </p>
  );

  if (q.isPending) return <div className="space-y-4">{filtros}<PageSkeleton variant="list" /></div>;
  if (q.isError) {
    return (
      <div className="space-y-4">
        {filtros}
        <Card>
          <CardContent className="flex items-center gap-2 py-6 text-sm text-status-error">
            <AlertTriangle className="h-4 w-4" />
            Não foi possível carregar a contribuição: {mensagemDeErro(q.error) ?? 'erro sem mensagem'}
          </CardContent>
        </Card>
      </div>
    );
  }

  const d = q.data;
  if (d.indisponivel) {
    return (
      <div className="space-y-4">
        {filtros}
        <EmptyState tone="operational" icon={Scale} title="Eixo indisponível" description={d.motivo} />
      </div>
    );
  }

  // Cabeçalho e detalhe pelo eixo da RESPOSTA, não o da URL: nunca rotular um escopo com o nome de outro.
  const ultimaPagina = Math.max(0, Math.ceil(d.totalLinhas / POR_PAGINA) - 1);
  const empresas = Object.keys(d.porEmpresa).sort();

  return (
    <div className={cn('space-y-4', q.isFetching && 'opacity-70')}>
      {filtros}
      {legenda}
      {d.total.itens === 0 ? (
        <EmptyState tone="operational" icon={Scale} title="Sem venda na janela" description={`${d.desde} a ${d.ate}`} />
      ) : (
        <>
          <div className="grid gap-3">
            {empresas.map((e) => (
              <Resumo
                key={e}
                titulo={ROTULO_EMPRESA[e] ?? e}
                m={d.porEmpresa[e]}
                taxa={e === 'oben' ? d.taxaCapital.oben : e === 'colacor' ? d.taxaCapital.colacor : undefined}
              />
            ))}
          </div>

          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{ROTULO_EIXO[d.eixo]}</TableHead>
                    <TableHead className="text-right">Receita líquida</TableHead>
                    <TableHead className="text-right">Desconto</TableHead>
                    <TableHead className="text-right">Margem bruta</TableHead>
                    <TableHead className="text-right">Custo do prazo</TableHead>
                    <TableHead className="text-right">Contribuição</TableHead>
                    <TableHead className="text-right">Cobertura</TableHead>
                    <TableHead className="text-right">Abaixo do piso</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.linhas.map((l) => {
                    const det = detalheLinha(d.eixo, l);
                    return (
                      <TableRow key={l.chave}>
                        <TableCell className="max-w-[280px]">
                          <div className="truncate font-medium" title={l.rotulo}>{l.rotulo}</div>
                          {det ? <div className="truncate text-xs text-muted-foreground">{det}</div> : null}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{formatarReais(l.receita_liquida)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatarReais(l.desconto)}</TableCell>
                        <TableCell className="text-right tabular-nums">{pp(l.margem_bruta_pct)}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatarReais(l.custo_prazo)}
                          {l.prazo_medio_dias !== null ? <span className="ml-1 text-xs text-muted-foreground">{l.prazo_medio_dias} d</span> : null}
                        </TableCell>
                        <TableCell className={cn('text-right tabular-nums', l.contribuicao !== null && l.contribuicao < 0 && 'text-status-error')}>
                          {formatarReais(l.contribuicao)}
                          <span className="ml-1 text-xs text-muted-foreground">{pp(l.contribuicao_pct)}</span>
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-xs text-muted-foreground">
                          {cobertura(l.receita_contribuicao, l.receita_liquida)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-xs">
                          {l.itens_abaixo_piso > 0 ? (
                            <span className="text-status-warning">{l.itens_abaixo_piso} · {formatarReais(l.gap_piso)}</span>
                          ) : (
                            <span className="text-muted-foreground">{l.itens_com_piso > 0 ? '0' : '—'}</span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {d.totalLinhas} {ROTULO_EIXO[d.eixo].toLowerCase()}(s) · {d.desde.split('-').reverse().join('/')} a{' '}
              {d.ate.split('-').reverse().join('/')} · cobertura = receita com custo E prazo ÷ receita líquida
            </span>
            <div className="flex items-center gap-1">
              <Button size="sm" variant="ghost" disabled={pagina === 0} onClick={() => setUrl({ cpag: pagina - 1 })} aria-label="Página anterior">
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="tabular-nums">{pagina + 1}/{ultimaPagina + 1}</span>
              <Button size="sm" variant="ghost" disabled={pagina >= ultimaPagina} onClick={() => setUrl({ cpag: pagina + 1 })} aria-label="Próxima página">
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
