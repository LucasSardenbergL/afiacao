// O ÚNICO caminho pelo qual um desfecho de recomendação sai do browser.
//
// Contexto (medido em prod com psql-ro, 2026-08-21): `farmer_recommendations` tem
// 17.316 linhas — 16.233 'expirado' e 1.083 'pendente' — e ZERO desfecho em TODAS
// as cinco colunas que existiam para registrá-lo. O motor recomenda desde fev/2026
// e nunca soube se acertou; `farmer_category_conversion` tem 0 linhas pelo mesmo
// motivo, e por isso TAXA_CONVERSAO_* e FATOR_COMPLEXIDADE seguem ARBITRADOS.
//
// O escritor mora no BANCO (`farmer_recomendacao_registrar_desfecho`) e não aqui:
// ele resolve o vendedor por `auth.uid()` FIXO, valida a transição e é o único
// ponto que carimba as colunas de desfecho. Este hook é transporte + tradução de
// erro. Ver supabase/migrations/20260821194411_farmer_recomendacao_desfecho.sql.
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { track } from '@/lib/analytics';

/** Os dois desfechos TERMINAIS. 'ofertado' fica fora — ver a nota na migration. */
export type Desfecho = 'aceito' | 'rejeitado';

/**
 * O porquê de uma recusa, em vocabulário FECHADO.
 *
 * Fechado porque texto livre não calibra nada: o gate `clusterAdherence < 0.03` e
 * os pesos do ranking precisam de categorias contáveis, não de frases. E espelha
 * EXATAMENTE o CHECK `farmer_recommendations_motivo_coerente` — divergir aqui faria
 * o banco recusar o clique com um erro que a vendedora não teria como interpretar.
 *
 * ⚠️ `sem_estoque` e `prazo_entrega` são falha OPERACIONAL, não erro do motor
 * (achado do /codex): quem for calibrar afinidade precisa separá-los dos outros
 * quatro, senão penaliza a recomendação por um problema de logística.
 */
export const MOTIVOS_RECUSA = [
  { valor: 'preco',                 rotulo: 'Preço' },
  { valor: 'sem_necessidade',       rotulo: 'Não precisa' },
  { valor: 'ja_compra_concorrente', rotulo: 'Compra de outro' },
  { valor: 'sem_estoque',           rotulo: 'Sem estoque' },
  { valor: 'prazo_entrega',         rotulo: 'Prazo de entrega' },
  { valor: 'outro',                 rotulo: 'Outro' },
] as const;

export type MotivoRecusa = (typeof MOTIVOS_RECUSA)[number]['valor'];

/** O que identifica uma oferta para o banco: a chave de negócio, não o id. */
export interface AlvoDesfecho {
  customerId: string;
  productId: string;
  type: 'cross_sell' | 'up_sell';
}

export const chaveDoAlvo = (a: AlvoDesfecho) => `${a.customerId}|${a.productId}|${a.type}`;

/**
 * Traduz a SQLSTATE da RPC para o que a vendedora precisa FAZER.
 *
 * Genérico ("erro ao salvar") esconde a diferença entre "sua sessão caiu" e "esta
 * oferta não existe mais" — e são ações opostas. Códigos em
 * supabase/migrations/20260821194411_farmer_recomendacao_desfecho.sql.
 */
export function mensagemDoErro(codigo: string | undefined, fallback: string): string {
  switch (codigo) {
    case 'FD001': return 'Sua sessão expirou — entre de novo e registre o desfecho.';
    case 'FD002': return 'Desfecho inválido — avise a equipe, isto é um bug.';
    case 'FD003': return 'Recusa exige motivo — escolha o porquê.';
    // ⚠️ NUNCA sugerir "tente de novo" aqui, e nunca fazer retry automático
    // (achado do /codex): depois de um recompute, a mesma chave aponta para uma
    // recomendação NOVA, e repetir o clique carimbaria o desfecho num cálculo que
    // ela nunca viu — o dado ficaria colado ao modelo errado.
    case 'FD004': return 'Esta oferta não está mais ativa (as recomendações foram recalculadas). Recarregue a lista.';
    case 'FD006': return 'Há ofertas duplicadas para este cliente e produto — nada foi registrado, para não marcar a errada. Avise a equipe.';
    case 'FD007': return 'Esta oferta já tem desfecho registrado — o histórico não se reescreve.';
    default:      return fallback;
  }
}

export function useFarmerDesfecho() {
  // Lente "Ver como": registrar desfecho é ESCRITA de identidade. O banco já recusa
  // (a RPC busca por auth.uid(), que continua sendo o master real), mas barrar aqui
  // evita o toast de erro num clique que nunca deveria ter sido oferecido.
  const { isImpersonating } = useImpersonation();
  /** Desfechos registrados NESTA sessão, por chave — o card reflete sem refetch. */
  const [registrados, setRegistrados] = useState<Record<string, Desfecho>>({});
  /** Chave em gravação. Trava o card inteiro: dois cliques = dois UPDATEs. */
  const [registrando, setRegistrando] = useState<string | null>(null);

  const registrar = useCallback(
    async (alvo: AlvoDesfecho, desfecho: Desfecho, motivo?: MotivoRecusa): Promise<boolean> => {
      const chave = chaveDoAlvo(alvo);
      if (isImpersonating || registrando) return false;
      setRegistrando(chave);
      // [SENSOR] Emitido depois do guard e ANTES do await, como no BotoesDesfecho do
      // plano tático: toque barrado não é tentativa, e o caso que mais interessa
      // medir é "clicou e a gravação morreu" — no sucesso o dado já existe no banco.
      track('recomendacao.desfecho_clicado', {
        desfecho,
        motivo: motivo ?? null,
        tipo: alvo.type,
      });
      try {
        const { error } = await supabase.rpc(
          'farmer_recomendacao_registrar_desfecho' as never,
          {
            p_customer_user_id: alvo.customerId,
            p_product_id: alvo.productId,
            p_recommendation_type: alvo.type,
            p_desfecho: desfecho,
            // `null` explícito, não `undefined`: a RPC recusa motivo em aceite, e
            // omitir a chave deixaria o default do Postgres decidir por nós.
            p_motivo: desfecho === 'rejeitado' ? (motivo ?? null) : null,
          } as never,
        );
        // O supabase-js NÃO lança em erro de banco — resolve com `error` preenchido.
        // Um `await` solto devolveria "sucesso" sem ter gravado nada, e o card
        // mostraria um desfecho que não existe no banco. Este é o bug que o §CLAUDE
        // chama de validação sem evidência positiva.
        if (error) {
          const codigo = (error as { code?: string } | null)?.code;
          toast.error(mensagemDoErro(codigo, `Não consegui registrar o desfecho: ${error.message}`));
          return false;
        }
        setRegistrados((atual) => ({ ...atual, [chave]: desfecho }));
        toast.success(desfecho === 'aceito' ? 'Venda registrada' : 'Recusa registrada');
        return true;
      } catch (err) {
        // Falha de transporte (rede/CORS): distinta do erro de banco acima.
        console.error('[useFarmerDesfecho] falha ao registrar', err);
        toast.error('Não consegui falar com o servidor — o desfecho NÃO foi registrado.');
        return false;
      } finally {
        // `finally`, não o fim do try: sem ele uma falha de rede travaria o card em
        // "salvando" para sempre, e o desfecho se perderia justamente no caso em
        // que ela tentou.
        setRegistrando(null);
      }
    },
    [isImpersonating, registrando],
  );

  return { registrar, registrados, registrando, bloqueadoPelaLente: isImpersonating };
}
