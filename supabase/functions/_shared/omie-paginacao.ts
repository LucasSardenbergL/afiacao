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
// zerava o cursor (a cauda nunca mais era buscada).
//
// ⚠️ A 1ª versão tentava inferir sub-reporte pelo CRESCIMENTO do piso durante a run
// (com um caso especial para retomada). O challenge do Codex derrubou a inferência: se
// todas as respostas declararem o mesmo número sub-reportado, nada cresce e a run
// "completa" com a cauda inteira nunca visitada — para sempre. Nenhuma leitura do número
// DECLARADO prova o topo; só perguntar a página ACIMA dele prova. Por isso o caller faz
// uma SONDA (1 chamada) e passa o resultado aqui: I/O no caller, decisão testável aqui.
//   - parou no meio (budget/maxPages/streak) → cursor na página atual, jamais complete
//     (fim-por-exaustão ≠ fim-da-fonte, money-path §8);
//   - desceu tudo E a sonda veio vazia → topo PROVADO: complete;
//   - desceu tudo e a sonda achou dado (ou falhou) → NÃO completa, cursor na sonda.
//     Sonda que falha cai no mesmo ramo de propósito: ausência de sinal não é aprovação.
export function desfechoVarreduraReversa(input: {
  paginaFinal: number;          // valor do cursor ao sair do laço (0 = desceu tudo)
  inicioVarredura: number;      // página em que a varredura COMEÇOU nesta invocação
  tetoDeclarado: number;        // maior total já declarado na run (piso monotônico)
  topoVerificadoVazio: boolean; // a sonda acima do topo veio comprovadamente VAZIA?
  paginaSonda: number;          // página sondada (vira o cursor quando ela tem dado)
}): { complete: boolean; nextPage: number | null } {
  if (input.paginaFinal >= 1) return { complete: false, nextPage: input.paginaFinal };
  if (input.topoVerificadoVazio) return { complete: true, nextPage: null };
  return { complete: false, nextPage: input.paginaSonda };
}

// Fingerprint de uma página do Omie, para detectar página REPETIDA (a API devolvendo a
// mesma página em vez de avançar). O fingerprint antigo era `${primeiroCodigo}:${count}`
// e COLIDIA (achado Codex): duas páginas cheias cujo 1º título não tem
// `codigo_lancamento_omie` produzem ambas `":100"`. Com repetição passando a LANÇAR, uma
// colisão viraria sync travado — daí o hash sobre TODOS os códigos, com a POSIÇÃO
// misturada (senão a mesma página reordenada colidiria) e marcador explícito de ausente.
// FNV-1a de 63 bits, o mesmo esquema já usado no buildSyntheticMovementId.
export function fingerprintPagina(codigos: ReadonlyArray<number | null | undefined>): string {
  let hash = 1469598103934665603n;
  const prime = 1099511628211n;
  const mask = (1n << 63n) - 1n;
  const mistura = (s: string) => {
    for (const char of s) {
      hash ^= BigInt(char.codePointAt(0) ?? 0);
      hash = (hash * prime) & mask;
    }
  };
  codigos.forEach((c, i) => mistura(`${i}:${c ?? "?"}|`));
  return `${codigos.length}:${hash.toString(36)}`;
}

// Desfecho do cursor de UMA conta num varredor multi-conta (`sync_all_clients` do omie-cliente:
// o caller reinvoca a edge com {account_index, start_page, total_paginas} até acabarem as contas).
// Estava inline no call-site e sem teste nenhum — apesar de ser onde moram os dois defeitos já
// pagos: o piso que morria entre invocações (#1597) e o `break` de erro que devolvia o cursor
// PARADO na mesma conta/página, prendendo o sync inteiro na primeira conta quebrada.
//
// As três entradas booleanas NÃO são intercambiáveis, e é isso que o helper existe para fixar:
//   - `fimReal`         = a conta ACABOU (EOF do contrato Omie / página vazia no fim declarado).
//   - `contaAbandonada` = a conta foi INTERROMPIDA por falha. O cursor também avança — mas o
//     caller é obrigado a propagar o motivo, senão vira "concluída" mentirosa (money-path §8:
//     truncar é legítimo, truncar em SILÊNCIO não é).
//   - `ultimaPaginaCheia` = evidência de continuação que não depende do caller repassar o piso:
//     página cheia significa que há mais adiante mesmo com `total_de_paginas` ausente. Sem ela,
//     "não sei o total" viraria "acabou" — a fabricação de completude do §9.
export function desfechoContaListagem(input: {
  fimReal: boolean;
  contaAbandonada: boolean;
  paginaCursor: number;   // próxima página a processar (o laço já parou nela)
  tetoPaginas: number;    // piso monotônico do total declarado
  ultimaPaginaCheia: boolean;
}): { hasMore: boolean; proximaPagina: number; avancarConta: boolean } {
  const hasMore = !input.fimReal && !input.contaAbandonada &&
    (input.paginaCursor <= input.tetoPaginas || input.ultimaPaginaCheia);
  // Ao trocar de conta o cursor volta para a página 1: o teto é POR conta, e herdá-lo faria a
  // conta seguinte começar com um total que não é dela.
  return { hasMore, proximaPagina: hasMore ? input.paginaCursor : 1, avancarConta: !hasMore };
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

// O que os guards acima NÃO cobrem: `nTotPaginas` é PISO (o Omie SUB-REPORTA em listas
// grandes — docs/agent/sync.md), e um laço `while (pagina <= totalPaginas)` para no total
// DECLARADO. Se ele veio curto, a cauda nunca é pedida e o laço termina sem nenhuma
// anomalia — "acabou" e "truncou" ficam indistinguíveis (money-path §8). O segundo sinal
// que os separa é a CONTAGEM de registros que a própria resposta declara (nTotRegistros /
// total_de_registros): lidos < declarados ⇒ retrato truncado.
//
// Por que devolver um booleano em vez de lançar: o caller decide o que fazer com um retrato
// parcial, e a decisão é por EFEITO. Gravar o que leu costuma ser certo (o físico lido está
// fresco); tomar decisão NEGATIVA sobre o que faltou — inativar SKU, apagar órfão, carimbar
// "não comprou" — é sempre errado, porque o ausente é "não li", não "não existe".
// Declarado ausente/0 devolve false: sem o segundo sinal não há como afirmar truncamento
// (e afirmar sem sinal seria fabricar o próprio alerta).
export function varreduraTruncada(registrosLidos: number, totalDeclarado: number | undefined): boolean {
  const declarado = Number(totalDeclarado ?? 0);
  if (!Number.isFinite(declarado) || declarado <= 0) return false;
  return registrosLidos < declarado;
}
