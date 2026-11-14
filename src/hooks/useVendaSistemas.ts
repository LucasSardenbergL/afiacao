import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import {
  lerFilaSistemas, lerSensorSistemas, type DecisaoPar, type EmpresaSistema, type FilaSistemas, type SensorSistemas,
} from '@/lib/venda-cliente/sistemas';

/**
 * Fila de pares tinta/verniz → catalisador/diluente (`venda_sistema_fila`, só master). `useAuth()` = usuário REAL: é a
 * decisão do founder, não lê pela lente "Ver como". A leitura REGISTRA os candidatos mostrados (denominador do sensor),
 * por isso sem refetch automático além do staleTime — reler não duplica (ON CONFLICT), mas não há por que martelar.
 */
export function useVendaSistemaFila(empresa: EmpresaSistema) {
  const { user, isMaster } = useAuth();
  return useQuery({
    queryKey: ['venda-sistema-fila', user?.id ?? 'anon', empresa],
    enabled: isMaster,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<FilaSistemas> => {
      const { data, error } = await supabase.rpc('venda_sistema_fila', { p_empresa: empresa });
      if (error) throw error;
      return lerFilaSistemas(data);
    },
  });
}

export function useVendaSistemaSensor(de: string, ate: string) {
  const { user, isMaster } = useAuth();
  return useQuery({
    queryKey: ['venda-sistema-sensor', user?.id ?? 'anon', de, ate],
    enabled: isMaster,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<SensorSistemas> => {
      const { data, error } = await supabase.rpc('venda_sistema_sensor', { p_de: de, p_ate: ate });
      if (error) throw error;
      return lerSensorSistemas(data);
    },
  });
}

/** A decisão é sobre UM par (o estado vive no próprio registro): `useMutation` direto, sem registro de execução. */
export function useDecidirPar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ parId, status }: { parId: number; status: DecisaoPar }) => {
      const { error } = await supabase.rpc('venda_sistema_decidir', { p_par_id: parId, p_status: status });
      if (error) throw error;
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['venda-sistema-fila'] });
      void qc.invalidateQueries({ queryKey: ['venda-sistema-sensor'] });
    },
  });
}
