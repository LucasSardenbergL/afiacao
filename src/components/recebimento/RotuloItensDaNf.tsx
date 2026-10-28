import { Badge } from '@/components/ui/badge';
import {
  EXPLICACAO_RECEBIDA_FORA_DO_APP,
  ROTULO_ITENS_NAO_CARREGADOS,
  ROTULO_RECEBIDA_FORA_DO_APP,
  type SituacaoItensNf,
} from '@/lib/recebimento/itens-da-nf';

/** Rótulo da NF-e sem itens no app (lista de recebimento e histórico). `com_itens` não rende nada. */
export function RotuloItensDaNf({ situacao }: { situacao: SituacaoItensNf }) {
  if (situacao === 'recebida_fora_do_app') {
    return (
      <Badge
        className="text-xs bg-status-info-bg text-status-info-foreground"
        title={EXPLICACAO_RECEBIDA_FORA_DO_APP}
        data-testid="nf-recebida-fora-do-app"
      >
        {ROTULO_RECEBIDA_FORA_DO_APP}
      </Badge>
    );
  }
  if (situacao === 'itens_nao_carregados') {
    return (
      <span className="text-status-warning" data-testid="nf-itens-nao-carregados">
        {ROTULO_ITENS_NAO_CARREGADOS}
      </span>
    );
  }
  return null;
}
