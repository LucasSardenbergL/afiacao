/**
 * Crescimento na base comparável (o "same store" por cliente) no dashboard Master. Read-only, escopo
 * da empresa do switcher. Separa o que cresceu porque a base comprou mais do que cresceu porque
 * entrou ou saiu cliente, e mostra o tamanho da coorte ao lado do percentual. Quando a cobertura
 * dos pedidos sobre a receita contábil muda entre as janelas, a comparação é SUPRIMIDA com o
 * motivo: a variação mediria o sync, não o negócio.
 * Spec: docs/superpowers/specs/2026-10-10-crescimento-base-comparavel-design.md
 */
import { useEffect, useRef, useState } from 'react';
import { Loader2, Scale } from 'lucide-react';
import { Card, CardHeader } from '@/components/ui/card';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { COMPANIES, useCompany, type Company } from '@/contexts/CompanyContext';
import { formatBRL, formatarFracaoPct } from '@/components/customer360/format';
import { track } from '@/lib/analytics';
import { cn } from '@/lib/utils';
import { rotuloJanela, type CoberturaEmpresa } from '@/lib/dashboard/crescimento-comparavel';
import { useCrescimentoComparavel, type TipoComparacao } from '@/hooks/dashboard/useCrescimentoComparavel';

const nomeEmpresa = (account: string) => COMPANIES[account as Company]?.shortName ?? account;

function Variacao({ v }: { v: number | null }) {
  if (v == null) return <span className="text-muted-foreground">—</span>;
  const cor = v > 0 ? 'text-status-success' : v < 0 ? 'text-status-error' : 'text-muted-foreground';
  return (
    <span className={cn('tabular-nums', cor)}>
      {v > 0 ? '▲ ' : v < 0 ? '▼ ' : ''}
      {formatarFracaoPct(Math.abs(v))}
    </span>
  );
}

function LinhaPonte({ rotulo, valor, sinal, forte }: { rotulo: string; valor: number; sinal?: boolean; forte?: boolean }) {
  const texto = sinal && valor > 0 ? `+${formatBRL(valor)}` : formatBRL(valor);
  return (
    <div className={cn('flex items-baseline justify-between gap-3 py-1', forte && 'font-medium')}>
      <span className={cn('text-xs', !forte && 'text-muted-foreground')}>{rotulo}</span>
      <span className="text-xs tabular-nums">{texto}</span>
    </div>
  );
}

function rotuloCobertura(c: CoberturaEmpresa, atual: string, base: string): string {
  return `${nomeEmpresa(c.account)}: ${formatarFracaoPct(c.atual)} em ${atual} · ${formatarFracaoPct(c.base)} em ${base}`;
}

