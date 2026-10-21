import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import {
  estadoTaxa,
  formatarPct,
  formatarReais,
  rotuloSemana,
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

function Num({ v }: { v: number }) {
  return <span className={cn('tabular-nums', v === 0 && 'text-muted-foreground')}>{v}</span>;
}

export function TabelaAdocao({ linhas, baseConfiavel }: { linhas: LinhaPainel[]; baseConfiavel: boolean }) {
  const grupos = agruparPorFarmer(linhas);
  return (
    <div className="space-y-6">
      {grupos.map((g) => {
        const f = g[0];
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
              </p>
            </header>
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
                    return (
                      <TableRow key={l.semana}>
                        <TableCell className="tabular-nums text-muted-foreground">{rotuloSemana(l.semana)}</TableCell>
                        <TableCell className="text-right"><Num v={l.na_lista} /></TableCell>
                        <TableCell className="text-right"><Num v={l.mostradas} /></TableCell>
                        <TableCell className="text-right"><Contatados l={l} /></TableCell>
                        <TableCell className="text-right"><Num v={l.compraram} /></TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatarReais(l.receita_realizada)}
                          {l.receita_incompleta && (
                            <span className="ml-1 text-status-warning" title="Há venda casada sem valor apurado: a soma é parcial">*</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right"><CelulaTaxa estado={ativa} /></TableCell>
                        <TableCell className="text-right"><CelulaTaxa estado={hist} /></TableCell>
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
