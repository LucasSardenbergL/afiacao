import { useEffect, useState } from 'react';
import { Inbox } from 'lucide-react';
import { useCicloCoorte, useCicloResumo, useReceitaDiariaTtm, hojeSp } from '@/hooks/useFinanceiroCiclo';
import { useUrlState } from '@/hooks/useUrlState';
import { ALL_COMPANIES, COMPANIES, type Company } from '@/contexts/CompanyContext';
import { EmptyState } from '@/components/EmptyState';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { track } from '@/lib/analytics';
import type { ResumoCliente } from '@/lib/financeiro/ciclo-cliente-helpers';
import { CHAVE_CUSTO } from './ciclo-format';
import { CicloEmpresaCard } from './CicloEmpresaCards';
import { CicloTendencia } from './CicloTendencia';
import { CicloClientesTabela } from './CicloClientesTabela';
import { CicloClienteDrill } from './CicloClienteDrill';
import { CicloDescontoPainel } from './CicloDescontoPainel';

const CAVEAT_CICLO =
  'Direcional. Prazo concedido = vencimento − emissão de cada parcela (vencimento vigente; renegociação apaga o original). Todo R$ é cenário, não previsão — não há piloto medido.';

const PERFIS: Array<[string, string]> = [
  ['todos', 'Todos os perfis'], ['atraso_cronico', 'Atraso crônico'], ['atraso_leve', 'Atraso leve'],
  ['pontual', 'Pontual'], ['folga', 'Folga'], ['misto', 'Misto'], ['sem_dado', 'Sem pagamento'],
];

export function CicloTab() {
  const hoje = hojeSp();
  const resumo = useCicloResumo();
  const coorte = useCicloCoorte();
  const receita = useReceitaDiariaTtm();
  const [filtros, setFiltros] = useUrlState({ cicloEmpresa: 'oben', cicloPerfil: 'todos', cicloCustoOben: '', cicloCustoColacor: '', cicloCustoColacorSc: '' });
  const [aberto, setAberto] = useState<ResumoCliente | null>(null);

  useEffect(() => { track('financeiro.ciclo_aberto'); }, []);

  const empresa = (filtros.cicloEmpresa === 'all' || ALL_COMPANIES.includes(filtros.cicloEmpresa as Company)
    ? filtros.cicloEmpresa : 'oben') as Company | 'all';
  const coorteDados = coorte.data ?? [];
  const tendencias: Company[] = empresa === 'all' ? ALL_COMPANIES : [empresa];

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">{CAVEAT_CICLO}</p>

      <div className="grid gap-3 md:grid-cols-3">
        {ALL_COMPANIES.map((c) => (
          <CicloEmpresaCard key={c} company={c} coorte={coorteDados} receitaDia={receita.data?.[c].porDia ?? null} receitaMeses={receita.data?.[c].mesesComDado} receitaErro={receita.error !== null && receita.error !== undefined}
            resumo={resumo.data} resumoErro={resumo.error !== null && resumo.error !== undefined} hoje={hoje} />
        ))}
      </div>
      {receita.error && <p className="text-status-error text-sm">Não foi possível ler a receita TTM (valor de 1 dia de PMR indisponível).</p>}
      {coorte.error && <p className="text-status-error text-sm">Não foi possível ler a tendência por coorte.</p>}
      {coorte.isLoading && <PageSkeleton variant="cockpit" />}
      {!coorte.error && !coorte.isLoading && tendencias.map((c) => <CicloTendencia key={c} coorte={coorteDados} company={c} />)}

      <div className="flex flex-wrap items-center gap-2">
        <Select value={empresa} onValueChange={(v) => setFiltros({ cicloEmpresa: v })}>
          <SelectTrigger className="w-40" aria-label="Empresa"><SelectValue /></SelectTrigger>
          <SelectContent>
            {ALL_COMPANIES.map((c) => <SelectItem key={c} value={c}>{COMPANIES[c].shortName}</SelectItem>)}
            <SelectItem value="all">Todas (lado a lado, sem total)</SelectItem>
          </SelectContent>
        </Select>
        <Select value={filtros.cicloPerfil} onValueChange={(v) => setFiltros({ cicloPerfil: v })}>
          <SelectTrigger className="w-44" aria-label="Perfil"><SelectValue /></SelectTrigger>
          <SelectContent>
            {PERFIS.map(([v, r]) => <SelectItem key={v} value={v}>{r}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {resumo.isLoading && <PageSkeleton variant="list" />}
      {resumo.error && <p className="text-status-error text-sm">Não foi possível ler o comportamento de pagamento dos clientes.</p>}
      {resumo.data && resumo.data.length === 0 && (
        <EmptyState tone="operational" icon={Inbox} title="Sem títulos pagos ou vencidos" description="Nenhum título pago em 12 meses nem vencido em aberto." />
      )}
      {resumo.data && resumo.data.length > 0 && tendencias.map((c) => (
        <section key={c} className="space-y-2" aria-label={`Fila ${COMPANIES[c].shortName}`}>
          {empresa === 'all' && <h3 className="text-sm font-medium">{COMPANIES[c].shortName}</h3>}
          <CicloClientesTabela
            clientes={resumo.data} hoje={hoje} empresa={c} perfilFiltro={filtros.cicloPerfil}
            onAbrir={(cl) => { setAberto(cl); track('financeiro.ciclo_cliente_drill', { empresa: cl.company }); }}
          />
        </section>
      ))}

      <CicloDescontoPainel
        empresas={tendencias}
        custos={{ oben: filtros.cicloCustoOben, colacor: filtros.cicloCustoColacor, colacor_sc: filtros.cicloCustoColacorSc }}
        onCusto={(c, t) => setFiltros({ [CHAVE_CUSTO[c]]: t })}
      />
      <CicloClienteDrill cliente={aberto} hoje={hoje} onFechar={() => setAberto(null)} />
    </div>
  );
}
