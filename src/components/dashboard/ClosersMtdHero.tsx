import { Card } from '@/components/ui/card';
import { Info } from 'lucide-react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { useKpisVisitaMtd } from '@/hooks/useKpisVisitaMtd';
import { formatBRL } from '@/components/customer360/format';
import { estadoDeLeitura, naoConsegui, desatualizado } from '@/lib/leitura/estado-de-leitura';
import { AvisoLeituraFalhou } from '@/components/leitura/AvisoLeituraFalhou';

function KpiCard({ label, value, sub, info }: { label: string; value: string; sub?: string; info?: string }) {
  return (
    <Card className="p-4">
      <div className="text-2xs text-muted-foreground flex items-center gap-1">
        {label}
        {info && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className="inline-flex" aria-label="Mais informação sobre este indicador">
                <Info className="w-3 h-3 text-muted-foreground/70" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs text-2xs">{info}</TooltipContent>
          </Tooltip>
        )}
      </div>
      <div className="kpi-value text-2xl">{value}</div>
      {sub && <div className="text-2xs text-muted-foreground mt-0.5">{sub}</div>}
    </Card>
  );
}

/**
 * Placar do mês do CLOSER (output, MTD) — o norte do dashboard de visitas.
 *
 * ⚠️ "Valor informado" = `revenue_generated` que o vendedor digita ao registrar a
 * visita; NÃO é conciliado com o ERP → não é receita reconhecida nem base de comissão
 * (decisão Codex; ver docs/superpowers/specs/2026-06-13-kpis-closer-meu-dia-design.md).
 * A qualidade do dado é exposta (fechamentos sem valor, visitas sem resultado) pra não
 * mascarar subnotificação. Self-hide quando não há visita no mês — VERIFICADO.
 *
 * CLASSE "erro colapsado em vazio" (docs/historico/fase-sem-sinal.md): a linha
 * `if (isLoading || !k || k.totalVisitas === 0) return null` é o defeito original da
 * classe — o hook LANÇA quando o SELECT em `route_visits` falha, e o placar do mês sumia
 * do dashboard exatamente como se o vendedor não tivesse registrado nenhuma visita.
 * `route_visits` tem 0 linhas hoje (psql-ro, 2026-08-23): o dano ainda não aconteceu, e o
 * gatilho é a PRIMEIRA visita registrada — a partir dela, uma falha de leitura passa a
 * afirmar "mês zerado" para quem vendeu.
 */
export function ClosersMtdHero() {
  const q = useKpisVisitaMtd();
  const { data: k } = q;
  const estado = estadoDeLeitura(q);

  // Sem NADA em mãos: o placar não pode sumir calado — some junto com a conclusão
  // "não vendi nada este mês", que é a leitura errada que ele mesmo induz.
  if (naoConsegui(estado) && !k) {
    return <AvisoLeituraFalhou oque="o seu placar do mês" estado={estado} className="mb-0" />;
  }
  // Com o placar em mãos e um refetch que falhou, os números FICAM — só declaram idade.
  const velho = desatualizado(q, Boolean(k));
  // `carregando`/`desabilitada` (sem uid) e o mês SEM visita — este é o único silêncio
  // legítimo, e agora é um zero verificado, não a ausência de resposta.
  if (estado === 'carregando' || !k || k.totalVisitas === 0) return null;

  const qualidade: string[] = [];
  if (k.fechadosSemValor > 0) qualidade.push(`${k.fechadosSemValor} fechamento${k.fechadosSemValor > 1 ? 's' : ''} sem valor`);
  if (k.semResultado > 0) qualidade.push(`${k.semResultado} visita${k.semResultado > 1 ? 's' : ''} sem resultado`);

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <KpiCard
          label="Valor informado (mês)"
          value={formatBRL(k.receitaTotal)}
          sub="pedidos fechados em visita"
          info="Valor INFORMADO pelo vendedor ao registrar a visita — não conciliado com o ERP. Não é receita reconhecida nem base de comissão."
        />
        <KpiCard label="Fechamentos (mês)" value={String(k.fechados)} sub="visitas que viraram pedido" />
        <KpiCard label="Visitas registradas (mês)" value={String(k.totalVisitas)} sub="atividade do mês" />
      </div>
      {qualidade.length > 0 && (
        <p className="text-2xs text-muted-foreground">Qualidade do dado: {qualidade.join(' · ')}.</p>
      )}
      {velho && <AvisoLeituraFalhou oque="a leitura mais recente do placar" estado={velho} className="mt-2" />}
    </div>
  );
}
