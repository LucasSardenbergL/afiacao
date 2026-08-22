import { AlertTriangle } from 'lucide-react';
import { useDataHealth } from '@/hooks/useDataHealth';
import { estadoDeLeitura, naoConsegui } from '@/lib/leitura/estado-de-leitura';
import { AvisoLeituraFalhou } from '@/components/leitura/AvisoLeituraFalhou';
import { cn } from '@/lib/utils';

/**
 * Banner inline não-bloqueante pra UMA fonte. Aparece pra qualquer staff que abra a tela.
 *
 * ⚠️ FAIL-CLOSED de propósito. O banner fazia:
 *
 *     const { data } = useDataHealth();
 *     const check = data?.find(c => c.source === source);
 *     if (!check || check.status === 'ok') return null;
 *
 * `useDataHealth` lança quando `get_data_health` falha, então no erro `data` fica
 * `undefined` → `check` fica `undefined` → o banner SOME. Some do dashboard financeiro
 * (`source="saldo_bancario"`) e do cockpit de reposição (`reposicao_sugestoes`,
 * `estoque_inventario`) — as duas telas de money-path onde ele existe justamente para
 * dizer "dado não confiável, não decida por aqui". Ausência afirmando segurança.
 *
 * O contra-exemplo estava a 20 linhas daqui o tempo todo: `DataHealthBadge` faz
 * `isError ? 'red' : badgeLevel(...)`. Mesmo hook, semântica oposta na falha.
 *
 * `!check` com a leitura PRONTA é caso à parte: quer dizer que `_data_health_compute`
 * não emite esse `source`. Medido em prod (2026-08-22, psql-ro): os 3 sources montados
 * hoje existem lá — então esse ramo é inalcançável agora, e é essa a razão de ele ser
 * BARULHENTO. Um rename que derrube um check faria o alarme sumir em silêncio, que é a
 * mesma classe outra vez; assim ele vira erro visível já no dev.
 */
export function DataHealthBanner({ source }: { source: string }) {
  const q = useDataHealth();
  const estado = estadoDeLeitura(q);

  // Sem leitura não há afirmação possível sobre a saúde da fonte.
  if (naoConsegui(estado)) {
    return <AvisoLeituraFalhou oque={`a saúde da fonte "${source}"`} estado={estado} />;
  }
  // `carregando`/`desabilitada`: ausência TRANSITÓRIA e auto-resolvida (a query refaz a
  // cada 2min). Um "verificando…" piscando em toda montagem de tela seria ruído num
  // componente invisível na esmagadora maioria das vezes — o dano da classe é o silêncio
  // PERSISTENTE, e esse fica coberto pelo ramo acima.
  if (estado !== 'pronta') return null;

  const check = q.data?.find((c) => c.source === source);
  if (!check) {
    return <AvisoLeituraFalhou oque={`a saúde da fonte "${source}" (não monitorada)`} estado="erro" />;
  }
  if (check.status === 'ok') return null;

  const isBroken = check.status === 'broken' || check.status === 'unknown';
  return (
    <div className={cn(
      'flex items-start gap-2 rounded-md border px-3 py-2 text-sm mb-3',
      isBroken ? 'bg-status-error-bg border-status-error/30 text-status-error'
               : 'bg-status-warning-bg border-status-warning/30 text-status-warning',
    )}>
      <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
      <span>{check.message} — dado não confiável, não decida por aqui.</span>
    </div>
  );
}
