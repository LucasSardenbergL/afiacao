// Radar H — classificação das respostas dos sensores do lead empurrado (e-mail semanal e card "Prospectar hoje").
// Puro: o hook (src/queries/useRadarRegistroEmpurrado.ts) faz a chamada, as tentativas e o registro da falha.

/** Os sensores do front, com o MESMO vocabulário de radar_sensor_falhas.sensor (migration 20261107230000). */
export type SensorEmpurrado = 'card_servido' | 'abertura_card' | 'abertura_email' | 'ficha_card' | 'ficha_email';

/**
 * Contrato das escritas de sensor: NUNCA rejeita. `ok: true` = o servidor aceitou (`registrado: false` = já estava
 * gravado, idempotente). `ok: false` = não gravou; `transitorio` = vale tentar de novo (rede, banco indisponível).
 */
export type ResultadoSensor =
  | { ok: true; registrado: boolean }
  | { ok: false; motivo: string; transitorio: boolean };

/** Motivo no formato do ledger (`^[a-z0-9_]{1,40}$`): o servidor saneia de novo, mas o track() já sai limpo. */
export function motivoSeguro(v: unknown): string {
  const s = String(v ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
    .replace(/_+$/g, '');
  return s || 'desconhecido';
}

interface ErroLike {
  name?: unknown;
  code?: unknown;
  message?: unknown;
}

/** Erro (do supabase-js, do write-guard da lente ou lançado) → resultado. */
export function classificarErro(e: unknown): ResultadoSensor {
  const err = (e && typeof e === 'object' ? e : {}) as ErroLike;
  if (err.name === 'LensReadOnlyError') return { ok: false, motivo: 'lente', transitorio: false };
  const code = typeof err.code === 'string' ? err.code : '';
  if (code === '42501') return { ok: false, motivo: 'sem_acesso', transitorio: false };
  if (code === '22023') return { ok: false, motivo: 'parametro_invalido', transitorio: false };
  // Função ausente no schema cache: migration não aplicada (ou nome errado). Não adianta tentar de novo.
  if (code === 'PGRST202') return { ok: false, motivo: 'rpc_ausente', transitorio: false };
  // 57014 = statement_timeout; classes 08 (conexão), 53 (recurso) e 57 (operador): o banco pode voltar.
  if (/^(08|53|57)/.test(code)) return { ok: false, motivo: `banco_${code.toLowerCase()}`, transitorio: true };
  if (code) return { ok: false, motivo: motivoSeguro(`erro_${code}`), transitorio: false };
  // Sem código = não chegou resposta do PostgREST (fetch falhou, offline, CORS, aba fechando).
  return { ok: false, motivo: 'rede', transitorio: true };
}

/** Resposta `{ data, error }` de uma RPC de sensor → resultado. Resposta fora da forma NÃO vira sucesso. */
export function classificarResposta(data: unknown, error: unknown): ResultadoSensor {
  if (error) return classificarErro(error);
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const d = data as Record<string, unknown>;
    if (d.ok === true) return { ok: true, registrado: d.registrado === true };
    if (d.ok === false) return { ok: false, motivo: motivoSeguro(d.motivo), transitorio: false };
  }
  return { ok: false, motivo: 'resposta_fora_da_forma', transitorio: false };
}
