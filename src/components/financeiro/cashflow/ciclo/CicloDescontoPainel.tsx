import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { descontoMaximo, type ResumoCliente } from '@/lib/financeiro/ciclo-cliente-helpers';
import { custoAnualDoDesconto, elegibilidadeDesconto, type CustoCapital } from '@/lib/financeiro/ciclo-desconto-helpers';
import { COMPANIES, type Company } from '@/contexts/CompanyContext';

const N_CENARIOS = [10, 20, 30] as const;
const formatDate = (iso: string) => { const [a, m, d] = iso.slice(0, 10).split('-'); return `${d}/${m}/${a}`; };
const ALERTA = custoAnualDoDesconto(0.01, 7);

/**
 * Desconto por pontualidade — teto de indiferença (Frente B, PR3). O custo do dinheiro vem do BANCO
 * (`fin_funding_inputs.custo_capital_mensal`, 1 writer: migration/SQL Editor), não mais da URL.
 * Empresa sem CET cadastrado ⇒ "—" e nenhum número (ausente ≠ zero). A elegibilidade separa quem
 * já antecipa (não se subsidia) de quem tem dias a ganhar — decisão do founder.
 */
function CustoEmpresa({ company, custo, clientes }: { company: Company; custo: CustoCapital | null; clientes: ResumoCliente[] | null }) {
  const eleg = useMemo(() => {
    if (clientes === null) return null;
    const acc = { elegiveis: 0, jaAntecipa: 0, semHistorico: 0 };
    for (const c of clientes) {
      if (c.company !== company) continue;
      const e = elegibilidadeDesconto(c);
      if (e.elegivel) acc.elegiveis += 1;
      else if (e.motivo === 'ja_antecipa') acc.jaAntecipa += 1;
      else acc.semHistorico += 1;
    }
    return acc;
  }, [clientes, company]);

  const c = custo?.custoMensal ?? null;
  return (
    <div className="space-y-2" data-testid={`ciclo-desconto-${company}`}>
      <p className="flex flex-wrap items-baseline gap-2">
        <span className="font-medium">{COMPANIES[company].shortName}</span>
        {c === null ? (
          <span className="text-muted-foreground">
            custo do dinheiro <span className="font-mono">—</span> · CET não cadastrado (coluna <code>custo_capital_mensal</code> de <code>fin_funding_inputs</code>, pelo financeiro no SQL Editor; o formulário de Funding NÃO grava este campo). Sem CET não há desconto a simular.
          </span>
        ) : (
          <span className="text-muted-foreground">
            custo do dinheiro <span className="font-mono">{(c * 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}% a.m.</span>
            {custo?.fonte && <> · fonte: {custo.fonte}</>}
            {custo?.em && <> · em {formatDate(custo.em.slice(0, 10))}</>}
          </span>
        )}
      </p>
      {c !== null && (
        <table className="w-full text-left">
          <thead><tr><th>Antecipa N dias</th><th className="text-right">Desconto máximo</th></tr></thead>
          <tbody>
            {N_CENARIOS.map((n) => {
              const r = descontoMaximo(c, n);
              return (
                <tr key={n}>
                  <td>{n} dias</td>
                  <td className="text-right font-mono">{r.ok ? `${(r.dMax * 100).toFixed(2).replace('.', ',')}%` : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {eleg === null ? (
        <p className="text-xs text-muted-foreground" data-testid={`ciclo-desconto-${company}-elegiveis`}>Elegibilidade: resumo de clientes indisponível (sem contagem).</p>
      ) : (
        <p className="text-xs text-muted-foreground" data-testid={`ciclo-desconto-${company}-elegiveis`}>
          Elegíveis ao desconto (atrasam, pontuais ou com vencido): <span className="font-mono">{eleg.elegiveis}</span>
          {' '}· já antecipam (não subsidiar): <span className="font-mono">{eleg.jaAntecipa}</span>
          {' '}· sem histórico: <span className="font-mono">{eleg.semHistorico}</span>
        </p>
      )}
    </div>
  );
}

export function CicloDescontoPainel({ empresas, custos, erro, carregando = false, clientes, clientesIndisponiveis = false }: {
  empresas: Company[];
  custos: CustoCapital[] | undefined;
  erro: unknown;
  /** Leitura do CET ainda em voo: nada se afirma (nem "não cadastrado"). */
  carregando?: boolean;
  clientes: ResumoCliente[] | undefined;
  /** Resumo de clientes em voo ou com erro: as contagens de elegibilidade não se afirmam. */
  clientesIndisponiveis?: boolean;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Desconto por pontualidade — teto de indiferença</CardTitle>
        <p className="text-xs text-muted-foreground">
          d = 1 − (1+c)^(−N/30). Antes de custos operacionais e mudança de risco. N é a antecipação de CENÁRIO (nunca o atraso histórico).
          Só para quem antecipa de fato: quem já paga antes do vencimento não recebe desconto.
        </p>
        {ALERTA !== null && (
          <p className="text-xs text-status-warning" data-testid="ciclo-desconto-alerta-anual">
            Atenção: 1% de desconto por 7 dias de antecipação custa ≈ {(ALERTA * 100).toFixed(1).replace('.', ',')}% a.a. — desconto pequeno em prazo curto é caro.
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {erro ? (
          <p className="text-status-error">Não foi possível ler o custo do dinheiro (erro de leitura) — sem número até a leitura voltar.</p>
        ) : carregando || custos === undefined ? (
          <p className="text-muted-foreground" data-testid="ciclo-desconto-carregando">Lendo o custo do dinheiro…</p>
        ) : (
          empresas.map((c) => (
            <CustoEmpresa key={c} company={c} custo={custos.find((x) => x.company === c) ?? null} clientes={clientesIndisponiveis ? null : clientes ?? []} />
          ))
        )}
      </CardContent>
    </Card>
  );
}
