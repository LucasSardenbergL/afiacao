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

// Escritas dos sensores do Radar D1/D2 (migration 20261106181000) e do 2º momento da abertura (H, 20261107233000),
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

async function comTentativas(
  sensor: SensorEmpurrado,
  chamar: Chamada,
  naoReportar: (r: ResultadoSensor) => boolean = () => false,
): Promise<ResultadoSensor> {
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
  if (!r.ok && r.motivo !== 'lente' && !naoReportar(r)) reportarFalhaSensor(sensor, r.motivo, tentativas);
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

/**
 * Sensor do denominador do card (pacote M, migration 20261111134500): CADA CNPJ exibido, inclusive a reposição que
 * entra depois de um Assumir (1 por vendedor, dia e CNPJ; o resto é idempotente). Banco anterior ao pacote M (RPC
 * ausente) cai no sensor antigo do dia, sem registrar falha: é ordem de deploy, não perda.
 */
export async function registrarCardExibido(cnpjs: readonly string[]): Promise<ResultadoSensor> {
  const r = await comTentativas(
    'card_servido',
    () => supabase.rpc('radar_registrar_card_exibido', { p_cnpjs: [...cnpjs].slice(0, 20) }),
    (x) => !x.ok && x.motivo === 'rpc_ausente',
  );
  if (!r.ok && r.motivo === 'rpc_ausente') return registrarCardServido(Math.min(5, Math.max(1, cnpjs.length)));
  return r;
}

// 'email' (revisão 2026-11-11, item 18; migration 20261113110100): o mailto da ficha também é intenção.
export type CanalIntencao = 'ligar' | 'whatsapp' | 'copiar' | 'email';

/**
 * Intenção de contato na ficha (pacote M): tocar em Ligar (celular), WhatsApp ou Copiar telefone. Vai ao ledger do
 * Radar (radar_eventos 'intencao', 1 por vendedor, CNPJ, canal e dia), fora do PostHog censurado. Uma tentativa,
 * nunca rejeita, nunca bloqueia o clique; sob a lente não grava. Falha fica no track() e no console (o ledger de
 * falhas de sensor é do lead empurrado e não tem este sensor).
 */
export async function registrarIntencaoContato(cnpj: string, canal: CanalIntencao): Promise<ResultadoSensor> {
  if (isLensActive()) return { ok: false, motivo: 'lente', transitorio: false };
  let r: ResultadoSensor;
  try {
    const { data, error } = await supabase.rpc('radar_registrar_intencao', { p_cnpj: cnpj, p_canal: canal });
    r = classificarResposta(data, error);
  } catch (e) {
    r = classificarErro(e);
  }
  if (!r.ok && r.motivo !== 'lente') {
    track('radar.sensor_falhou', { sensor: 'intencao', motivo: r.motivo, tentativas: 1 });
    console.warn(`[radar] intenção de contato não gravou (${r.motivo})`);
  }
  return r;
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
