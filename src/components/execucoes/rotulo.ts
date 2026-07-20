import { formatDistance } from "date-fns";
import { ptBR } from "date-fns/locale";
import type { AcaoExecucao } from "./tipos";

/** Execução 'executando' além disso é tratada como abandonada (aba fechada no meio). */
const LIMITE_ANDAMENTO_MS = 2 * 60 * 60 * 1000;

export interface RotuloExecucao {
  texto: string;
  tom: "muted" | "andamento" | "erro";
}

/** Rótulo humano da última execução de uma ação global (puro — testável sem render). */
export function rotuloUltimaExecucao(execucao: AcaoExecucao | null, agora: Date): RotuloExecucao {
  if (!execucao) return { texto: "Nunca executada", tom: "muted" };

  const relativo = (iso: string) => formatDistance(new Date(iso), agora, { addSuffix: true, locale: ptBR });

  if (execucao.status === "executando") {
    const decorrido = agora.getTime() - new Date(execucao.iniciado_em).getTime();
    if (decorrido < LIMITE_ANDAMENTO_MS) {
      return { texto: `Em andamento (${relativo(execucao.iniciado_em)})`, tom: "andamento" };
    }
    return { texto: `Iniciada ${relativo(execucao.iniciado_em)} (interrompida?)`, tom: "muted" };
  }

  const quando = relativo(execucao.finalizado_em ?? execucao.iniciado_em);
  // Só o primeiro nome — caption compacta (nome completo continua no banco).
  const primeiroNome = execucao.executado_por_nome?.trim().split(/\s+/)[0] ?? null;
  const quem = execucao.origem === "automatica" ? "automática" : primeiroNome;
  const marca = execucao.status === "sucesso" ? "✓" : "falhou";
  const partes = [quando, ...(quem ? [quem] : []), marca];
  return {
    texto: `Última execução: ${partes.join(" · ")}`,
    tom: execucao.status === "erro" ? "erro" : "muted",
  };
}
