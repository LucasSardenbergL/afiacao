import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import {
  contagemPropria,
  estadoTaxa,
  formatarPct,
  formatarReais,
  rotuloSemana,
  type ContagemDesfecho,
  type LinhaPainel,
} from '@/lib/venda-cliente/painel';
import { CelulaTaxa } from './CelulaTaxa';

/** Meta de tentativa de contato da Onda 2 (spec §8): ≥ 80% dos compradores da lista. */
const META_CONTATO = 0.8;

function agruparPorFarmer(linhas: LinhaPainel[]): LinhaPainel[][] {
  const grupos = new Map<string, LinhaPainel[]>();
  for (const l of linhas) {
    const g = grupos.get(l.farmer_user_id);
    if (g) g.push(l);
    else grupos.set(l.farmer_user_id, [l]);
  }
  return [...grupos.values()];
}

function Contatados({ l }: { l: LinhaPainel }) {
  if (l.na_lista === 0) return <span className="text-muted-foreground">—</span>;
  const taxa = l.contatados / l.na_lista;
  return (
    <span className="tabular-nums">
      {l.contatados}
      <span
        className={cn(
          'ml-1.5 text-xs',
          taxa >= META_CONTATO ? 'text-status-success' : 'text-status-warning',
        )}
      >
        {formatarPct(taxa)}
      </span>
    </span>
  );
}

/** A linha tem sugestão herdada na lista ATIVA (servidor com a migration). */
const temHerdada = (l: LinhaPainel) => (l.herdadas?.sugestoes ?? 0) > 0;

/** A base tem herdada: a contagem própria difere da total (a herança pode existir SÓ na base — P2 do Codex). */
const baseMistura = (total: ContagemDesfecho, propria: ContagemDesfecho | null) =>
  propria !== null &&
  (total.virou !== propria.virou || total.nao_virou !== propria.nao_virou ||
    total.nao_medivel !== propria.nao_medivel || total.pendentes !== propria.pendentes);

function Num({ v }: { v: number }) {
  return <span className={cn('tabular-nums', v === 0 && 'text-muted-foreground')}>{v}</span>;
}

