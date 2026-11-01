import { useEffect, useState } from 'react';
import { Inbox, ListChecks } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { useCicloCoorte, useCicloResumo, useCrAbertoTotal, useReceitaDiariaTtm, useReguaCiclo, hojeSp, useCicloCustoCapital } from '@/hooks/useFinanceiroCiclo';
import { useUrlState } from '@/hooks/useUrlState';
import { ALL_COMPANIES, COMPANIES, type Company } from '@/contexts/CompanyContext';
import { EmptyState } from '@/components/EmptyState';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { track } from '@/lib/analytics';
import { registrarNoLedger } from '@/lib/analytics-ledger';
import type { ResumoCliente } from '@/lib/financeiro/ciclo-cliente-helpers';
import { CicloEmpresaCard } from './CicloEmpresaCards';
import { CicloTendencia } from './CicloTendencia';
import { CicloClientesTabela } from './CicloClientesTabela';
import { CicloClienteDrill } from './CicloClienteDrill';
import { CicloDescontoPainel } from './CicloDescontoPainel';
import { CicloGiroEstoque, type FiltroAcaoGiro } from './CicloGiroEstoque';
import { CicloFornecedoresSecao } from './CicloFornecedoresSecao';
import { CicloRupturaSensor } from './CicloRupturaSensor';
import { CargaAoAparecer } from './CargaAoAparecer';
import { useCicloCpEmpresa } from '@/hooks/useFinanceiroCicloFornecedor';

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
  const cpEmpresa = useCicloCpEmpresa();
  const [filtros, setFiltros] = useUrlState({ cicloEmpresa: 'oben', cicloPerfil: 'todos', cicloGiroAcao: 'todos' });
  const custoCapital = useCicloCustoCapital();
  const regua = useReguaCiclo();
  const crAberto = useCrAbertoTotal();
  const [aberto, setAberto] = useState<ResumoCliente | null>(null);

  // Sensor de uso no LEDGER (o PostHog é censurado no Chrome do founder, o leitor da aba); a RPC
  // deduplica por titular/dia, então o duplo efeito do StrictMode não infla nada.
  useEffect(() => {
    track('financeiro.ciclo_aberto');
    void registrarNoLedger('financeiro.ciclo_aberto', 'aba');
  }, []);

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
            resumo={resumo.data} resumoErro={resumo.error !== null && resumo.error !== undefined} hoje={hoje}
            cpEmpresa={cpEmpresa.data?.[c]} cpErro={cpEmpresa.error !== null && cpEmpresa.error !== undefined}
            regua={regua.data?.[c]} reguaErro={regua.error !== null && regua.error !== undefined}
            crAberto={crAberto.data?.[c]} crErro={crAberto.error !== null && crAberto.error !== undefined} />
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

      {/* Abaixo da dobra: só monta (e só lê) quando aparece na tela — carga escalonada, ver ciclo-fila.ts. */}
      <CargaAoAparecer rotulo="Giro de estoque">
        <CicloGiroEstoque
          empresas={tendencias}
          acao={(['todos', 'liquidar', 'segurar_compra'].includes(filtros.cicloGiroAcao) ? filtros.cicloGiroAcao : 'todos') as FiltroAcaoGiro}
          onAcao={(a) => setFiltros({ cicloGiroAcao: a })}
        />
      </CargaAoAparecer>

      {/* Sensor de ruptura: só a Oben tem (pedidos nascem no Omie; trigger na importação). Abaixo da dobra. */}
      {tendencias.includes('oben') && (
        <CargaAoAparecer rotulo="Sensor de ruptura">
          <CicloRupturaSensor hoje={hoje} />
        </CargaAoAparecer>
      )}
      {/* Frente B (PR2): a fila de cobrança com estado e dona vive na rota /cobranca (módulo próprio, staff);
          aqui só o atalho — a aba Ciclo segue sendo a leitura, a cobrança é a ação. */}
      <Button asChild variant="outline" size="sm" className="w-fit">
        <Link to={`/cobranca?empresa=${empresa === 'all' ? 'oben' : empresa}`} data-testid="ciclo-link-cobranca">
          <ListChecks className="h-4 w-4 mr-1" /> Fila de cobrança (estado, dona, promessa, régua D−2/D+1/D+7)
        </Link>
      </Button>
      <CicloDescontoPainel empresas={tendencias} custos={custoCapital.data} erro={custoCapital.error} carregando={custoCapital.isLoading}
        clientes={resumo.data} clientesIndisponiveis={resumo.isLoading || !!resumo.error} />
      <CargaAoAparecer rotulo="Fornecedores">
        <CicloFornecedoresSecao empresas={tendencias} hoje={hoje} />
      </CargaAoAparecer>
      <CicloClienteDrill cliente={aberto} hoje={hoje} onFechar={() => setAberto(null)} />
    </div>
  );
}
