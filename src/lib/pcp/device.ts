// Identidade do device para o apontamento event-sourced (F1B-M1, disposição C4 do painel).
// device_id estável + device_seq monotônico por device desempatam o client_ts (que é
// adulterável no chão de fábrica) na ordenação da FSM da projeção. Persistidos em localStorage:
// sobrevivem a reload; o seq nunca reinicia enquanto o device for o mesmo.

const DEVICE_ID_KEY = 'pcp_device_id';
const DEVICE_SEQ_KEY = 'pcp_device_seq';

/** Identificador estável deste device/navegador (gerado uma vez, persistido). */
export function getDeviceId(): string {
  if (typeof localStorage === 'undefined') return 'ssr';
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `dev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

/**
 * Próximo device_seq monotônico (persistido). Reservado NO MOMENTO DO TOQUE — mesmo que o
 * evento caia na fila offline, o seq já reflete a ordem local em que o operador agiu.
 */
export function nextDeviceSeq(): number {
  if (typeof localStorage === 'undefined') return Date.now();
  const cur = parseInt(localStorage.getItem(DEVICE_SEQ_KEY) ?? '0', 10) || 0;
  const next = cur + 1;
  localStorage.setItem(DEVICE_SEQ_KEY, String(next));
  return next;
}