export function TabelaAdocao({ linhas, baseConfiavel }: { linhas: LinhaPainel[]; baseConfiavel: boolean }) {
  const grupos = agruparPorFarmer(linhas);
  return (
    <div className="space-y-6">
      {grupos.map((g) => {
        const f = g[0];
        // a fatia aparece quando há herdada em QUALQUER régua (ativa, base do ano anterior ou sombra)
        const comHerdadas =
          g.some((l) => temHerdada(l) || baseMistura(l.base_historico, l.base_historico_propria)) ||
          baseMistura(f.base_sombra, f.base_sombra_propria);
        const baseSombraPropria =
          comHerdadas && f.base_sombra_propria
            ? estadoTaxa(f.base_sombra_propria, f.taxa_base_sombra_propria, { baseConfiavel, exigeBaseConfiavel: true })
            : null;
        const baseSombra = estadoTaxa(f.base_sombra, f.taxa_base_sombra, {
          baseConfiavel,
          exigeBaseConfiavel: true,
        });
        return (
          <section key={f.farmer_user_id} aria-label={`Adoção de ${f.farmer_nome ?? 'farmer sem nome'}`}>
            <header className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-base font-semibold">{f.farmer_nome ?? 'Farmer sem nome no cadastro'}</h3>
              <p className="text-xs text-muted-foreground">
                Linha de base · sombra antes do go-live: <CelulaTaxa estado={baseSombra} className="text-xs" />
                {baseSombraPropria && (
                  <span data-testid="painel-base-sombra-propria">
                    {' '}· própria: <CelulaTaxa estado={baseSombraPropria} className="text-xs" />
                  </span>
                )}
              </p>
            </header>
            {comHerdadas && (
              <p className="mb-2 text-xs text-muted-foreground" data-testid="painel-herdadas-aviso">
                Inclui clientes herdados de sucessão declarada: o histórico deles tem compras da empresa antiga. Abaixo de
                cada número, quanto veio de herança. A conversão &quot;própria&quot; tira as sugestões herdadas; compare-a
                com a base &quot;própria&quot;, que também tira as herdadas.
              </p>
            )}
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-20">Semana</TableHead>
                    <TableHead className="text-right" title="Compradores na lista do dia (fase ativa), distintos na semana">Na lista</TableHead>
                    <TableHead className="text-right" title="Compradores com alguma sugestão exibida na tela">Mostrados</TableHead>
                    <TableHead className="text-right" title="Compradores da lista com contato registrado na semana (meta 80%)">Contatados</TableHead>
                    <TableHead className="text-right" title="Compradores com sugestão de recompra que virou pedido">Compraram</TableHead>
                    <TableHead className="text-right">Receita casada</TableHead>
                    <TableHead className="text-right" title="Recompra: virou ÷ (virou + não virou)">Conversão</TableHead>
                    <TableHead className="text-right" title="A mesma semana do ano anterior, reconstruída com a rotina de então">Base ano anterior</TableHead>
                    <TableHead className="text-right" title="Lista gerada sem mostrar a ninguém (antes do go-live)">Sombra</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {g.map((l) => {
                    const ativa = estadoTaxa(l, l.taxa_ativa, { baseConfiavel, exigeBaseConfiavel: false });
                    const hist = estadoTaxa(l.base_historico, l.taxa_base_historico_mesma_semana, {
                      baseConfiavel,
                      exigeBaseConfiavel: true,
                    });
                    const h = temHerdada(l) ? l.herdadas : null;
                    const cp = comHerdadas ? contagemPropria(l) : null;
                    const propria = cp
                      ? estadoTaxa(cp, l.taxa_ativa_propria, { baseConfiavel, exigeBaseConfiavel: false })
                      : null;
                    const histPropria =
                      comHerdadas && l.base_historico_propria
                        ? estadoTaxa(l.base_historico_propria, l.taxa_base_historico_propria, {
                            baseConfiavel,
                            exigeBaseConfiavel: true,
                          })
                        : null;
                    return (
                      <TableRow key={l.semana}>
                        <TableCell className="tabular-nums text-muted-foreground">{rotuloSemana(l.semana)}</TableCell>
                        <TableCell className="text-right">
                          <Num v={l.na_lista} />
                          {h && (
                            <span className="block text-xs text-muted-foreground" data-testid="painel-herdadas-na-lista">
                              {h.na_lista} herdado{h.na_lista === 1 ? '' : 's'}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right"><Num v={l.mostradas} /></TableCell>
                        <TableCell className="text-right"><Contatados l={l} /></TableCell>
                        <TableCell className="text-right"><Num v={l.compraram} /></TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatarReais(l.receita_realizada)}
                          {l.receita_incompleta && (
                            <span className="ml-1 text-status-warning" title="Há venda casada sem valor apurado: a soma é parcial">*</span>
                          )}
                          {h && (
                            <span className="block text-xs text-muted-foreground" data-testid="painel-receita-herdada">
                              {formatarReais(h.receita_realizada)} herdada{h.receita_incompleta ? '*' : ''}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <CelulaTaxa estado={ativa} />
                          {propria && (
                            <span className="block text-xs text-muted-foreground" data-testid="painel-conversao-propria"
                              title="Conversão sem as sugestões herdadas">
                              própria <CelulaTaxa estado={propria} className="text-xs" />
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <CelulaTaxa estado={hist} />
                          {histPropria && (
                            <span className="block text-xs text-muted-foreground" data-testid="painel-base-historico-propria"
                              title="Base do ano anterior sem as sugestões herdadas">
                              própria <CelulaTaxa estado={histPropria} className="text-xs" />
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right"><Num v={l.na_lista_sombra} /></TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </section>
        );
      })}
    </div>
  );
}
