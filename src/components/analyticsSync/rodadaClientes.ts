// Estado do import de clientes NO SERVIDOR (tabela clientes_import_rodada, migration
// 20261101200000) como a tela o mostra. Regra pura: a tela só lê; quem escreve é a edge (cron) e as RPCs.
//
// O registro do clique (acoes_execucoes via useMutationComRegistro) passa a significar "rodada
// solicitada" — o andamento e o desfecho vêm SÓ daqui (achado Codex P2: 1 escritor por slug).

export interface RodadaClientesRow {
  id: string;
  origem: "manual" | "cron_semanal";
  criado_em: string;
  conta_slug: string | null;
  start_page: number;
  total_paginas: number;
  concluida_em: string | null;
  falhou_em: string | null;
  motivo_falha: "erro_persistente" | "sem_progresso" | null;
  ultimo_erro: string | null;
  running_since: string | null;
  heartbeat_at: string | null;
  importados: number;
  pulados: number;
  erros: number;
  telefones_repostos: number;
  falhas: unknown[];
  contas_sem_credencial: unknown[];
  invocacoes: number;
}

export type EstadoRodada = "executando" | "aguardando" | "atrasada" | "falhou" | "parcial" | "concluida";

export interface StatusRodada {
  id: string;
  estado: EstadoRodada;
  /** Linha curta para o card. */
  descricao: string;
  podeRearmar: boolean;
}

const NOME_CONTA: Record<string, string> = { colacor_sc: "Colacor SC", oben: "Oben", colacor: "Colacor" };
const ORDEM_CONTAS = ["colacor_sc", "oben", "colacor"];
/** Lease da edge é 7 min; o cron chama a cada 1 min. Sem sinal por mais que isso = o servidor não está rodando. */
const ATRASO_MS = 10 * 60_000;

export const haRodadaAberta = (rows: RodadaClientesRow[]) =>
  rows.some((r) => r.concluida_em === null && r.falhou_em === null);

/** Aberta + a falhada mais recente + a concluída mais recente (achado Codex P2: a falhada não pode sumir). */
export function rodadasRelevantes(rows: RodadaClientesRow[]): RodadaClientesRow[] {
  const ordenadas = [...rows].sort((a, b) => b.criado_em.localeCompare(a.criado_em));
  const aberta = ordenadas.find((r) => r.concluida_em === null && r.falhou_em === null);
  const falhada = ordenadas.find((r) => r.falhou_em !== null);
  const concluida = ordenadas.find((r) => r.concluida_em !== null);
  return [aberta, falhada, concluida].filter((r): r is RodadaClientesRow => r !== undefined);
}

const fmt = (n: number) => n.toLocaleString("pt-BR");

function totais(r: RodadaClientesRow): string {
  return `${fmt(r.importados)} novos · ${fmt(r.pulados)} já existiam · ${fmt(r.erros)} erros`;
}

export function statusRodada(r: RodadaClientesRow, agoraMs: number = Date.now()): StatusRodada {
  const conta = r.conta_slug ? NOME_CONTA[r.conta_slug] ?? r.conta_slug : null;
  const posicao = r.conta_slug ? `${ORDEM_CONTAS.indexOf(r.conta_slug) + 1}/3` : "1/3";
  if (r.falhou_em) {
    const motivo = r.motivo_falha === "sem_progresso" ? "parou de avançar" : "erro repetido";
    return {
      id: r.id, estado: "falhou", podeRearmar: r.running_since === null,
      descricao: `Falhou (${motivo}) em ${conta ?? "início"}, página ${r.start_page}${r.ultimo_erro ? ` — ${r.ultimo_erro}` : ""}. ${totais(r)}`,
    };
  }
  if (r.concluida_em) {
    const pendente = r.falhas.length > 0 || r.contas_sem_credencial.length > 0 || r.erros > 0;
    return {
      id: r.id, estado: pendente ? "parcial" : "concluida", podeRearmar: false,
      descricao: pendente
        ? `Concluída com pendências: ${r.falhas.length} conta(s) interrompida(s), ${r.contas_sem_credencial.length} sem credencial. ${totais(r)} — uma nova rodada tenta de novo`
        : `Concluída. ${totais(r)}`,
    };
  }
  const ultimoSinal = Date.parse(r.heartbeat_at ?? r.criado_em);
  const rodando = r.running_since !== null;
  // Vale também com lease ocupado: worker que morreu deixa running_since setado, e sem o cron
  // ninguém o rouba — a rodada ficaria "executando" para sempre (achado Codex P2).
  if (agoraMs - ultimoSinal > ATRASO_MS) {
    return {
      id: r.id, estado: "atrasada", podeRearmar: false,
      descricao: `Sem sinal do servidor há mais de 10 min (conta ${posicao}, página ${r.start_page}). Avise a equipe.`,
    };
  }
  return {
    id: r.id, estado: rodando ? "executando" : "aguardando", podeRearmar: false,
    descricao: `${rodando ? "Importando" : "Na fila do servidor"} — conta ${posicao}${conta ? ` (${conta})` : ""}, página ${r.start_page}${r.total_paginas ? `/${r.total_paginas}` : ""}. ${totais(r)}`,
  };
}
