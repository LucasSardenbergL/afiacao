export interface DisparoCandidate {
  customerUserId: string;
  valorDaLigacao: number;
  optInStatus: string; // 'opt_in' | 'unknown' | 'opt_out'
}
export interface DisparoConfig {
  metaTierCap: number;   // teto de destinatários únicos/24h (ramp da Meta)
  disparoInicio: string; // 'HH:MM' — só inicia disparo a partir daqui
  disparoCorte: string;  // 'HH:MM' — para de iniciar disparo após isso (folga p/ faturar)
  jaEnviadosHoje: number;// quantos já saíram hoje (consome do route_contact_log)
}
export interface DisparoResult {
  enviarAgora: DisparoCandidate[];
  motivoPausa: 'fora_da_janela' | 'cap_atingido' | null;
}

/**
 * Seleciona o lote de disparo proativo agora. PURO/determinístico (hora injetada).
 * - Fora de [disparoInicio, disparoCorte] (inclusivo) → pausa. Comparação lexicográfica de 'HH:MM' zero-padded.
 * - Exclui opt_out; opt_in e unknown (primeiro toque) são elegíveis.
 * - Respeita o teto do tier descontando o já enviado hoje. Preserva a ordem da fila (pré-ordenada por valor).
 */
export function selectDisparoBatch(queue: DisparoCandidate[], cfg: DisparoConfig, nowHHMM: string): DisparoResult {
  if (nowHHMM < cfg.disparoInicio || nowHHMM > cfg.disparoCorte) {
    return { enviarAgora: [], motivoPausa: 'fora_da_janela' };
  }
  const eligible = queue.filter(c => c.optInStatus !== 'opt_out');
  const remaining = Math.max(0, cfg.metaTierCap - cfg.jaEnviadosHoje);
  const enviarAgora = eligible.slice(0, remaining);
  const motivoPausa = eligible.length > remaining ? 'cap_atingido' : null;
  return { enviarAgora, motivoPausa };
}
