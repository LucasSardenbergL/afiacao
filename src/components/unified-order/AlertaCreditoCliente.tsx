import { useEffect, useRef } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useAlertaCreditoCliente, ALERTA_CREDITO } from '@/hooks/useAlertaCreditoCliente';
import { formatBRL, formatDate } from '@/lib/reposicao';
import { track } from '@/lib/analytics';

/**
 * Banner informativo de crédito no passo de cliente do wizard (Fase 1 — NÃO bloqueia).
 * Só renderiza com evidência positiva de vencido 60+ (precisão > recall: sem dado,
 * silêncio — nada de "cliente OK" fabricado). Auditável via track() para medir
 * exibição × reação antes de a Fase 2 introduzir bloqueio com aprovação.
 */
export function AlertaCreditoCliente({ documento }: { documento: string | null | undefined }) {
  const { data: alerta, error } = useAlertaCreditoCliente(documento);

  // Auditoria: 1 evento por cliente selecionado (não por re-render).
  const trackedDoc = useRef<string | null>(null);
  useEffect(() => {
    const doc = (documento ?? '').replace(/\D/g, '');
    if (alerta && doc && trackedDoc.current !== doc) {
      trackedDoc.current = doc;
      track('venda.alerta_credito_exibido', {
        vencido: alerta.vencido,
        titulos: alerta.titulos,
        dado_defasado: alerta.dadoDefasado,
      });
    }
  }, [alerta, documento]);

  useEffect(() => {
    if (error) track('venda.alerta_credito_erro', { message: error instanceof Error ? error.message : 'erro' });
  }, [error]);

  // Erro na fonte ou sem evidência → silêncio (o alerta informativo não pode travar a venda).
  if (!alerta) return null;

  return (
    <div
      className="bg-status-warning/10 border border-status-warning/30 rounded-lg p-3"
      data-testid="alerta-credito-cliente"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 text-status-warning flex-shrink-0 mt-0.5" />
        <div className="text-xs">
          <p className="font-semibold text-status-warning">
            Crédito: {formatBRL(alerta.vencido)} vencido há {ALERTA_CREDITO.diasVencidoMin}+ dias
          </p>
          <p className="text-muted-foreground mt-1">
            {alerta.titulos} título{alerta.titulos > 1 ? 's' : ''} em aberto
            {alerta.vencimentoMaisAntigo && <> · mais antigo desde {formatDate(alerta.vencimentoMaisAntigo)}</>}
            {' '}· recomendação: alinhar com o financeiro antes de novo faturamento.
          </p>
          <p className="text-[11px] text-muted-foreground/70 mt-0.5">
            Dados do Omie{alerta.syncAt ? ` sincronizados em ${formatDate(alerta.syncAt.slice(0, 10))}` : ''}.
            {alerta.dadoDefasado && (
              <span className="text-status-warning"> Sync há mais de {ALERTA_CREDITO.defasagemMaxHoras}h — confirme no Omie antes de decidir.</span>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
