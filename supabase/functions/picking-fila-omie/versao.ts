// Marcador de versão da edge `picking-fila-omie`.
// Classificador da sonda (compartilhado): `_shared/sonda-versao.ts`.
//
// Spec: docs/superpowers/specs/2026-10-10-picking-v2-design.md (Fase 0.1 — confirmar contratos).
// Esta versão é SÓ diagnóstico: lê o Omie (3 métodos distintos por conta) e devolve um resumo.
// Não escreve no banco nem no Omie, e não tem cron.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("picking-fila-omie");

/**
 * Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho.
 * v0.1: modo `diagnostico` read-only — por conta (oben, colacor): `ListarEtapasFaturamento`,
 * `ListarPedidos{etapa:'10'}` (1 página) e `ListarProdutos` (1 página, cobertura de EAN).
 */
export const VERSAO = "v0.1-diagnostico";

/** Efeito citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge chama o Omie (ListarEtapasFaturamento, ListarPedidos e ListarProdutos em cada conta) — " +
  "chamada repetida do mesmo método na mesma app_key arrisca o bloqueio REDUNDANT, que derruba os " +
  "syncs vizinhos";
