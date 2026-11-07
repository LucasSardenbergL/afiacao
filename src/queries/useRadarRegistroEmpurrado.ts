import { supabase } from '@/integrations/supabase/client';
import { track } from '@/lib/analytics';
import { isLensActive } from '@/lib/impersonation/lens-write-guard';
import {
  classificarErro,
  classificarResposta,
  motivoSeguro,
  type ResultadoSensor,
  type SensorEmpurrado,
} from '@/lib/radar/sensor-empurrado';

export type { ResultadoSensor, SensorEmpurrado } from '@/lib/radar/sensor-empurrado';

// Escritas dos sensores do Radar D1/D2 (migration 20261106181000) e do 2º momento da abertura (H, 20261107230000),
// separadas da leitura do card: quem decide se grava é o chamador (fora da lente) e o write-guard (na lente, rejeita).
// Nenhuma delas usa a identidade da lente.
//
// CONTRATO (pacote H): toda função devolve Promise<ResultadoSensor> e NUNCA rejeita — telemetria não quebra a tela.
//   • `ok: true`  → o servidor aceitou (`registrado: false` = já estava gravado: idempotente, não é falha).
//   • `ok: false` → não gravou. Falha TRANSITÓRIA (rede, banco indisponível) é tentada de novo (3 tentativas, 0,4 s e
//     1,2 s); a que sobra é registrada: track('radar.sensor_falhou') + console.warn + ledger radar_sensor_falhas
//     (o painel do funil lê o ledger: o PostHog é cego para o founder). Lente = `motivo: 'lente'`, sem registro.
// Quem só disparava (`void registrarX(...)` ou a chamada solta) continua compilando e se comportando igual.

const ESPERAS_MS = [400, 1200] as const;
const esperar = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Chamada = () => PromiseLike<{ data: unknown; error: unknown }>;

async function comTentativas(sensor: SensorEmpurrado, chamar: Chamada): Promise<ResultadoSensor> {
  if (isLensActive()) return { ok: false, motivo: 'lente', transitorio: false };
  let r: ResultadoSensor = { ok: false, motivo: 'desconhecido', transitorio: false };
  let tentativas = 0;
  for (;;) {
    tentativas++;
    try {
      const { data, error } = await chamar();
      r = classificarResposta(data, error);
    } catch (e) {
      r = classificarErro(e);
    }
    if (r.ok || !r.transitorio || tentativas > ESPERAS_MS.length) break;
    await esperar(ESPERAS_MS[tentativas - 1]);
  }
  if (!r.ok && r.motivo !== 'lente') reportarFalhaSensor(sensor, r.motivo, tentativas);
  return r;
}

/**
 * Falha de sensor que o cliente VÊ (inclusive as que não passam por RPC, como "a ficha não carregou"). Melhor
 * esforço: se a rede caiu, este registro cai junto — sobra o track() e o console.
 */
export function reportarFalhaSensor(sensor: SensorEmpurrado, motivo: string, tentativas = 1): void {
  const m = motivoSeguro(motivo);
  track('radar.sensor_falhou', { sensor, motivo: m, tentativas });
  console.warn(`[radar] sensor ${sensor} não gravou (${m}, ${tentativas} tentativa(s))`);
  if (isLensActive()) return;
  void Promise.resolve(supabase.rpc('radar_registrar_falha_sensor', { p_sensor: sensor, p_motivo: m })).catch(
    () => undefined,
  );
}

/** Sensor do D2 no LEDGER: o card mostrou leads ao próprio vendedor (1 por dia; o resto é idempotente). */
export function registrarCardServido(nLeads: number): Promise<ResultadoSensor> {
  return comTentativas('card_servido', () => supabase.rpc('radar_registrar_card_servido', { p_n_leads: nLeads }));
}

type LeadEmpurrado = { origem: 'card'; cnpj: string } | { origem: 'email'; cnpj: string; envio: string };

function argsDoLead(v: LeadEmpurrado) {
  return { p_origem: v.origem, p_cnpj: v.cnpj, ...(v.origem === 'email' ? { p_envio: v.envio } : {}) };
}

/** 1º momento: o vendedor CLICOU no lead empurrado (link do e-mail ou card). */
export function registrarAberturaEmpurrada(v: LeadEmpurrado): Promise<ResultadoSensor> {
  return comTentativas(v.origem === 'email' ? 'abertura_email' : 'abertura_card', () =>
    supabase.rpc('radar_registrar_abertura_empurrada', argsDoLead(v)),
  );
}

/**
 * 2º momento: a ficha do lead CHEGOU ao navegador. O painel conta "ficha entregue" só com isto; clique sem ficha
 * fica visível como clique sem ficha. Se o clique não foi gravado, o servidor cria a linha marcando o clique perdido.
 */
export function registrarFichaEntregue(v: LeadEmpurrado): Promise<ResultadoSensor> {
  return comTentativas(v.origem === 'email' ? 'ficha_email' : 'ficha_card', () =>
    supabase.rpc('radar_registrar_ficha_entregue', argsDoLead(v)),
  );
}
