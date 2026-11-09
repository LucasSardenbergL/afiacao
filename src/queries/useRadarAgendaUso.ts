import { supabase } from '@/integrations/supabase/client';
import { track } from '@/lib/analytics';
import { isLensActive } from '@/lib/impersonation/lens-write-guard';
import { classificarErro, classificarResposta, motivoSeguro, type ResultadoSensor } from '@/lib/radar/sensor-empurrado';

export type UsoAgenda =
  | { evento: 'vista'; nRetornos: number; nPosses: number }
  | { evento: 'aberta'; cnpj: string };

/**
 * Sensor da agenda "Hoje" do /radar no LEDGER (`radar_agenda_uso`, migration 20261111134000) — regra de fase: a
 * superfície nasce com o sensor, e o PostHog é cego para o founder. 'vista' = o bloco apareceu com itens (1 por dia,
 * com o denominador); 'aberta' = um item foi aberto (1 por CNPJ por dia). Idempotente no servidor.
 * Contrato dos sensores do Radar: NUNCA rejeita (telemetria não quebra a tela). Na lente "Ver como" não grava. A falha
 * fica no track + console: o ledger de falhas do funil (`radar_sensor_falhas`) só aceita os sensores do funil H.
 */
export async function registrarUsoAgenda(v: UsoAgenda): Promise<ResultadoSensor> {
  if (isLensActive()) return { ok: false, motivo: 'lente', transitorio: false };
  let r: ResultadoSensor;
  try {
    const { data, error } = await supabase.rpc('radar_registrar_agenda_uso',
      v.evento === 'vista'
        ? { p_evento: 'vista', p_n_retornos: v.nRetornos, p_n_posses: v.nPosses }
        : { p_evento: 'aberta', p_cnpj: v.cnpj });
    r = classificarResposta(data, error);
  } catch (e) {
    r = classificarErro(e);
  }
  if (!r.ok) {
    const motivo = motivoSeguro(r.motivo);
    track('radar.sensor_falhou', { sensor: `agenda_${v.evento}`, motivo, tentativas: 1 });
    console.warn(`[radar] sensor agenda_${v.evento} não gravou (${motivo})`);
  }
  return r;
}
