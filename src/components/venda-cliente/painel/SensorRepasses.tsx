import type { UseQueryResult } from '@tanstack/react-query';
import { Activity, ShieldAlert } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { Badge } from '@/components/ui/badge';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { mensagemErroRepasse } from '@/hooks/useVendaPainel';
import {
  formatarPct,
  formatarPreco,
  formatarReais,
  type CriterioDesligar,
  type SensorRepasse,
} from '@/lib/venda-cliente/painel';

const QTD = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });

const CRITERIO: Record<CriterioDesligar, { rotulo: string; classe: string }> = {
  atingido: { rotulo: 'desligar: perda ≥ ganho', classe: 'border-status-error/40 text-status-error' },
  nao_atingido: { rotulo: 'manter: ganho > perda', classe: 'border-status-success/40 text-status-success' },
  cedo: { rotulo: 'cedo (< 1 cadência)', classe: 'text-muted-foreground' },
  indisponivel: { rotulo: 'não dá para medir', classe: 'border-status-warning/40 text-status-warning' },
};

const MOTIVO: Record<string, string> = {
  sem_linha_de_base: 'sem cadência/quantidade congeladas na aprovação',
  janela_menor_que_cadencia: 'menos de uma cadência desde a aprovação',
  sem_custo_na_aprovacao: 'sem custo fresco na aprovação',
  margem_nao_positiva: 'margem antiga não positiva',
  quantidade_sem_preco: 'há compra sem preço apurado',
};

function dataCurta(iso: string) {
  const [a, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${a.slice(2)}`;
}

/**
 * Sensor dos repasses aprovados (`venda_repasse_sensor`, 20261113213000). Por versão aprovada:
 * quanto foi vendido ao preço novo ÷ o elegível (tudo o que o cliente comprou do SKU na janela) e
 * o critério de desligar — a perda de volume (esperado pela cadência DA APROVAÇÃO − comprado,
 * × margem antiga) ≥ o ganho de preço, na mesma base tributária. É referência estimada, não prova
 * causal: nada desliga sozinho, o founder revisa e revoga.
 */
export function SensorRepasses({
  sensor,
  nomeDe,
}: {
  sensor: UseQueryResult<SensorRepasse[]>;
  nomeDe: (id: string) => string;
}) {
  return (
    <section className="space-y-2 pb-6" aria-labelledby="sensor-repasses">
      <div>
        <h3 id="sensor-repasses" className="text-sm font-medium">Repasses aprovados — sensor</h3>
        <p className="text-xs text-muted-foreground">
          Vendido ao preço novo ÷ elegível depois da aprovação. Critério de desligar: quando a perda de volume
          (o que deixou de vender frente à cadência da aprovação × a margem antiga) é maior ou igual ao ganho de
          preço, o repasse custa mais do que rende — revise ou revogue.
        </p>
      </div>
      {sensor.isLoading ? (
        <PageSkeleton variant="list" />
      ) : sensor.isError ? (
        <EmptyState
          icon={ShieldAlert}
          title="Não consegui ler o sensor"
          description={`Erro ao ler venda_repasse_sensor: ${mensagemErroRepasse(sensor.error)}`}
          actionLabel="Tentar de novo"
          onAction={() => void sensor.refetch()}
        />
      ) : !sensor.data || sensor.data.length === 0 ? (
        sensor.data ? (
          <EmptyState
            icon={Activity}
            tone="operational"
            title="Nenhum repasse aprovado ainda"
            description="Quando o primeiro repasse for aprovado, o sensor aparece aqui (a partir do dia seguinte à aprovação)."
          />
        ) : null
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Comprador</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead className="text-right">Alvo / antes</TableHead>
                <TableHead className="text-right" title="Dias desde a aprovação ÷ cadência congelada">Janela</TableHead>
                <TableHead className="text-right" title="Quantidade ao preço novo ÷ quantidade elegível">Ao preço novo</TableHead>
                <TableHead className="text-right" title="Comprado ÷ esperado pela cadência da aprovação">Volume</TableHead>
                <TableHead className="text-right">Ganho de preço</TableHead>
                <TableHead className="text-right">Perda de volume</TableHead>
                <TableHead>Critério de desligar</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sensor.data.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="max-w-[14rem] truncate font-medium" title={nomeDe(s.comprador_id)}>
                    {nomeDe(s.comprador_id)}
                    <span className="block text-xs text-muted-foreground">
                      {s.vigente ? `vigente até ${dataCurta(s.valido_ate)}` : s.revogado_em ? `revogado ${dataCurta(s.revogado_em)}` : 'vencido'}
                    </span>
                  </TableCell>
                  <TableCell className="max-w-[16rem] truncate" title={s.descricao ?? undefined}>
                    {s.descricao ?? `SKU ${s.omie_codigo_produto}`}
                    <span className="block text-xs text-muted-foreground">aprovado {dataCurta(s.aprovado_em)}</span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatarPreco(s.preco_alvo)}
                    <span className="block text-xs text-muted-foreground">{formatarPreco(s.ultimo_preco_na_aprovacao)}</span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {s.dias_janela} d
                    <span className="block text-xs text-muted-foreground">
                      {s.cadencia_na_aprovacao === null ? 'sem cadência' : `cad. ${QTD.format(s.cadencia_na_aprovacao)} d`}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {QTD.format(s.qtd_ao_preco_novo)} / {QTD.format(s.qtd_elegivel)}
                    <span className="block text-xs text-muted-foreground">
                      {s.razao_preco_novo === null ? '—' : formatarPct(s.razao_preco_novo)}
                      {s.qtd_sem_preco > 0 && ` · ${QTD.format(s.qtd_sem_preco)} sem preço`}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {QTD.format(s.qtd_elegivel)} / {s.qtd_esperada === null ? '—' : QTD.format(s.qtd_esperada)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatarReais(s.ganho_preco)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatarReais(s.perda_volume)}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={`text-[10px] ${CRITERIO[s.criterio_desligar].classe}`}>
                      {CRITERIO[s.criterio_desligar].rotulo}
                    </Badge>
                    {s.motivo && (
                      <span className="block pt-0.5 text-xs text-muted-foreground">{MOTIVO[s.motivo] ?? s.motivo}</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
