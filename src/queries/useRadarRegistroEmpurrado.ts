import { supabase } from '@/integrations/supabase/client';

// Escritas do sensor do Radar D1/D2 (migration 20261106181000), separadas da leitura do card: quem decide se grava é
// o chamador (fora da lente) e o write-guard (na lente, rejeita). Nenhuma delas usa a identidade da lente.

/**
 * Sensor do D2/D1 no LEDGER (não só PostHog): grava que o card mostrou leads ou que um lead empurrado foi aberto.
 * Fire-and-forget: telemetria nunca quebra a tela. Na lente o write-guard rejeita (inspeção não conta) — engolido.
 */
export function registrarCardServido(nLeads: number): void {
  void Promise.resolve(supabase.rpc('radar_registrar_card_servido', { p_n_leads: nLeads })).catch(() => undefined);
}

export function registrarAberturaEmpurrada(
  v: { origem: 'card'; cnpj: string } | { origem: 'email'; cnpj: string; envio: string },
): Promise<unknown> {
  return Promise.resolve(
    supabase.rpc('radar_registrar_abertura_empurrada', {
      p_origem: v.origem,
      p_cnpj: v.cnpj,
      ...(v.origem === 'email' ? { p_envio: v.envio } : {}),
    }),
  ).catch(() => undefined);
}
