// Guards PUROS de paginação do ListarPosEstoque do Omie (nTotPaginas) — compartilhados por
// sync-reprocess (reprocessInventory, #1341/#1353) e omie-analytics-sync (syncInventory /
// syncInventoryFull). Testes: omie-paginacao_test.ts. Nasceram em sync-reprocess/inventory-lote.ts
// e subiram p/ _shared/ (padrão product-idmap do #1341) em vez de import cross-edge, que
// acoplaria os bundles de deploy das duas edges.
//
// Por quê: nTotPaginas do Omie é PISO, não verdade (docs/agent/sync.md), e o padrão histórico
// `totalPaginas = result.nTotPaginas || 1` POR RESPOSTA tem dois defeitos:
// (a) resposta intermediária SEM o campo encolhe o teto e o loop completa retrato PARCIAL
//     como 'complete' (Codex P1 do #1353);
// (b) nTotPaginas lixo/gigante gira a edge por ~90s+ de chamadas Omie antes de um guard de
//     CONTAGEM disparar — reproduzindo o próprio 546 (Codex P1 do #1341).

// Guard anti-runaway: nTotPaginas lixo/gigante não pode girar a edge por horas.
// 500 páginas × 100 = 50k posições ≈ >10× o maior uso atual (syncInventoryFull colacor com
// cExibeTodos:"S" ≈ 43 páginas do catálogo ~4.3k; só-com-saldo: oben ~8 págs, colacor ~14).
export const MAX_PAGINAS_POS_ESTOQUE = 500;

// Régua das listagens de CADASTRO (ListarClientes/ListarProdutos/ListarParcelas,
// total_de_paginas). O teto existe para pegar `total_de_paginas` LIXO (ex.: 100000), não para
// dimensionar a base: 2.000 páginas são 100k registros @50/pág e 200k @100/pág, contra ~6,9k
// cadastros hoje (~14× de folga) — e um lixo de 10^5 continua reprovando fail-fast.
//
// ⚠️ Foi 500 na 1ª versão deste PR e o Codex (xhigh) classificou como "limite de capacidade
// disfarçado de guard": @50/pág davam 25k, só 3,6× a base. E o custo de errar é ASSIMÉTRICO —
// validarTotalPaginas LANÇA acima do teto, o erro é capturado como falha de página, o cursor
// NÃO avança e as contas seguintes nunca são visitadas: um teto baixo demais não degrada, ele
// PRENDE o sync para sempre. Como o trabalho por invocação já é limitado pelo `maxPages` de
// cada caller (3/10/12 páginas), um teto mais alto não gira a edge por mais tempo — só adia a
// bomba de crescimento. Na dúvida entre "guard aperta" e "guard prende", folgue o guard.
export const MAX_PAGINAS_LISTAGEM = 2000;

// ListarPedidos (@50/pág) enumera o HISTÓRICO completo de anos no backfill — o acervo real
// passa folgado de 500 páginas, então o teto das listagens de cadastro reprovaria total
// LEGÍTIMO. 5.000 págs ≈ 250k pedidos (>10× o acervo); lixo 10^5+ ainda falha fail-fast.
export const MAX_PAGINAS_PEDIDOS = 5000;

// Valida o nTotPaginas DECLARADO na resposta — fail-FAST (Codex P1): um nTotPaginas lixo
// gigante (ex.: 100000) não pode ser descoberto só na página maxPaginas+1, depois de ~90s de
// chamadas Omie — isso reproduziria o próprio 546. Lixo não-inteiro/0/negativo degrada para 1
// (fiel ao `|| 1` histórico: processa a página que JÁ veio e para).
export function validarTotalPaginas(nTot: number | undefined, maxPaginas: number): number {
  const total = Number(nTot ?? 1);
  if (!Number.isSafeInteger(total) || total < 1) return 1;
  if (total > maxPaginas) {
    throw new Error(
      `nTotPaginas=${total} acima do teto anti-runaway (${maxPaginas}) — abortando fail-fast antes de paginar`,
    );
  }
  return total;
}

// Piso MONOTÔNICO do total declarado (Codex P1 do #1353): o total é piso da RUN inteira —
// uma resposta intermediária SEM total (degrada p/ 1 pelo `|| 1` histórico) encolhia o teto
// e o loop completava retrato PARCIAL como 'complete' (ex.: p1 declara 5, p2 vem sem o campo
// → run terminava em 2/5). Declaração nova só MANTÉM ou CRESCE o teto; o fail-fast do
// anti-runaway continua o de validarTotalPaginas.
export function proximoTotalPaginas(
  atual: number,
  declarado: number | undefined,
  maxPaginas: number,
): number {
  return Math.max(atual, validarTotalPaginas(declarado, maxPaginas));
}

// Desfecho de uma varredura REVERSA (última página declarada → 1), o formato do
// ListarMovimentos no omie-financeiro. Aqui o total declarado não é só teto: decide o
// PONTO DE PARTIDA, então sub-reporte no arranque deixa de fora exatamente o dado MAIS
// RECENTE — e o `complete = pagina < 1` histórico carimbava esse buraco como completo e
// zerava o cursor (a cauda nunca mais era buscada). Regra:
//   - desceu até 0 e o piso cresceu ALÉM do ponto de partida numa run FRESCA → o começo
//     estava sub-reportado: NÃO completa, e o cursor aponta o piso novo (re-visitar é
//     barato — upsert idempotente — e é o único jeito de alcançar o que ficou acima);
//   - em RETOMADA, piso acima do resume é dado NOVO chegando durante o ciclo (esperado,
//     não sub-reporte): completa, e o próximo ciclo parte de um firstPage fresco;
//   - parou no meio (budget/maxPages/streak de vazias) → cursor na página atual, jamais
//     complete (fim-por-exaustão ≠ fim-da-fonte, money-path §8).
export function desfechoVarreduraReversa(input: {
  paginaFinal: number;      // valor do cursor ao sair do laço (0 = desceu tudo)
  inicioVarredura: number;  // página em que a varredura COMEÇOU nesta invocação
  tetoDeclarado: number;    // maior total já declarado na run (piso monotônico)
  retomada: boolean;        // true = inicioVarredura veio do cursor, não do firstPage
}): { complete: boolean; nextPage: number | null } {
  if (input.paginaFinal >= 1) return { complete: false, nextPage: input.paginaFinal };
  if (!input.retomada && input.tetoDeclarado > input.inicioVarredura) {
    return { complete: false, nextPage: input.tetoDeclarado };
  }
  return { complete: true, nextPage: null };
}

export type VeredictoPagina = "processar" | "fim" | "anomalia";

// nTotPaginas do Omie é PISO, não verdade (docs/agent/sync.md): página vazia ANTES do fim
// declarado = fault transiente/rate-limit disfarçado — completar aqui deixaria a cauda stale
// com 'complete' mentindo → anomalia (o caller aborta fail-closed; o próximo ciclo tenta).
// Vazia NA última declarada (ou além) = fim normal.
export function avaliarPagina(nItens: number, pagina: number, totalPaginas: number): VeredictoPagina {
  if (nItens > 0) return "processar";
  return pagina < totalPaginas ? "anomalia" : "fim";
}
