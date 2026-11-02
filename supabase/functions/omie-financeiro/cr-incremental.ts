// Decisor de MODO e JANELA do sync de contas a receber (plano v4, lote 15 — B3). Puro, sem IO: o
// teste roda o código real em Deno (cr-incremental_test.ts). Desenho e evidência medida:
// docs/superpowers/specs/2026-11-01-fin-cr-incremental-design.md.
//
// O que o Omie garante (medido na oben, 2026-11-01): `filtrar_apenas_alteracao=S` filtra por `info.dAlt`
// em granularidade de DIA (limites inclusivos), e baixa, estorno, cancelamento e inclusão carimbam o
// `dAlt` no momento do registro. NÃO garante: exclusão (some de toda listagem) e o status relativo ao dia
// (`A VENCER` → `ATRASADO` sem alteração) — por isso o incremental relista o conjunto ABERTO inteiro.
import { diaSP, paraDataOmie, somarDias } from "../_shared/hoje-sp.ts";

/** Full (rede de segurança) no máximo a cada 7 dias — ver §3.3 do desenho. */
export const FULL_MAX_DIAS = 7;
/** A marca d'água volta 1 dia: cobre a granularidade de dia e alteração durante o próprio run. */
export const SOBREPOSICAO_DIAS = 1;

// Marcadores em `sync_state` (entity_type × account=empresa), cada um com UM writer nesta edge.
/** last_sync_at = início do full em andamento (gravado na página 1). */
export const MARCADOR_FULL_INICIO = "fin_cr_full_inicio";
/** last_sync_at = início do último full que chegou ao FIM REAL (copiado do de cima no fim). */
export const MARCADOR_FULL_OK = "fin_cr_full_ok";
/** last_sync_at = início (t0) do último incremental íntegro (A + B + reconciliação). */
export const MARCADOR_INCREMENTAL_OK = "fin_cr_incremental_ok";

export type EstadoCR = {
  /** Início do último full completo; null = nunca houve. */
  fullOkEm: Date | null;
  /** t0 do último incremental íntegro; null = nunca houve. */
  incrementalOkEm: Date | null;
};

export type ModoCR =
  | { modo: "continuar_full" }
  | { modo: "full"; motivo: "estado_ilegivel" | "sem_full" | "full_vencido" }
  | { modo: "incremental"; de: string; ate: string; marca: string };

const DIA_MS = 86_400_000;

/**
 * Decide o modo do run de UMA empresa. `estado` null = não deu para ler o `sync_state` (tabela, rede,
 * migration não aplicada): cai no full, que é o comportamento anterior a este lote — falhar FECHADO aqui
 * é nunca pular a listagem completa por falta de marca.
 */
export function decidirModoCR(input: { cursorPendente: boolean; estado: EstadoCR | null; agora: Date }): ModoCR {
  const { cursorPendente, estado, agora } = input;
  if (cursorPendente) return { modo: "continuar_full" };
  if (!estado) return { modo: "full", motivo: "estado_ilegivel" };
  if (!estado.fullOkEm) return { modo: "full", motivo: "sem_full" };
  if (agora.getTime() - estado.fullOkEm.getTime() > FULL_MAX_DIAS * DIA_MS) {
    return { modo: "full", motivo: "full_vencido" };
  }
  // A marca é o instante mais recente a partir do qual TUDO foi listado: o início do último full
  // completo ou o t0 do último incremental íntegro.
  const marcaEm = estado.incrementalOkEm && estado.incrementalOkEm > estado.fullOkEm
    ? estado.incrementalOkEm
    : estado.fullOkEm;
  return { modo: "incremental", ...janelaAlteracao(marcaEm, agora) };
}

/**
 * Janela de `filtrar_por_data_de/ate` (formato do Omie) para os títulos alterados desde a marca. Datas no
 * fuso de São Paulo, que é o do `dAlt` do Omie (conferido: alterações das 18–20 h BRT caem no próprio dia).
 */
export function janelaAlteracao(marcaEm: Date, agora: Date): { de: string; ate: string; marca: string } {
  const marca = diaSP(marcaEm);
  const hoje = diaSP(agora);
  if (marca > hoje) throw new RangeError(`janelaAlteracao: marca no futuro (${marca} > ${hoje})`);
  return { de: paraDataOmie(somarDias(marca, -SOBREPOSICAO_DIAS)), ate: paraDataOmie(hoje), marca };
}