export function CrescimentoComparavelCard() {
  const { data, isLoading, isError } = useCrescimentoComparavel();
  const { selection, companyInfo } = useCompany();
  // Padrão: ano anterior (anula sazonalidade). Se ele é incomparável, abre nos 3 meses antes — o
  // botão do ano anterior continua lá e explica o porquê. A escolha do usuário sempre vence.
  const [escolhido, setTipo] = useState<TipoComparacao | null>(null);
  const tipo: TipoComparacao =
    escolhido ??
    (data?.comparacoes.ano_anterior.comparabilidade.estado === 'incomparavel' ? 'meses_anteriores' : 'ano_anterior');
  const escopo = selection === 'all' ? 'todas as empresas' : companyInfo.shortName;

  // Sensor de uso: 1x por (empresa, comparação), só com dado carregado E o card na tela.
  const ref = useRef<HTMLDivElement>(null);
  const [visivel, setVisivel] = useState(false);
  const enviados = useRef(new Set<string>());
  useEffect(() => {
    const el = ref.current;
    if (!el || visivel) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisivel(true);
      return;
    }
    const obs = new IntersectionObserver(([e]) => e.isIntersecting && setVisivel(true), { threshold: 0.5 });
    obs.observe(el);
    return () => obs.disconnect();
  }, [visivel, data]);
  const estado = data?.comparacoes[tipo].comparabilidade.estado;
  useEffect(() => {
    if (!visivel || !estado) return;
    const chave = `${selection}|${tipo}`;
    if (enviados.current.has(chave)) return;
    enviados.current.add(chave);
    track('dashboard.crescimento_comparavel_visto', { selection, comparacao: tipo, estado });
  }, [visivel, estado, selection, tipo]);

  if (isLoading) {
    return (
      <Card className="p-6 flex justify-center">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </Card>
    );
  }
  if (isError || !data) {
    return (
      <Card className="p-4 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <Scale className="w-4 h-4" />
          Crescimento na base comparável
        </div>
        <p className="mt-2">Indisponível no momento — a leitura dos pedidos falhou.</p>
      </Card>
    );
  }

  const c = data.comparacoes[tipo];
  const d = c.decomposicao;
  const rAtual = rotuloJanela(data.atual);
  const rBase = rotuloJanela(c.base);
  const comp = c.comparabilidade;

  return (
    <Card ref={ref}>
      <CardHeader className="flex flex-row items-start justify-between gap-3 pb-3">
        <div className="flex items-center gap-2 min-w-0">
          <Scale className="w-4 h-4 text-muted-foreground shrink-0" />
          <div className="min-w-0">
            <h2 className="text-base font-medium">Crescimento na base comparável</h2>
            <p className="text-2xs text-muted-foreground">
              {rAtual} vs {rBase} · {escopo}
            </p>
          </div>
        </div>
        <ToggleGroup
          type="single"
          size="sm"
          value={tipo}
          onValueChange={(v) => v && setTipo(v as TipoComparacao)}
          aria-label="Comparar com"
        >
          <ToggleGroupItem value="ano_anterior" className="text-2xs h-7 px-2">
            ano anterior
          </ToggleGroupItem>
          <ToggleGroupItem value="meses_anteriores" className="text-2xs h-7 px-2">
            3 meses antes
          </ToggleGroupItem>
        </ToggleGroup>
      </CardHeader>

      {comp.estado === 'incomparavel' ? (
        <div className="px-4 pb-4 text-xs text-muted-foreground leading-relaxed">
          <p className="font-medium text-status-warning">Comparação indisponível.</p>
          <p className="mt-1">
            Na {nomeEmpresa(comp.account)}, os pedidos do app cobriam {formatarFracaoPct(comp.base)} da receita
            contábil em {rBase} e {formatarFracaoPct(comp.atual)} em {rAtual}. A variação mediria o sync de
            pedidos, não o negócio.
            {tipo === 'ano_anterior' ? ' Veja a comparação com os 3 meses antes.' : ''}
          </p>
        </div>
      ) : (
        <div className="px-4 pb-3 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-2xs text-muted-foreground">Total</div>
              <div className="text-lg font-medium">
                <Variacao v={d.variacaoTotal} />
              </div>
            </div>
            <div>
              <div className="text-2xs text-muted-foreground">Base comparável</div>
              <div className="text-lg font-medium">
                <Variacao v={d.variacaoComparavel} />
              </div>
              <div className="text-2xs text-muted-foreground">
                {d.comparavel.clientes} clientes · {formatarFracaoPct(d.participacaoComparavel.atual)} da receita atual ·{' '}
                {formatarFracaoPct(d.participacaoComparavel.base)} da anterior
              </div>
            </div>
          </div>

          <div className="border-t border-border pt-2">
            <LinhaPonte rotulo={`Receita ${rBase}`} valor={d.totalBase} forte />
            <LinhaPonte rotulo={`− Saíram (${d.sairam.clientes} clientes)`} valor={-d.sairam.receita} />
            <LinhaPonte rotulo={`+ Entraram (${d.entraram.clientes} clientes)`} valor={d.entraram.receita} sinal />
            <LinhaPonte rotulo="± Variação na base comparável" valor={d.comparavel.atual - d.comparavel.base} sinal />
            {(d.semCliente.atual !== 0 || d.semCliente.base !== 0) && (
              <LinhaPonte rotulo="± Sem cliente identificado" valor={d.semCliente.atual - d.semCliente.base} sinal />
            )}
            <LinhaPonte rotulo={`Receita ${rAtual}`} valor={d.totalAtual} forte />
          </div>

          {comp.estado === 'nao_verificada' && (
            <p className="text-2xs text-status-warning">
              Cobertura dos pedidos sobre a receita contábil não verificada para estas janelas.
            </p>
          )}

          <div className="text-2xs text-muted-foreground leading-relaxed space-y-0.5">
            <p>
              Base comparável: clientes com pedido nos dois períodos. “Entraram” inclui quem voltou depois de sumir,
              não só cliente novo. Valores nominais (sem inflação), de pedidos de venda do app, não receita contábil.
            </p>
            {selection === 'all' && <p>Clientes contados por empresa; cadastros não unificados entre empresas.</p>}
            {(d.pedidosSemValor.atual > 0 || d.pedidosSemValor.base > 0) && (
              <p>
                {d.pedidosSemValor.atual + d.pedidosSemValor.base} pedido(s) sem valor contados como R$ 0.
              </p>
            )}
            {c.coberturas.length > 0 && comp.estado === 'comparavel' && (
              <p title="Receita de pedidos ÷ receita por competência (DRE). Parecidas nas duas janelas = comparação justa.">
                Cobertura dos pedidos: {c.coberturas.map((x) => rotuloCobertura(x, rAtual, rBase)).join(' · ')}
              </p>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
