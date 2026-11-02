import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { Tables } from '@/integrations/supabase/types';
import { mensagemDeErro } from '@/lib/erro-mensagem';
import { DEFAULT_CONFIG, type AlgorithmConfig } from '@/lib/scoring/configAlgoritmo';

type AlgorithmConfigRow = Pick<Tables<'farmer_algorithm_config'>, 'key' | 'value'>;

export const FARMER_ALGORITHM_CONFIG_KEY = ['farmer-algorithm-config'] as const;

/**
 * Só a config do algoritmo Farmer — para quem precisa dos pesos SEM o motor.
 *
 * POR QUE EXISTE (plano v4, lote 5 — N1): a Governança lia a config via `useFarmerScoring()`,
 * que monta o motor inteiro e baixa todo o histórico de `sales_orders` (~32k linhas em ~33
 * páginas sequenciais) para calcular uma carteira que a tela não mostra.
 *
 * O merge com `DEFAULT_CONFIG` é o MESMO do motor (chave ausente no banco = default que o motor
 * usa), então "valor atual" aqui é o que o cálculo realmente aplica. Já a LEITURA que falha não
 * vira default: `config` fica `null` e `erro` diz por quê — a proposta de governança grava
 * `current_params` a partir daqui, e gravar o default como se fosse o valor vigente é fabricar.
 */
export function useFarmerAlgorithmConfig() {
  const { data, isLoading, error } = useQuery({
    queryKey: FARMER_ALGORITHM_CONFIG_KEY,
    // Offline, o default 'online' PAUSA a consulta sem rejeitar: o motor de scoring (que espera a
    // config) ficaria no skeleton para sempre, sem erro. Assim a leitura tenta e a falha aparece.
    networkMode: 'always',
    queryFn: async (): Promise<AlgorithmConfig> => {
      const { data: rows, error: erroLeitura } = await supabase
        .from('farmer_algorithm_config')
        .select('key, value');
      if (erroLeitura) {
        throw new Error(`farmer_algorithm_config: ${mensagemDeErro(erroLeitura) ?? 'erro sem mensagem'}`);
      }
      if (!rows) throw new Error('farmer_algorithm_config: data null sem error — malformada');
      const map: Record<string, number> = {};
      (rows as AlgorithmConfigRow[]).forEach((r) => { map[r.key] = Number(r.value); });
      return { ...DEFAULT_CONFIG, ...map } as AlgorithmConfig;
    },
  });

  return {
    config: data ?? null,
    loading: isLoading,
    erro: error ? mensagemDeErro(error) : null,
  };
}
