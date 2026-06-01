// Card de projeção de caixa — 13 semanas (consolidado das 3 empresas via snapshot da engine A1).
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Target, AlertTriangle } from 'lucide-react';
import { fmtCompact } from './format';
import { compararCaixaInicial, type SemanaConsolidada } from '@/lib/financeiro/cockpit-consolida-helpers';

interface Projecao13CardProps {
  projecao13: SemanaConsolidada[];
  dataReferencia: string | null;
  parcial: boolean;
  empresasPresentes: string[];
  empresasAusentes: string[];
  empresasStale: string[];
  caixaInicialProjecao: number | null;  // caixa que a projeção consolidada usou (Σ saldo_inicial coorte)
  saldoAtualBanco: number;              // totalCC atual
  cohorteCompleta: boolean;             // !parcial — só compara com coorte completa
}

const labelData = (iso: string | null) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '—');
// Defasagem honesta (Codex P3): snapshot mais velho que ontem.
const diasAtras = (iso: string | null): number | null => {
  if (!iso) return null;
  const hoje = new Date();
  const hojeStr = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-${String(hoje.getDate()).padStart(2, '0')}`;
  const diff = (Date.parse(hojeStr) - Date.parse(iso)) / 86400000;
  return Number.isFinite(diff) ? Math.round(diff) : null;
};

export function Projecao13Card({ projecao13, dataReferencia, parcial, empresasPresentes, empresasAusentes, empresasStale, caixaInicialProjecao, saldoAtualBanco, cohorteCompleta }: Projecao13CardProps) {
  const defasagem = diasAtras(dataReferencia);
  const negativas = projecao13.filter((w) => w.saldo_projetado < 0);
  const foraDaCoorte = [...empresasAusentes, ...empresasStale];
  const cmpCaixa = compararCaixaInicial({ caixaInicialProjecao, saldoAtualBanco, cohorteCompleta });
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex flex-wrap items-center gap-2">
          <Target className="w-4 h-4" />
          Projeção de Caixa — {projecao13.length} Semanas
          <Badge variant="outline" className="text-[10px]">Consolidado 3 CNPJ · Cenário: realista</Badge>
          <Badge variant="outline" className={`text-[10px] ${defasagem != null && defasagem > 1 ? 'text-status-warning border-status-warning/50' : 'text-muted-foreground'}`}>
            dados de {labelData(dataReferencia)}{defasagem != null && defasagem > 1 ? ` · ${defasagem}d atrás` : ''}
          </Badge>
        </CardTitle>
        <p className="text-[11px] text-muted-foreground">
          Caixa somado das 3 empresas (engine A1: curvas de cobrança, inadimplência, eventos). Não é caixa fungível
          entre CNPJs nem elimina lançamentos intercompany — veja a quebra por empresa.
        </p>
        {parcial && (
          <p className="text-[11px] text-status-warning">
            Parcial: {empresasPresentes.length} de 3 empresas na coorte. Fora: {foraDaCoorte.join(', ') || '—'}
            {empresasStale.length > 0 && ' (stale = snapshot mais antigo)'}. Números são mínimo conhecido.
          </p>
        )}
        {/* Transparência: caixa que a projeção partiu vs saldo bancário atual (não muda nenhum número). */}
        {cmpCaixa.disponivel ? (
          <p className="text-[11px] text-muted-foreground">
            Caixa inicial da projeção: {fmtCompact(caixaInicialProjecao as number)} · saldo bancário atual {fmtCompact(saldoAtualBanco)} · Δ {fmtCompact(cmpCaixa.delta as number)}{' '}
            <span className="opacity-70">(a diferença pode refletir movimentações após o snapshot)</span>
          </p>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            Caixa inicial da projeção indisponível neste snapshot{cohorteCompleta ? '' : ' (projeção parcial)'}.
          </p>
        )}
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[90px]">Semana</TableHead>
                <TableHead className="text-right">Entradas</TableHead>
                <TableHead className="text-right">Saídas</TableHead>
                <TableHead className="text-right">Fluxo</TableHead>
                <TableHead className="text-right">Saldo</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {projecao13.map((w, i) => {
                const fluxo = w.entradas_previstas - w.saidas_previstas;
                return (
                  <TableRow key={i} className={w.saldo_projetado < 0 ? 'bg-status-error-bg' : ''}>
                    <TableCell className="text-xs">
                      {w.semana_label}
                      {!w.completa && <span className="ml-1 text-[9px] text-status-warning" title="Nem todas as empresas têm esta semana">parc.</span>}
                    </TableCell>
                    <TableCell className="text-right text-sm text-status-success">{fmtCompact(w.entradas_previstas)}</TableCell>
                    <TableCell className="text-right text-sm text-status-error">{fmtCompact(w.saidas_previstas)}</TableCell>
                    <TableCell className={`text-right text-sm font-medium ${fluxo >= 0 ? 'text-status-success' : 'text-status-error'}`}>
                      {fmtCompact(fluxo)}
                    </TableCell>
                    <TableCell className={`text-right text-sm font-bold ${w.saldo_projetado >= 0 ? 'text-status-info' : 'text-status-error'}`}>
                      {fmtCompact(w.saldo_projetado)}
                      {w.saldo_projetado < 0 && <AlertTriangle className="inline w-3 h-3 ml-1 text-status-error" />}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        {negativas.length > 0 && (
          <div className="mt-3 p-3 rounded-lg bg-status-error-bg border border-status-error/20 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-status-error mt-0.5 shrink-0" />
            <p className="text-sm text-status-error-fg">
              Projeção indica saldo negativo em {negativas.length} semana(s).
              Ação necessária antes de {negativas[0]?.semana_label}.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
