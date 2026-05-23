// src/lib/call-log/record.ts
import { supabase } from '@/integrations/supabase/client';
import { buildCallLogInsert, type BuildInsertArgs } from './build-insert';
import type { ResolvedCallParty } from './recording-policy';

// call_log ainda não está nos tipos gerados do Supabase (migration aplicada
// manualmente no Lovable). Casteia o client ANTES do .from() pra o nome da
// tabela não bater na union de tabelas tipada (senão TS2769 no typecheck:strict).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tbl = () => (supabase as any).from('call_log');

/** Cria a linha inicial (ringing). Idempotente por sip_call_id (ON CONFLICT DO NOTHING). */
export async function logCallStart(args: BuildInsertArgs): Promise<void> {
  try {
    const row = buildCallLogInsert(args);
    await tbl().upsert(row, { onConflict: 'provider,sip_call_id', ignoreDuplicates: true });
  } catch (e) {
    console.error('[call-log] logCallStart', e);
  }
}

/** Enriquece a linha inbound com BINA depois do insert inicial (sip_call_id já existe). */
export async function enrichCallLog(sipCallId: string, party: ResolvedCallParty, recorded: boolean): Promise<void> {
  try {
    await tbl().update({
      customer_user_id: party.customerUserId,
      match_confidence: party.matchConfidence,
      display_name: party.contactName ?? null,
      recorded,
    }).eq('sip_call_id', sipCallId).in('status', ['ringing', 'answered']);
  } catch (e) { console.error('[call-log] enrichCallLog', e); }
}

/** Marca answered (condicional: só se ainda ringing — em multi-aba só quem atende ganha). */
export async function logAnswered(sipCallId: string): Promise<void> {
  try {
    await tbl().update({ status: 'answered', answered_at: new Date().toISOString() })
      .eq('sip_call_id', sipCallId).eq('status', 'ringing');
  } catch (e) { console.error('[call-log] logAnswered', e); }
}

/** Marca a linha como gravada (inbound atendido sempre grava — toca a Sara). */
export async function markRecorded(sipCallId: string): Promise<void> {
  try {
    await tbl().update({ recorded: true }).eq('sip_call_id', sipCallId);
  } catch (e) { console.error('[call-log] markRecorded', e); }
}

/** Fecha a chamada: ended (atendida) ou missed/rejected (não). */
export async function logClosed(sipCallId: string, opts: { answered: boolean; rejected?: boolean; durationSeconds: number }): Promise<void> {
  try {
    const status = opts.answered ? 'ended' : opts.rejected ? 'rejected' : 'missed';
    // Só fecha linhas NÃO-terminais. Preserva rejected/missed/failed/busy/canceled/ended
    // (ex: um inbound já 'rejected' não pode virar 'missed' quando incomingClosed dispara depois).
    await tbl().update({
      status,
      ended_at: new Date().toISOString(),
      duration_seconds: opts.durationSeconds,
    }).eq('sip_call_id', sipCallId).in('status', ['ringing', 'answered']);
  } catch (e) { console.error('[call-log] logClosed', e); }
}

/** Marca perdidas como lidas (zera badge). */
export async function acknowledgeMissed(farmerId: string): Promise<void> {
  try {
    await tbl().update({ acknowledged_at: new Date().toISOString() })
      .eq('farmer_id', farmerId).eq('direction', 'inbound').eq('status', 'missed').is('acknowledged_at', null);
  } catch (e) { console.error('[call-log] acknowledgeMissed', e); }
}
