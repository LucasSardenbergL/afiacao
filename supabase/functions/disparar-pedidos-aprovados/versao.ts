// Marcador de versão da edge `disparar-pedidos-aprovados`.
//
// O classificador da sonda (money-path, idêntico em toda edge) mora em `_shared/sonda-versao.ts` —
// um dono, um conjunto de testes. Aqui fica só o que é DESTA edge: a versão e a descrição do
// efeito caro que a recusa fail-closed cita.
//
// POR QUE A SONDA EXISTE AQUI (2026-08-14, #1747): esta edge não tinha caminho algum sem efeito.
// `dry_run` NÃO é dry-run — chama `IncluirPedCompra` incondicionalmente e CRIA PEDIDO DE COMPRA
// REAL no Omie (só troca cObs, cObsInt e o status para `disparado_simulado`); e mesmo com ZERO
// aprovados o fluxo expira oportunidades e grava `sync_reprocess_log`. A única prova de deploy era
// esperar um pedido ser disparado de verdade.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("disparar-pedidos-aprovados");

/**
 * Marcador de versão servido pela edge. **Atualize a cada mudança relevante de comportamento** —
 * é ele que distingue um bundle novo de um velho em produção.
 *
 * `v1.1-marco-causal` = o guard temporal lê `omie_po_inexistente_antes_de` (marco causal do relógio
 * do BANCO, lido ANTES do IncluirPedCompra) em vez de `omie_registrado_em`. Ver #1739 / 654f8576.
 *
 * ⚠️ O sensor só prova versões a partir de si mesmo: um bundle que tenha o marco causal mas seja
 * ANTERIOR ao #1747 não responde `versao` nenhuma. Ausência do campo = bundle pré-sensor.
 */
export const VERSAO = "v1.1-marco-causal";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO = "esta edge cria pedido de compra REAL no Omie, inclusive em dry_run";
