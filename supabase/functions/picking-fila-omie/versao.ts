// Marcador de versão da edge `picking-fila-omie`.
// Classificador da sonda (compartilhado): `_shared/sonda-versao.ts`.
//
// Spec: docs/superpowers/specs/2026-10-10-picking-v2-design.md (Fase 0.1 — confirmar contratos).
// Modos: diagnóstico e coleta só LEEM; `sincronizar` ESCREVE a fila no banco (nunca no Omie).

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("picking-fila-omie");

/**
 * Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho.
 * v0.1: modo `diagnostico` read-only — por conta (oben, colacor): `ListarEtapasFaturamento`,
 * `ListarPedidos{etapa:'10'}` (1 página) e `ListarProdutos` (1 página, cobertura de EAN).
 * v0.2 (Fase 0.2): o `ListarPedidos` pede a vez na trava compartilhada `omie_cota_metodo`
 * (_shared/omie-cota.ts); vez negada vira erro no resumo, sem chamar o Omie.
 * v0.3 (Fase 0.5a): modo `coleta`, SÓ leitura — por conta, o total da etapa 10 (1 registro) e a
 * listagem `ListarPedidos{etapa:'10', filtrar_por_data_de: hoje−30}` paginada até o fim; devolve
 * números (páginas, completude, corte, itens ilegíveis) e a prova do filtro (os 100 mais recentes
 * sem filtro têm de estar na filtrada), sem chamar o banco.
 * v0.4 (Fase 0.5b): modo `sincronizar` (uma conta por chamada) — ESCREVE no banco: reserva
 * exclusiva (`picking_coleta_reservar`), listagem desde a inclusão da tarefa aberta mais antiga
 * (ou hoje−30), UMA `picking_sincronizar_fila` com o token. Sem ConsultarPedido.
 */
export const VERSAO = "v0.4-coleta-escrita";

/** Efeito citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge chama o Omie (ListarEtapasFaturamento, ListarProdutos e ListarPedidos — este paginado no " +
  "modo coleta — em cada conta) — " +
  "chamada repetida do mesmo método na mesma app_key arrisca o bloqueio REDUNDANT, que derruba os " +
  "syncs vizinhos";
