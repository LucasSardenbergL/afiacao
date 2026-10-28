import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatBRL } from '@/lib/reposicao';
import {
  fmtInstanteSP,
  fmtNum,
  regraDaFaixa,
  rotuloFaixa,
  rotuloMotivo,
  type FaixaCorante,
  type GiroCorante,
} from '@/lib/reposicao/corantes-helpers';

const COR_FAIXA: Record<FaixaCorante, string> = {
  sem_recomendacao: 'text-muted-foreground',
  parado: 'text-status-warning',
  muito_pouco: 'text-status-warning',
  devagar: 'text-status-info',
  rapido: 'text-status-info',
};

/** Valor com unidade; `null` → "—" sozinho (nunca "— L", nunca 0). */
function comUnidade(v: number | null, casas: number, unidade: string): string {
  return v === null ? '—' : `${fmtNum(v, casas)} ${unidade}`;
}

function CelulaFaixa({ l }: { l: GiroCorante }) {
  // Dado parado ≥ 4 dias: a faixa vigente é "—"; mostra o último cálculo, marcado como velho.
  if (l.fresco === false) {
    return (
      <div className="space-y-0.5">
        <span className="text-muted-foreground">—</span>
        <p className="text-xs text-status-warning">
          último cálculo: {l.faixa_ultimo_calculo ? rotuloFaixa(l.faixa_ultimo_calculo) : '—'} · desatualizado desde{' '}
          {fmtInstanteSP(l.coberto_ate)}
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <span className={COR_FAIXA[l.faixa]}>{rotuloFaixa(l.faixa)}</span>
      {l.giro_mudando === true && (
        <Badge variant="outline" className="block w-fit text-status-warning">
          giro mudando
        </Badge>
      )}
    </div>
  );
}

export function CorantesTable({ linhas }: { linhas: GiroCorante[] }) {
  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>WP</TableHead>
            <TableHead>Faixa</TableHead>
            <TableHead className="min-w-[16rem]">Regra</TableHead>
            <TableHead className="text-right">Consumo</TableHead>
            <TableHead className="text-right">Demanda do motor</TableHead>
            <TableHead className="text-right">Ponto de pedido</TableHead>
            <TableHead>LT</TableHead>
            <TableHead className="text-right">Estoque fechado</TableHead>
            <TableHead className="text-right">Teto</TableHead>
            <TableHead className="text-right">Excesso</TableHead>
            <TableHead>Confiança</TableHead>
            <TableHead>Frescor</TableHead>
            <TableHead>Motivo</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {linhas.map((l) => (
            <TableRow key={l.tint_corante_id} data-testid={`corante-${l.wp_codigo}`}>
              <TableCell className="font-medium" title={l.descricao ?? undefined}>
                {l.wp_codigo}
              </TableCell>
              <TableCell>
                <CelulaFaixa l={l} />
              </TableCell>
              <TableCell className="text-sm">
                {l.fresco === false ? '—' : regraDaFaixa(l.faixa, l.k_latas, l.lt_dias_corridos)}
              </TableCell>
              <TableCell className="text-right tabular-nums">{comUnidade(l.consumo_ml_dia, 1, 'ml/dia')}</TableCell>
              <TableCell className="text-right tabular-nums">{comUnidade(l.demanda_motor_l_dia, 3, 'L/dia')}</TableCell>
              <TableCell className="text-right tabular-nums">{comUnidade(l.ponto_pedido_ml, 0, 'ml')}</TableCell>
              <TableCell className="tabular-nums">
                {l.lt_dias_corridos === null ? '—' : `${l.lt_dias_corridos} d (${l.lt_fonte ?? '—'})`}
              </TableCell>
              <TableCell className="text-right tabular-nums">{comUnidade(l.estoque_fechado_l, 2, 'L')}</TableCell>
              <TableCell className="text-right tabular-nums">{comUnidade(l.teto_l, 2, 'L')}</TableCell>
              <TableCell className="text-right tabular-nums" data-testid="celula-excesso">
                {l.excesso_l === null ? (
                  '—'
                ) : (
                  <div>
                    <div>{comUnidade(l.excesso_l, 2, 'L')}</div>
                    <div className="text-xs text-muted-foreground">{formatBRL(l.capital_parado)}</div>
                  </div>
                )}
              </TableCell>
              <TableCell>{l.confianca ?? '—'}</TableCell>
              <TableCell className="text-xs">
                {l.coberto_ate === null
                  ? '—'
                  : l.fresco === false
                    ? <span className="text-status-warning">desatualizado</span>
                    : `até ${fmtInstanteSP(l.coberto_ate)}`}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">{l.motivo ? rotuloMotivo(l.motivo) : '—'}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
