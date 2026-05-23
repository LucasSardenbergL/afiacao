// src/lib/call-log/record.ts
import { supabase } from '@/integrations/supabase/client';
import { buildCallLogInsert, type BuildInsertArgs } from './build-insert';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tbl = () => supabase.from('call_log') as any;

/** Cria a linha inicial (ringing). Idempotente por sip_call_id (ON CONFLICT DO NOTHING). */
export async function logCallStart(args: BuildInsertArgs): Promise<void> {
  try {
    const row = buildCallLogInsert(args);
    await tbl().upsert(row, { onConflict: 'provider,sip_call_id', ignoreDuplicates: true });
  } catch (e) {
    console.error('[call-log] logCallStart', e);
  }
}

/** Marca answered (condicional: só se ainda ringing — em multi-aba só quem atende ganha). */
export async function logAnswered(sipCallId: string): Promise<void> {
  try {
    await tbl().update({ status: 'answered', answered_at: new Date().toISOString() })
      .eq('sip_call_id', sipCallId).eq('status', 'ringing');
  } catch (e) { console.error('[call-log] logAnswered', e); }
}

/** Fecha a chamada: ended (atendida) ou missed/rejected (não). */
export async function logClosed(sipCallId: string, opts: { answered: boolean; rejected?: boolean; durationSeconds: number }): Promise<void> {
  try {
    const status = opts.answered ? 'ended' : opts.rejected ? 'rejected' : 'missed';
    await tbl().update({
      status,
      ended_at: new Date().toISOString(),
      duration_seconds: opts.durationSeconds,
    }).eq('sip_call_id', sipCallId).neq('status', 'ended');
  } catch (e) { console.error('[call-log] logClosed', e); }
}

/** Marca perdidas como lidas (zera badge). */
export async function acknowledgeMissed(farmerId: string): Promise<void> {
  try {
    await tbl().update({ acknowledged_at: new Date().toISOString() })
      .eq('farmer_id', farmerId).eq('direction', 'inbound').eq('status', 'missed').is('acknowledged_at', null);
  } catch (e) { console.error('[call-log] acknowledgeMissed', e); }
}
