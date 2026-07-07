/**
 * Closed-loop da lista de ligação (PR2c) — derivação PURA dos sinais de contato.
 *
 * Lê os registros de `route_contact_log` de UM cliente (agrega TODOS os farmers que
 * o contataram — os sinais de fila são por CLIENTE, não por quem ligou) e deriva os
 * 3 campos que o motor `buildContactList`/`gate()` (inalterado) já consome:
 *   contatadoHaDiasParaGate → ContactCandidate.contatadoHaDias
 *   jaConvertidoNaRota      → ContactCandidate.fechouHoje
 *   optOut                  → ContactCandidate.optOut
 * + campos só de UI/badge. Toda a sutileza de status vive aqui, testada isolada.
 *
 * Regras (spec §4.3, revisado por Codex):
 *  - opt_out: sticky, SEM janela (full history) — senão um opt-out antigo voltaria a ligar.
 *  - jaConvertidoNaRota: por `data_rota` gravada (NÃO created_at) — a fila é D-1.
 *  - cadência separa "tentativa registrada" de "evento que bloqueia o gate":
 *      respondido/convertido → bloqueiam (cadência normal);
 *      sem_resposta → só bloqueia quando atinge `limiarSemResposta` DIAS distintos na janela;
 *      abaixo do limiar é só badge (cadência curta, deixa re-tentar).
 */

export type OutcomeStatus = 'convertido' | 'respondido' | 'sem_resposta' | 'opt_out';

export interface ContatoLog {
  status: OutcomeStatus;
  dataNegocio: string; // 'yyyy-mm-dd' — created_at convertido pra SP (fuso de negócio)
  dataRota: string;    // 'yyyy-mm-dd' — a coluna data_rota gravada
}

export interface CadenciaCfg { limiarSemResposta: number; janelaCadenciaDias: number; }
const CADENCIA_DEFAULT: CadenciaCfg = { limiarSemResposta: 3, janelaCadenciaDias: 7 };

export interface SinaisContato {
  optOut: boolean;
  jaConvertidoNaRota: boolean;
  contatadoHaDiasParaGate: number | null; // ÚNICO que vira ContactCandidate.contatadoHaDias
  ultimoContatoRealHaDias: number | null;
  semRespostaRecenteN: number;
  ultimaSemRespostaHaDias: number | null;
  cadenciaBloqueadaPor: 'real' | 'sem_resposta_esgotada' | null;
}

/** Dias de calendário entre duas datas iso 'yyyy-mm-dd' (a − b). Parse UTC → imune a fuso/DST. */
export function diasEntreIso(a: string, b: string): number {
  const p = (s: string) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((p(a) - p(b)) / 86_400_000);
}

export function derivarSinaisContato(
  registros: ContatoLog[], hoje: string, dataRotaFila: string, cfg: CadenciaCfg = CADENCIA_DEFAULT,
): SinaisContato {
  const optOut = registros.some(r => r.status === 'opt_out'); // sticky, sem janela
  const jaConvertidoNaRota = registros.some(r => r.status === 'convertido' && r.dataRota === dataRotaFila);

  // contato REAL (respondido/convertido) — "há X dias" do mais recente (menor X); ignora futuros (X<0)
  const reaisDias = registros
    .filter(r => r.status === 'respondido' || r.status === 'convertido')
    .map(r => diasEntreIso(hoje, r.dataNegocio))
    .filter(d => d >= 0);
  const ultimoContatoRealHaDias = reaisDias.length ? Math.min(...reaisDias) : null;

  // sem_resposta na janela — conta DIAS distintos, não linhas; ignora futuros
  const semRespNaJanela = registros.filter(r => {
    if (r.status !== 'sem_resposta') return false;
    const d = diasEntreIso(hoje, r.dataNegocio);
    return d >= 0 && d <= cfg.janelaCadenciaDias;
  });
  const semRespostaRecenteN = new Set(semRespNaJanela.map(r => r.dataNegocio)).size;
  const semRespDias = semRespNaJanela.map(r => diasEntreIso(hoje, r.dataNegocio));
  const ultimaSemRespostaHaDias = semRespDias.length ? Math.min(...semRespDias) : null;

  // bloqueio: real sempre bloqueia; sem_resposta só quando esgotado (≥ limiar de DIAS distintos)
  const diasReal = ultimoContatoRealHaDias;
  const diasSemRespEsgotada = semRespostaRecenteN >= cfg.limiarSemResposta ? ultimaSemRespostaHaDias : null;
  const candidatos = [diasReal, diasSemRespEsgotada].filter((d): d is number => d != null);
  const contatadoHaDiasParaGate = candidatos.length ? Math.min(...candidatos) : null;
  let cadenciaBloqueadaPor: SinaisContato['cadenciaBloqueadaPor'] = null;
  if (contatadoHaDiasParaGate != null) {
    cadenciaBloqueadaPor = diasReal != null && diasReal === contatadoHaDiasParaGate ? 'real' : 'sem_resposta_esgotada';
  }

  return {
    optOut, jaConvertidoNaRota, contatadoHaDiasParaGate,
    ultimoContatoRealHaDias, semRespostaRecenteN, ultimaSemRespostaHaDias, cadenciaBloqueadaPor,
  };
}
