import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { removerComentarios } from '@/lib/gates/limpeza-fonte';

// ── GATE ESTRUTURAL da classe "laço de paginação artesanal que trata página com falha
// como fim da lista" (money-path §6/§7/§8) ─────────────────────────────────────────────
//
// A classe custou ~20 PRs corrigidos um a um (#1338, #1425, #1471, #1500, #1524, #1545,
// #1550, #1557 [6 laços], #1562, #1563 ["7º laço"], #1564) — cada fix esperou o próximo
// sintoma doer em produção. Página perdida não some da tela: vira "SKU sem custo" (infla
// margem), "cliente sem carteira" (troca o escopo do cálculo) ou "não comprou" carimbado
// em snapshot. Meta-regra do repo: classe com contramedida TEXTUAL reincide; classe com
// gate ESTRUTURAL para. Este arquivo é o gate.
//
// CONTRATO canônico de paginação (o que os helpers implementam):
//   - página com `error`  → LANÇA (nunca break/return do acumulado parcial);
//   - `data == null` SEM `error` → LANÇA (resposta malformada ≠ fim; `?? []` é o furo);
//   - fim legítimo: SÓ `data: []` / página curta;
//   - teto defensivo esgotado → LANÇA (fim-por-exaustão ≠ fim-da-fonte; §8).
//
// Por que TEXTUAL (readFileSync, padrão edge-money-path-invariants/edge-parse-parity):
// metade dos sites vive em edges Deno que o vitest não executa e o tsc do app não checa —
// um teste que lê FONTE cobre as duas metades com um contrato só, e roda no CI `validate`.

const RAIZ = resolve(__dirname, '../..');

// Diretórios varridos. scripts/ entra por completude (varredura 2026-07-23: zero sites lá,
// mas código novo de script que pagine PostgREST deve obedecer o mesmo contrato).
const DIRS = ['src', 'supabase/functions', 'scripts'];

const EXT = /\.(ts|tsx)$/;
const IGNORAR = /(\.test\.|_test\.|\.d\.ts$|__tests__|\.stories\.)/;

function listarFontes(dir: string, acc: string[] = []): string[] {
  for (const nome of readdirSync(resolve(RAIZ, dir))) {
    const rel = join(dir, nome);
    const abs = resolve(RAIZ, rel);
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (nome === 'node_modules' || nome === '.git') continue;
      listarFontes(rel, acc);
    } else if (EXT.test(nome) && !IGNORAR.test(rel)) {
      acc.push(rel);
    }
  }
  return acc;
}

// Remove comentários de LINHA INTEIRA (^\s*//…) e blocos /* … */ antes de aplicar os
// padrões — sem isso, prosa que DESCREVE o defeito (ex.: o cabeçalho de
// _shared/mapas-paginados.ts, que cita `const { data } = await ...range(...)` de
// propósito) dispararia o gate (lição #1472/#1488: assert sobre fonte roda com
// comentários removidos; comentário que satisfaz/dispara o fiscal é falso sinal).
// Comentário no FIM de linha de código sobrevive de propósito: removê-lo por regex
// mutilaria strings com `//` (URLs de import Deno), e os padrões abaixo são multiline
// ancorados em código — não casam prosa de fim de linha.
// O stripper é COMPARTILHADO (`@/lib/gates/limpeza-fonte`) e entende string/template/regex:
// a cópia local aqui limpava bloco com regex, e um `/*` dentro de string pareava com o `*/`
// seguinte apagando o miolo do arquivo ANTES de o fiscal olhar (classe medida em 2026-08-20).

// Conta TODAS as ocorrências do padrão por arquivo (não só a primeira). A baseline é por
// CONTAGEM, não por caminho (achado Codex xhigh): baseline por-arquivo aceitaria um 2º
// laço proibido nascer num arquivo já listado sem nada ficar vermelho. Com contagem:
// crescer REPROVA (reintrodução), diminuir REPROVA pedindo a atualização da baseline
// (a lista só encolhe, e encolhe REGISTRADO).
function contarPorArquivo(contar: (fonte: string) => number): Map<string, number> {
  const mapa = new Map<string, number>();
  for (const dir of DIRS) {
    for (const arquivo of listarFontes(dir)) {
      const n = contar(removerComentarios(readFileSync(resolve(RAIZ, arquivo), 'utf8')));
      if (n > 0) mapa.set(arquivo, n);
    }
  }
  return mapa;
}

function contarRegex(padrao: RegExp): (fonte: string) => number {
  return (fonte) => {
    const g = new RegExp(padrao.source, padrao.flags.includes('g') ? padrao.flags : padrao.flags + 'g');
    return [...fonte.matchAll(g)].length;
  };
}

// Compara o medido com a baseline e devolve os desvios nos DOIS sentidos.
function desvios(
  medido: Map<string, number>,
  baseline: ReadonlyMap<string, number>,
): { reintroducoes: string[]; quitacoes: string[] } {
  const reintroducoes: string[] = [];
  const quitacoes: string[] = [];
  for (const [arquivo, n] of medido) {
    const base = baseline.get(arquivo) ?? 0;
    if (n > base) reintroducoes.push(`${arquivo} (${base}→${n})`);
    else if (n < base) quitacoes.push(`${arquivo} (${base}→${n})`);
  }
  for (const [arquivo, base] of baseline) {
    if (!medido.has(arquivo)) quitacoes.push(`${arquivo} (${base}→0)`);
  }
  return { reintroducoes, quitacoes };
}

// ── G1: desestruturação que DESCARTA `error` numa instrução com `.range(` ─────────────
// A forma-mãe da classe (F1, controle: sync_addresses pré-#1563): `const { data } =
// await ....range(...)` não tem COMO detectar a página que falha — o error morre na
// desestruturação e `data:null` vira "acabou". Vale para laço E single-shot: mesmo fora
// de laço, um `.range()` cujo error é descartado lê falha como lista vazia.
const G1 = /const\s*\{\s*data(?:\s*:\s*\w+)?\s*\}\s*=\s*await\b[^;]{0,600}?\.range\(/;

// Allowlist G1 (por CONTAGEM) — cada entrada exige justificativa; contagem menor que a
// registrada REPROVA pedindo atualização (lista só encolhe, registrado).
const G1_ALLOW: ReadonlyMap<string, number> = new Map([
  // .range(1, 1) single-shot deliberado ("a 2ª visita mais recente") para decidir texto
  // de saudação — leitura cosmética, sem laço, sem money-path; falha degrada para o
  // texto default do dashboard. Convertê-la a {data, error} é welcome, não obrigatório.
  ['src/hooks/useLastVisit.ts', 1],
]);

// ── G3: coalescência de página (`?? []` / `|| []`) DENTRO de laço com `.range(` ───────
// A forma fina da classe (F3, controle: buscarTodasPaginas pré-#1564): o laço já lança
// em `error`, mas `data ?? []` converte a resposta malformada (`data:null` SEM error) em
// página vazia → EOF falso → o acumulado PARCIAL volta como se fosse a tabela inteira.
// Detecção posicional (não regex única): um `.range(` com `for`/`while` até ANTES_G3 chars
// ANTES (laço local — callbacks de helper não têm) e `?? []`/`|| []` até 260 chars
// DEPOIS (o acumulador da página). Single-shots e callbacks de helper não casam.
//
// ANTES_G3 era 300 e virou 1200 ao aplicar a regra do DENOMINADOR (§9 do money-path) a este
// arquivo. Medido em 2026-08-21 sobre as 1.642 fontes que o gate varre, com `.range(` como
// âncora (129 ocorrências):
//
//   janela │  300   600   900  1200  1600  2400  4000
//   laços  │   14    25    37    42    48    57    65     ← NÃO converge: acima de ~600 o `for`
//   acusa  │    0     1     1     1     1     1     1        já é de outro escopo, é ruído
//
// As duas linhas dizem coisas opostas, e é por isso que a medição valeu. "Laços vistos" cresce
// para sempre — seria um denominador enganoso, do tipo que faz alguém escolher a janela pelo
// número que quer ver. **ACUSADOS** (laço + coalescência de página) estabiliza em 1 já aos 600 e
// não se move até 4000: o veredito é o MESMO em toda a faixa, então 1200 não foi escolhido a
// dedo — qualquer valor ≥600 dá esta resposta. O que a janela de 300 fazia era não olhar: o
// único sítio candidato do repo tem o `for` a 460 chars do `.range(`, e o gate declarava
// `G3_DIVIDA` VAZIA sem nunca tê-lo inspecionado. Zero não medido com cara de zero auditado —
// exatamente a regra (a) do §9.
const ANTES_G3 = 1200;

function contarG3(fonte: string): number {
  let i = -1;
  let n = 0;
  while ((i = fonte.indexOf('.range(', i + 1)) !== -1) {
    const antes = fonte.slice(Math.max(0, i - ANTES_G3), i);
    const depois = fonte.slice(i, i + 260);
    if (/\b(for|while)\s*\(/.test(antes) && /(\?\?|\|\|)\s*\[\]/.test(depois)) n++;
  }
  return n;
}

/**
 * G3 ALLOW — sítio inspecionado e ABSOLVIDO, que é diferente de dívida.
 *
 * `useSalesOrders.ts` é o laço que a janela de 300 escondia. Ele TEM a forma (`for` + `.range(`
 * + `(data ?? [])`), e mesmo assim não produz o silêncio da classe, porque o `?? []` não é a
 * única testemunha: o drain pede `count: 'exact'` na 1ª página e guarda o total. Se `data` vier
 * null SEM error, `rows` fica vazio e o laço encerra — mas `total` continua sendo o count do
 * servidor, então (i) `result.rows.length < result.count` dispara um re-drain, e (ii) se ainda
 * assim faltar linha, `truncated = totalCount > orders.length` acende o aviso na tela. O parcial
 * NÃO passa por completo, que é o dano que o G3 existe para impedir.
 *
 * Fica na ALLOW e não na DÍVIDA de propósito: dívida é o que se pretende quitar, e aqui não há
 * o que quitar. O que este waiver compra é que a próxima mudança nesse laço — tirar o `count`,
 * tirar o re-drain, tirar o `truncated` — reprove aqui em vez de passar despercebida.
 */
const G3_ALLOW: ReadonlyMap<string, number> = new Map([
  ['src/components/salesOrders/useSalesOrders.ts', 1],
]);

// DÍVIDA G3 (baseline por CONTAGEM, 2026-07-23 — chips de erradicação por domínio
// abertos na mesma data). NÃO adicione entradas nem aumente contagens: crescer é
// REINTRODUÇÃO. Ao quitar (contagem cair), o teste reprova pedindo a atualização —
// a lista só encolhe, e encolhe registrado (achado Codex: baseline por arquivo
// aceitaria um laço NOVO nascer em arquivo já listado).
const G3_DIVIDA: ReadonlyMap<string, number> = new Map([
  // Quitados (erradicação scoring/carteira/batch, #1596): ai-ops-agent, algorithm-a-audit,
  // calculate-scores, carteira-rebuild — convertidos a fetchAll/throw/failLease.
  // Quitado (erradicação das 3 edges de sync Omie, #1597): omie-analytics-sync (5→0) — os
  // 5 laços viraram chamadas a `fetchAll` (_shared/paginate.ts), que lança em erro E em
  // data:null.
  // Quitado (erradicação das EDGES FINANCEIRAS, este PR): omie-financeiro (1→0) — o laço do
  // carregarBaixaMapDRE (baixaMap parcial no DRE-caixa) delegado ao mesmo `fetchAll`.
  // Os três PRs nasceram do mesmo chip-mãe (#1581) e conflitaram AQUI por editar linhas
  // vizinhas; a resolução é UNIÃO — as listas de quitação são disjuntas e todas valem
  // (money-path §9: conflito entre dois fixes da mesma classe não se resolve por lado).
  // A dívida G3 chegou a ZERO: a próxima entrada aqui é reintrodução, não herança.
]);

// F2 residual SEM regra automatizada (decisão registrada, respondendo ao challenge do
// Codex): a forma `if (!x || x.length === 0) break`/`hasMore=false` colapsando
// data:null com fim CHEGOU A ZERO na continuação do #1581, em dois chips que fecharam
// juntos: os 3 laços keyset das edges de sync Omie (omie-cliente :362/:948/:1154 e
// omie-vendas-sync :955) viraram `if (x == null) throw` + `if (x.length === 0)`, que
// separa resposta MALFORMADA de fim legítimo sem perder o cursor keyset (design legítimo:
// keyset ≠ offset, não vira fetchAll); e o 4º site, omie-malha-sync ~:145, caiu no chip
// ESTOQUE/NF-e/TINT/CMC (`lista === null` LANÇA, teto esgotado LANÇA). A regex genérica do
// padrão casa ~13 usos LEGÍTIMOS de "lista vazia → nada a fazer" fora de laço de paginação
// (medido 2026-07-23) e uma versão posicional fina o bastante seria frágil; a morte da
// forma veio da CONVERSÃO para helpers (que os chips executaram), e G1/G3/G4 barram as
// formas grepáveis.

// ── G4: total de páginas do Omie confiado CRU (`|| 1` / `?? 1` por resposta) ──────────
// nTotPaginas/total_de_paginas é PISO, não verdade (docs/agent/sync.md): resposta
// intermediária sem o campo degrada para 1 e ENCOLHE o teto → o laço completa retrato
// PARCIAL como 'complete' (Codex P1 do #1353). O padrão correto vive em
// supabase/functions/_shared/omie-paginacao.ts: validarTotalPaginas (fail-fast
// anti-runaway) + proximoTotalPaginas (piso monotônico) + avaliarPagina (página vazia
// antes do fim declarado = anomalia, nunca "fim").
//
// ⚠️ O `[^;]{0,60}?` (era `\s*`) foi ENDURECIDO em DOIS passos na continuação do #1581:
//  (1) `\s*` → aceitar o que houver entre o campo e o operador: a forma dominante nas edges de
//      venda/financeiro é `(result.total_de_paginas as number) || 1`, e o CAST fazia a regex
//      NÃO casar — o gate media 0 num arquivo com 5 sites vivos (omie-financeiro). Detector que
//      não enxerga a forma real do repo é falso-VERDE, a família do "O DETECTOR mente".
//      Medido: +5 em omie-financeiro, +1 em omie-vendas-sync, zero falso positivo.
//  (2) permitir NEWLINE (achado Codex deste PR): `(… as number)\n  || 1` é o que o formatador
//      automático produz quando a linha passa do limite, e a versão anterior (`[^;\n]`) deixava
//      passar. Medido no repo inteiro: ZERO diferença de contagem — não gera falso positivo aqui.
// O `;` continua excluído: é ele que impede o padrão de atravessar para o statement vizinho.
//
// LIMITAÇÃO CONHECIDA (registrada, não é descuido — a solução completa exigiria AST/dataflow):
//  · falso POSITIVO possível em objeto literal — `{ pages: result.total_de_paginas, n: x || 1 }`
//    casa sem ser fallback de total (não existe no repo hoje; se aparecer, vai para a allowlist);
//  · falso NEGATIVO via ALIAS — `const t = result.total_de_paginas; … t || 1` escapa, porque o
//    nome do campo não está na mesma expressão.
//
// ⚠️ TERCEIRO endurecimento (chip ESTOQUE/NF-e/TINT/CMC): `nTot(?:al)?Paginas` — `nTotalPaginas`
// (com o "al") é o MESMO campo com outra grafia, a que PesquisarPedCompra e ListarRecebimentos
// usam. Variante de NOME não é variante de DEFEITO, e o walker confirmou 1 site vivo escapando
// por ela (omie-sync-nfes-recebidas, baselinado abaixo). Os três endurecimentos são ortogonais
// e se somam: cast (1), newline (2) e grafia (3) — cada um revelou site real que os outros não
// viam, o que é o argumento contra tratar detector como "pronto".
const G4 = /(nTot(?:al)?Paginas|total_de_paginas)[^;]{0,60}?(\|\||\?\?)\s*1\b/;

// Allowlist PERMANENTE por contagem (usos legítimos da forma — não são dívida). O helper
// _shared/omie-paginacao.ts NÃO precisa de entrada: seu `Number(nTot ?? 1)` usa o
// parâmetro `nTot`, que a regex (ancorada nos nomes de campo do Omie) não casa.
const G4_ALLOW: ReadonlyMap<string, number> = new Map([
  // `omieTruncado = (total_de_paginas ?? 1) > 1` é DETECÇÃO de truncamento que alimenta
  // o fail-closed doc-ambíguo (guardrail do edge-money-path-invariants) — não é teto.
  ['supabase/functions/omie-sync/index.ts', 1],
  // O `?? 1` monta o total DECLARADO cru que alimenta o guard local (paginacao.ts do
  // próprio edge: piso monotônico + vazia≤piso lança + teto lança — auditado 2026-07-23).
  ['supabase/functions/omie-sync-status-produtos/index.ts', 1],
  // syncPedidos (~:1159) — `só p/ log/ETA, NÃO decide completude`, auditado na continuação
  // do #1581: a autoridade de fim é `classifyPedidosPage` (pagination.ts: fim REAL = null/
  // vazia-que-não-contradiz; vazia que CONTRADIZ = anomalia → pausa) e `complete = reachedEnd`.
  // O valor só alcança um console.log e o campo informativo do retorno. Revelado pelo
  // endurecimento da regex acima (o cast o escondia).
  ['supabase/functions/omie-vendas-sync/index.ts', 1],
]);

// DÍVIDA G4 (baseline por CONTAGEM, 2026-07-23 — mesma regra da G3_DIVIDA). Quitação
// ESTOQUE/NF-e/TINT/CMC (continuação do #1581): cmc-snapshot-backfill, cmc-snapshot-smoke,
// omie-sync-ctes-recebidos, omie-sync-estoque (2), omie-sync-metadados,
// omie-sync-vendas-items, sync-reprocess e tint-omie-sync convertidos aos guards de
// _shared/omie-paginacao.ts. Restam os do chip VENDAS/CLIENTES:
const G4_DIVIDA: ReadonlyMap<string, number> = new Map([
  // omie-analytics-sync (3→0), omie-cliente (1→0) e omie-vendas-sync (1→0, o `|| 1` do
  // backfill_tint_cor) QUITADOS no chip das 3 edges de sync Omie — os totais passaram a
  // proximoTotalPaginas + avaliarPagina. O que resta do vendas-sync é a entrada de
  // G4_ALLOW acima (log/ETA), não dívida.
  // omie-financeiro (5→0) QUITADO no chip das EDGES FINANCEIRAS: a dívida de 5 que o #1597
  // baselinou ao consertar o detector eram os `(… as number) || 1`. Ciclo completo da
  // erradicação em dois PRs — um conserta o DETECTOR e baselina o que ele revela, o outro
  // corrige o revelado e tira a entrada.
  // QUITADOS no chip ESTOQUE/NF-e/TINT/CMC (8 entradas): cmc-snapshot-backfill,
  // cmc-snapshot-smoke, omie-sync-ctes-recebidos, omie-sync-estoque (2), omie-sync-metadados,
  // omie-sync-vendas-items, sync-reprocess e tint-omie-sync — todos aos guards de
  // _shared/omie-paginacao.ts.
  //
  // ÚNICO remanescente, e ele é do MESMO ciclo detector→revelado: o terceiro endurecimento
  // da regex (grafia `nTotalPaginas`) revelou este site PREEXISTENTE, que escapava do gate
  // desde sempre. Baselinado para morrer com o chip de NF-e/vendas restante em vez de sumir
  // do radar — a lista só encolhe, e encolhe registrado.
  ['supabase/functions/omie-sync-nfes-recebidas/index.ts', 1],
]);

// ── G5: piso monotônico aplicado SEM o veredito de página ────────────────────────────
// O G4 barra o total CRU e é cego para a metade seguinte do contrato: trocar `|| 1` por
// `proximoTotalPaginas` e parar aí conserta o TETO e deixa vivo o outro furo — página vazia
// ANTES do fim declarado continua sendo lida como fim. Quem separa os dois é o `avaliarPagina`.
// É a lição do §9 nesta classe: gate de FORMA ("usou o helper") não protege a ESCOLHA (usar as
// DUAS metades) — quando a escolha é a defesa, pine a escolha.
//
// Detecção POSICIONAL, não por saldo de contagens no arquivo (a 1ª versão era por saldo e o
// challenge Codex derrubou com dois furos concretos): (a) um `avaliarPagina` INÚTIL noutro laço
// empatava a conta enquanto o laço money-path seguia tratando vazio como fim; (b) a allowlist
// por contagem aceitava SUBSTITUIÇÃO invisível da dívida — corrigir o site listado e criar
// outro órfão no mesmo arquivo mantinha o excedente igual, sem disparar nada.
// Aqui cada `proximoTotalPaginas(` exige o veredito na SUA janela, truncada no PRÓXIMO piso,
// para a defesa de um laço nunca satisfazer o piso de outro.
//
// ⚠️ A janela é FOLGADA de propósito. A 1ª versão usou 400 (medido: maior distância real 301) e
// ficou falso-VERMELHA sobre o omie-cliente ~:1165 no mesmo dia, porque o #1614 inseriu ali um
// guard `if (!Array.isArray(clientes)) throw` ENTRE o piso e o veredito e a distância virou 446.
// O código estava certo; apertado estava o detector — e a saída natural de um falso-vermelho é
// afrouxar a REGRA, que é o estrago (§#1483). Quem separa laços aqui é o truncamento no próximo
// piso, não o tamanho da janela: então 800 (~1,8× o máximo medido) dá espaço para os guards que
// PRs futuros vão inserir no meio, sem custo de precisão.
const JANELA_G5 = 800;

function orfaosG5(fonte: string): string[] {
  const orfaos: string[] = [];
  let i = -1;
  while ((i = fonte.indexOf('proximoTotalPaginas(', i + 1)) !== -1) {
    // Pula a DEFINIÇÃO do helper (`export function proximoTotalPaginas(`), que não é uso.
    if (/function\s+$/.test(fonte.slice(Math.max(0, i - 30), i))) continue;
    const proximoPiso = fonte.indexOf('proximoTotalPaginas(', i + 1);
    const fim = proximoPiso === -1 ? i + JANELA_G5 : Math.min(i + JANELA_G5, proximoPiso);
    if (fonte.slice(i, fim).includes('avaliarPagina(')) continue;
    // Identidade do site = 1º argumento (a variável do piso). Estável e específica — é o que
    // impede a substituição invisível: trocar de site muda o nome e reprova.
    const arg = /proximoTotalPaginas\(\s*([A-Za-z_$][\w$]*)/.exec(fonte.slice(i))?.[1] ?? '?';
    orfaos.push(arg);
  }
  return orfaos;
}

// Allowlist do G5 — por VARIÁVEL do piso órfão, nunca por contagem (ver acima).
const G5_ALLOW_VARS: ReadonlyMap<string, readonly string[]> = new Map([
  // `histTotal` = histórico de itens preferidos (`customer_preferred_items`): decisão REGISTRADA
  // no próprio call-site — ali a página perdida custa recall (menos item sugerido), não
  // completude money-path, e o teto de 5 páginas do `for` já limita a varredura. Medido ANTES de
  // escrever este assert, para ele não nascer falso-VERMELHO sobre decisão que um PR já tomou.
  ['supabase/functions/omie-vendas-sync/index.ts', ['histTotal']],
]);

const G5_ALLOW: ReadonlyMap<string, number> = new Map(
  [...G5_ALLOW_VARS].map(([arquivo, vars]) => [arquivo, vars.length]),
);

// ── G6: resposta HTTP do Omie consumida sem olhar o STATUS ───────────────────────────
// Achado do challenge /codex sobre o PR que fechou o G4, e é a mesma classe uma camada ACIMA:
// `const r = await res.json(); if (r.faultstring) throw` deixa passar um 429/5xx cujo corpo
// PARSEIA sem `faultstring` — o `{}` de proxy/gateway. O objeto chega ao laço sem total e sem
// lista, o piso degrada para 1 e `avaliarPagina(0, 1, 1)` responde "fim".
//
// Por que G1-G5 não pegam: eles vigiam o LAÇO, e aqui a falha já foi convertida em "resposta
// boa" pelo wrapper, antes de o laço ver qualquer coisa. Um sync com os guards de paginação
// todos corretos ainda completa retrato parcial se o wrapper aprovar um 500.
//
// Regra: `await fetch(` cuja chamada menciona Omie precisa de `.ok`/`.status` antes do consumo.
//
// LIMITAÇÃO CONHECIDA (registrada, não é descuido — a versão completa exigiria dataflow): o
// detector aceita qualquer COMPARAÇÃO de `.status`, então um tratamento PARCIAL (só 425/429, a
// forma que o omie-sync-vendas-items tinha) o satisfaz enquanto o 500 continua passando. Está
// fixado no controle de calibração abaixo, para a limitação ser um fato medido e não uma surpresa
// — e é por isso que ela não substitui a leitura do wrapper ao mexer nele.
//
// ⚠️ A janela era uma DISTÂNCIA FIXA (1200 chars) e errava nos DOIS sentidos — medido ao quitar a
// dívida, com os dois erros no mesmo arquivo-conjunto:
//  · falso VERMELHO: `omie-vendas-sync` tem o `if (!response.ok) throw` na ordem canônica, ~1.400
//    chars abaixo do fetch (o retry/backoff da faultstring vive entre os dois). Ficava baselinado
//    como dívida um wrapper CORRETO — e dívida falsa ensina a ignorar a lista.
//  · falso VERDE, o caro: em `process-nfe` a janela alcançava o `if (!__auth.ok)` do gate de
//    AUTORIZAÇÃO do handler, 30 linhas abaixo e em OUTRA função. Um `.ok` de objeto sem relação
//    nenhuma com a resposta HTTP satisfazia o detector, e o wrapper (sem guard nenhum) media zero.
//    Não era "arquivo auditado": era o detector lendo o guard errado (§"O DETECTOR mente").
// Alargar a distância piora o segundo: a 4000 o `verify-employee` também ficava verde, pelo mesmo
// mecanismo. O que separa os dois casos não é TAMANHO, é ESCOPO — o guard de uma resposta tem de
// estar na função que fez o fetch. Daí a janela ser léxica: até o `}` que fecha a função (coluna
// 0), truncada no próximo `await fetch(` (para o guard de um site nunca cobrir o do vizinho) e num
// teto duro. Medido no repo inteiro: revela `process-nfe`, quita `omie-vendas-sync`, e não mexe em
// mais nada.
const TETO_G6 = 4000;

function janelaG6(fonte: string, i: number): string {
  let fim = i + TETO_G6;
  const proximoFetch = fonte.indexOf('await fetch(', i + 1);
  if (proximoFetch !== -1) fim = Math.min(fim, proximoFetch);
  const fechaFuncao = /\n\}/.exec(fonte.slice(i)); // `}` na coluna 0 = fim da função top-level
  if (fechaFuncao) fim = Math.min(fim, i + fechaFuncao.index);
  return fonte.slice(i, fim);
}

function fetchsOmieSemStatus(fonte: string): number {
  let i = -1;
  let n = 0;
  while ((i = fonte.indexOf('await fetch(', i + 1)) !== -1) {
    if (!/omie/i.test(fonte.slice(i, i + 260))) continue; // só o Omie; Supabase/LLM têm outro contrato
    if (!/\.ok\b|\.status\s*(===|!==|>=|<|==)/.test(janelaG6(fonte, i))) n++;
  }
  return n;
}

// Allowlist G6 (por CONTAGEM) — tratamento CORRETO numa forma que a regex não casa. Não é dívida:
// cada entrada foi lida linha a linha, e a entrada existe porque afrouxar a regex para acomodá-la
// deixaria passar o furo real.
const G6_ALLOW: ReadonlyMap<string, number> = new Map([
  // `classifyOmieResponse(res.status, fs)` — o status vai como ARGUMENTO a um classificador puro
  // (omie-sync-nfes-recebidas/retry.ts, coberto por `retry_test.ts`), então não há operador de
  // comparação para a regex casar. O tratamento é o mais completo do repo e na ordem canônica:
  // faultstring → 429 retry → >=500 retry → >=400 permanent → ok. Aceitar `.status` sem operador
  // resolveria esta entrada e cobriria de verde todo `throw new Error(\`HTTP ${res.status}\`)`
  // decorativo, que é exatamente a forma que não decide nada.
  ['supabase/functions/omie-sync-nfes-recebidas/index.ts', 1],
]);

// DÍVIDA G6 (baselinada 2026-07-29, por CONTAGEM — mesma regra das outras): 7 sites REVELADOS
// pelo detector novo, em edges que o PR que o criou não toca. Auditar cada um exige ler o
// consumo real da resposta (nem todo fetch aqui é de paginação), e baselinar > afrouxar o
// detector: o zero honesto de hoje vale mais que o zero cosmético de ontem (§9). Chip aberto.
// Os 6 wrappers do PR que criou este gate (cmc-snapshot-backfill, cmc-snapshot-smoke,
// omie-sync-metadados, sync-reprocess, tint-omie-sync, omie-sync-vendas-items) NÃO estão aqui:
// foram corrigidos, e é isso que a ausência deles significa.
//
// ── DÍVIDA QUITADA (chip de erradicação G6). A lista chegou a ZERO: a próxima entrada aqui é
// reintrodução, não herança. Auditoria site a site — e a leitura do consumo REAL era o trabalho,
// porque dos 7 baselinados só 4 eram furo:
//  · omie-cliente (1→0) — pelo #1614, que mergeou entre a baseline e o PR que criou o gate.
//  · omie-sync (1→0) — FURO, e o mais caro. `IncluirOS` gravava a OS como "enviado" com
//    `omie_codigo_os` undefined, e `ListarClientes` via lista vazia (porta do cadastro duplicado).
//    O guard de status sozinho seria PIOR que o bug: `sync_deleted_orders` apagava o pedido de 6
//    tabelas em QUALQUER exceção, então o 5xx que antes voltava `{}` (e por acidente não deletava)
//    passaria a apagar a carteira inteira num incidente do Omie. Wrapper e consumidor foram
//    juntos: deleção agora exige prova POSITIVA de ausência (money-path §7).
//  · verify-employee (1→0) — FURO: 5xx virava o veredito "este CPF não é funcionário".
//  · omie-analytics-sync (1→0) — FURO: 5xx chegava aos laços sem total e sem lista. O transitório
//    reusa o backoff que já existia; só o esgotamento lança.
//  · analyze-unified-order (1→0) — FURO leve: o preço do Omie só preenche gap, então o efeito é
//    recall, não número fabricado. Corrigido para o motivo parar de ser invisível.
//  · omie-sync-nfes-recebidas (1→0) — NÃO era furo: tratamento completo via `classifyOmieResponse`.
//    Foi para a G6_ALLOW acima, com justificativa.
//  · omie-vendas-sync (1→0) — NÃO era furo: `if (!response.ok) throw` na ordem canônica, longe
//    demais para a janela FIXA enxergar. Quitou sozinho quando a janela virou léxica.
// E o detector consertado revelou um site novo (process-nfe), corrigido aqui em vez de baselinado:
// o ciclo do §9 — um PR conserta o detector e baselina o revelado, o outro corrige e esvazia.
const G6_DIVIDA: ReadonlyMap<string, number> = new Map([]);

describe('gate estrutural: paginação artesanal que trata falha como fim (classe #1338→#1564)', () => {
  it('sentinela: o walker anda de verdade (glob quebrado = verde eterno, ausência de sinal ≠ aprovação)', () => {
    const fontes = DIRS.flatMap((d) => listarFontes(d));
    // Piso deliberadamente FOLGADO (o repo tem ~2k fontes): se o walker quebrar e listar
    // quase nada, isto fica vermelho antes de qualquer regra "passar" por vacuidade.
    expect(fontes.length, 'walker listou fontes de menos — glob/recursão quebrada').toBeGreaterThan(500);
    expect(fontes, 'o helper das edges sumiu da varredura').toContain('supabase/functions/_shared/paginate.ts');
    expect(fontes, 'o helper de src/ sumiu da varredura').toContain('src/lib/postgrest.ts');
  });

  it('G1: nenhum `const { data } = await ....range(` descartando error além da allowlist', () => {
    const { reintroducoes, quitacoes } = desvios(contarPorArquivo(contarRegex(G1)), G1_ALLOW);
    expect(
      reintroducoes,
      `REINTRODUÇÃO da classe (F1 — error descartado na desestruturação; página que falha vira "acabou"). ` +
        `Use fetchAllPages (@/lib/postgrest), fetchAll (_shared/paginate.ts) ou desestruture { data, error } ` +
        `com throw. Arquivos (baseline→medido): ${reintroducoes.join(', ')}`,
    ).toEqual([]);
    expect(
      quitacoes,
      `contagem G1 abaixo da allowlist — atualize/remova a entrada para a lista não mascarar ` +
        `reintrodução futura: ${quitacoes.join(', ')}`,
    ).toEqual([]);
  });

  it('G1 (controle de calibração): a forma pré-fix do #1563 é detectada', () => {
    // O trecho REAL removido pelo #1563 (sync_addresses) — se o padrão G1 não casar isto,
    // o gate perdeu o dente e TODO verde dele é vácuo.
    const preFix1563 = `
        let allAddressUserIds: string[] = [];
        let addrOffset = 0;
        while (true) {
          const { data: addrPage } = await adminClient
            .from("addresses")
            .select("user_id")
            .range(addrOffset, addrOffset + 999);
          if (!addrPage || addrPage.length === 0) break;
        }`;
    expect(G1.test(preFix1563), 'G1 deixou de casar o controle pré-fix do #1563').toBe(true);
    // E o pós-fix (callback de fetchAll, sem desestruturação de data) NÃO casa:
    const posFix1563 = `
        const addressRows = await fetchAll<{ user_id: string }>(
          (from, to) =>
            adminClient
              .from("addresses")
              .select("user_id")
              .order("id", { ascending: true })
              .range(from, to),
          "sync_addresses: user_ids com endereço",
        );`;
    expect(G1.test(posFix1563), 'G1 casa o pós-fix do #1563 — falso positivo de calibração').toBe(false);
  });

  it('G3: nenhum laço `.range(` com `?? []`/`|| []` de página além da dívida baselinada', () => {
    const { reintroducoes, quitacoes } = desvios(
      contarPorArquivo(contarG3),
      new Map([...G3_ALLOW, ...G3_DIVIDA]),
    );
    expect(
      reintroducoes,
      `REINTRODUÇÃO da classe (F3 — \`?? []\` sobre página dentro de laço: data:null sem error vira ` +
        `EOF falso e o acumulado PARCIAL passa por completo). Lance em data==null ou use um helper ` +
        `canônico (fetchAllPages/fetchAll/buscarTodasPaginas/coletarPaginado/paginateAll). ` +
        `Arquivos (baseline→medido): ${reintroducoes.join(', ')}`,
    ).toEqual([]);
    expect(
      quitacoes,
      `dívida G3 quitada (total ou parcial) — ATUALIZE a baseline para ela só encolher: ${quitacoes.join(', ')}`,
    ).toEqual([]);
  });

  it('G4: nenhum total Omie confiado cru (`|| 1` / `?? 1`) além da allowlist + dívida baselinada', () => {
    const base = new Map([...G4_ALLOW, ...G4_DIVIDA]);
    const { reintroducoes, quitacoes } = desvios(contarPorArquivo(contarRegex(G4)), base);
    expect(
      reintroducoes,
      `REINTRODUÇÃO da classe (F4 — total do Omie confiado por resposta; intermediária sem o campo ` +
        `encolhe o teto e o parcial completa como 'complete'). Use validarTotalPaginas/proximoTotalPaginas/` +
        `avaliarPagina de _shared/omie-paginacao.ts. Arquivos (baseline→medido): ${reintroducoes.join(', ')}`,
    ).toEqual([]);
    expect(
      quitacoes,
      `dívida/allowlist G4 quitada (total ou parcial) — ATUALIZE a baseline para ela só encolher: ${quitacoes.join(', ')}`,
    ).toEqual([]);
  });

  it('G5: nenhum piso monotônico sem o `avaliarPagina` do mesmo laço, além da allowlist', () => {
    const { reintroducoes, quitacoes } = desvios(
      contarPorArquivo((f) => orfaosG5(f).length),
      G5_ALLOW,
    );
    expect(
      reintroducoes,
      `METADE do contrato aplicada (F5 — \`proximoTotalPaginas\` sem \`avaliarPagina\`): o teto ficou ` +
        `monotônico, mas página vazia ANTES do fim declarado continua sendo lida como fim da lista. ` +
        `Acrescente o veredito (anomalia → aborta fail-closed; fim → break). ` +
        `Arquivos (baseline→medido): ${reintroducoes.join(', ')}`,
    ).toEqual([]);
    expect(
      quitacoes,
      `excedente G5 abaixo da allowlist — atualize/remova a entrada para ela não mascarar um site ` +
        `futuro sem veredito: ${quitacoes.join(', ')}`,
    ).toEqual([]);

    // A contagem bater NÃO basta: sem checar a IDENTIDADE, corrigir o site allowlisted e criar
    // outro órfão no mesmo arquivo passaria verde (achado do challenge Codex).
    const trocas: string[] = [];
    for (const [arquivo, permitidas] of G5_ALLOW_VARS) {
      const medidas = orfaosG5(removerComentarios(readFileSync(resolve(RAIZ, arquivo), 'utf8')));
      const inesperadas = medidas.filter((v) => !permitidas.includes(v));
      if (inesperadas.length > 0) trocas.push(`${arquivo}: ${inesperadas.join(', ')}`);
    }
    expect(
      trocas,
      `SUBSTITUIÇÃO da dívida G5 — o excedente bate, mas o piso órfão é OUTRO site (a allowlist ` +
        `passaria a proteger código que ninguém auditou): ${trocas.join(' | ')}`,
    ).toEqual([]);
  });

  it('G5 (controle de calibração): meio-contrato é detectado; contrato inteiro não', () => {
    const meioContrato = `
      totalPaginas = proximoTotalPaginas(totalPaginas, result.total_de_paginas, MAX_PAGINAS_LISTAGEM);
      const produtos = result.produto_servico_cadastro || [];
      if (produtos.length === 0) break;`;
    expect(orfaosG5(meioContrato), 'G5 deixou de casar o meio-contrato').toEqual(['totalPaginas']);
    const contratoInteiro = `
      totalPaginas = proximoTotalPaginas(totalPaginas, result.total_de_paginas, MAX_PAGINAS_LISTAGEM);
      const produtos = result.produto_servico_cadastro || [];
      const veredicto = avaliarPagina(produtos.length, pagina, totalPaginas);
      if (veredicto === "anomalia") throw new Error('parcial');
      if (veredicto === "fim") break;`;
    expect(orfaosG5(contratoInteiro), 'G5 casa o contrato inteiro — falso positivo').toEqual([]);

    // O caso que derrubou a 1ª versão (por saldo): laço A sem veredito, laço B com um
    // `avaliarPagina` que não pertence a ele. Por saldo dava 0; posicionalmente A fica órfão.
    const doisLacos = `
      totalA = proximoTotalPaginas(totalA, r1.total_de_paginas, MAX_PAGINAS_LISTAGEM);
      const l1 = r1.lista || [];
      if (l1.length === 0) break;
      totalB = proximoTotalPaginas(totalB, r2.total_de_paginas, MAX_PAGINAS_LISTAGEM);
      const l2 = r2.lista || [];
      const v2 = avaliarPagina(l2.length, pagina, totalB);
      if (v2 === "fim") break;`;
    expect(
      orfaosG5(doisLacos),
      'G5 deixou o veredito do laço B satisfazer o piso do laço A (o furo da versão por saldo)',
    ).toEqual(['totalA']);

    expect(
      orfaosG5('export function proximoTotalPaginas(atual: number, declarado: number) { return 1; }'),
      'G5 contou a DEFINIÇÃO do helper como site órfão',
    ).toEqual([]);
  });

  it('G6: nenhuma resposta do Omie consumida sem checar o status HTTP, além da dívida', () => {
    const base = new Map([...G6_ALLOW, ...G6_DIVIDA]);
    const { reintroducoes, quitacoes } = desvios(contarPorArquivo(fetchsOmieSemStatus), base);
    expect(
      reintroducoes,
      `REINTRODUÇÃO da classe uma camada ACIMA do laço (F6 — resposta do Omie usada sem olhar o ` +
        `status): um 429/5xx cujo corpo parseia sem \`faultstring\` vira objeto vazio, e o laço lê ` +
        `isso como fim da lista com TODOS os guards de paginação corretos. Cheque \`res.ok\` antes ` +
        `do \`.json()\`. Arquivos (baseline→medido): ${reintroducoes.join(', ')}`,
    ).toEqual([]);
    expect(
      quitacoes,
      `dívida G6 quitada (total ou parcial) — ATUALIZE a baseline para ela só encolher: ${quitacoes.join(', ')}`,
    ).toEqual([]);
  });

  it('G6 (controle de calibração): o wrapper sem status é detectado; com status, não', () => {
    // Sem este controle o G6 seria falso-VERDE por construção — a armadilha que o #1597 pagou
    // no G4 e que o §9 registra: detector que não conhece a forma real do repo mente em silêncio.
    const semStatus = `
      const res = await fetch(\`\${OMIE_API_URL}/\${endpoint}\`, { method: "POST", body });
      const result = await res.json();
      if (result.faultstring) throw new Error("Omie");
      return result;`;
    expect(fetchsOmieSemStatus(semStatus), 'G6 deixou de casar o wrapper sem checagem').toBe(1);

    const comStatus = `
      const res = await fetch(\`\${OMIE_API_URL}/\${endpoint}\`, { method: "POST", body });
      if (!res.ok) throw new Error(\`Omie HTTP \${res.status}\`);
      const result = await res.json();
      return result;`;
    expect(fetchsOmieSemStatus(comStatus), 'G6 casa o wrapper corrigido — falso positivo').toBe(0);

    // A forma do omie-sync-vendas-items: trata 425/429 e segue. Sem o `!res.ok`, o 500 passa.
    const soAlgunsStatus = `
      const res = await fetch(OMIE_NF_URL, { method: "POST", body });
      if (res.status === 425) return { ok: false };
      if (res.status === 429) { await sleep(1); continue; }
      const data = JSON.parse(await res.text());
      return { ok: true, data };`;
    expect(
      fetchsOmieSemStatus(soAlgunsStatus),
      'G6 é frouxo demais: aceitar QUALQUER menção a .status deixa passar o tratamento parcial',
    ).toBe(0); // limitação conhecida e registrada — ver o comentário do G6.

    // Fetch que NÃO é do Omie não entra no gate (contrato diferente).
    const outroServico = `
      const res = await fetch(\`\${SUPA_URL}/rest/v1/tabela\`, { headers });
      const linhas = await res.json();`;
    expect(fetchsOmieSemStatus(outroServico), 'G6 alcançou fetch que não é do Omie').toBe(0);

    // ── Os dois erros que a JANELA FIXA cometia, fixados como controle ──────────────────────
    // (a) Falso VERDE: `.ok` de OUTRA função depois do `}` não pode valer como guard. Forma REAL
    // do process-nfe pré-fix — o `!__auth.ok` é o gate de autorização do handler, não a resposta.
    // Se este assert cair, o gate voltou a aceitar o guard errado e todo verde dele é suspeito.
    const guardDeOutraFuncao = `
      const res = await fetch(\`\${OMIE_BASE}\${endpoint}\`, { method: "POST", body });
      const text = await res.text();
      const data = JSON.parse(text);
      if (typeof data.faultstring === "string") throw new Error(\`Omie: \${data.faultstring}\`);
      return data;
}

serve(async (req) => {
  const __auth = await authorizeCronOrStaff(req);
  if (!__auth.ok) return __auth.response;`;
    expect(
      fetchsOmieSemStatus(guardDeOutraFuncao),
      'G6 aceitou o `.ok` de OUTRA função como guard da resposta (o falso-verde do process-nfe)',
    ).toBe(1);

    // (b) Falso VERMELHO: guard CORRETO longe do fetch, mas dentro da MESMA função — a forma REAL
    // do omie-vendas-sync (transcrita do arquivo), onde o retry inteiro da faultstring vive entre
    // o fetch e o `!response.ok`. Baselinar isso como dívida é registrar débito sobre código
    // correto, e lista falsa ensina a ignorar a lista.
    //
    // ⚠️ O COMPRIMENTO deste fixture é a asserção. A 1ª versão tinha 701 chars entre o fetch e o
    // guard, contra 1.942 do arquivo real — e por isso ficou VERDE quando a falsificação reduziu
    // o teto para 1200, exatamente a regressão que ele deveria pegar (o gate acusou o arquivo real
    // e o controle não sentiu nada). Fixture mais curto que o código que ele representa é um
    // detector que não conhece a forma real do repo — a armadilha do §9 aplicada ao próprio
    // controle. O assert de distância abaixo prende isso: encurtar o fixture reprova.
    const guardLongeMesmaFuncao = `
      const response = await fetch(\`\${OMIE_API_URL}/\${endpoint}\`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const result = (await response.json()) as OmieGenericResponse;

      if (result.faultstring) {
        const fs = String(result.faultstring);
        const isRateLimit = fs.includes("Já existe uma requisição desse método")
          || fs.includes("Consumo redundante")
          || fs.includes("REDUNDANT")
          || fs.includes("consumo redundante");
        const isTransient = fs.includes("SOAP-ERROR")
          || fs.includes("Broken response")
          || fs.includes("Application Server")
          || fs.includes("timeout")
          || fs.includes("Timeout");
        if (isRateLimit || isTransient) {
          if (attempt < maxRetries) {
            const waitMatch = fs.match(/Aguarde (\\d+) segundos/);
            const requestedDelay = waitMatch ? parseInt(waitMatch[1]) : (attempt + 1) * 5;
            const delay = Math.min(requestedDelay + 2, 15) * 1000;
            console.log(\`[Omie Vendas][\${account}] Rate limit, waiting \${delay/1000}s (attempt \${attempt + 1}/\${maxRetries})\`);
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
          if (opts?.throwOnTransient) {
            throw new Error(\`OMIE_TRANSIENT (\${account}): rate limit persistiu após \${maxRetries} tentativas — não dá pra afirmar ausência\`);
          }
          console.log(\`[Omie Vendas][\${account}] Transient error persists after \${maxRetries} retries, returning null\`);
          return null;
        }
        if (fs.includes("Não existem registros para a página")) {
          console.log(\`[Omie Vendas][\${account}] Nenhum registro encontrado, retornando null\`);
          return null;
        }
        throw new Error(\`Erro Omie Vendas (\${account}): \${fs}\`);
      }

      if (!response.ok) {
        const httpMessage = result?.descricao_status || \`HTTP \${response.status}\`;
        throw new Error(\`Erro Omie Vendas (\${account}): \${httpMessage}\`);
      }
      return result;`;
    const distanciaFixture = guardLongeMesmaFuncao.indexOf('!response.ok')
      - guardLongeMesmaFuncao.indexOf('await fetch(');
    expect(
      distanciaFixture,
      'fixture encurtou abaixo da distância REAL do omie-vendas-sync (1.942 chars) — ele deixaria ' +
        'de sentir uma regressão do teto, que é a única coisa que este controle mede',
    ).toBeGreaterThan(1900);
    expect(
      fetchsOmieSemStatus(guardLongeMesmaFuncao),
      'G6 ficou falso-VERMELHO sobre guard correto na mesma função (o caso omie-vendas-sync)',
    ).toBe(0);

    // (c) O guard de um fetch não cobre o do vizinho: a janela trunca no próximo `await fetch(`.
    // Sem isso, alargar a janela faria um wrapper correto absolver o wrapper de baixo.
    const doisFetchs = `
      const a = await fetch(\`\${OMIE_API_URL}/x\`, { method: "POST" });
      const da = await a.json();
      const b = await fetch(\`\${OMIE_API_URL}/y\`, { method: "POST" });
      if (!b.ok) throw new Error("Omie HTTP");
      const db = await b.json();`;
    expect(
      fetchsOmieSemStatus(doisFetchs),
      'G6 deixou o guard do 2º fetch cobrir o 1º (janela não truncou no fetch vizinho)',
    ).toBe(1);
  });

  it('G4 (controle de calibração): as DUAS formas do total cru são detectadas — inclusive com cast', () => {
    // Sem este controle o G4 é falso-VERDE por construção: a regex `\s*` original media 0 em
    // omie-financeiro (5 sites vivos) e em omie-vendas-sync porque o cast fica ENTRE o campo e
    // o `||`. "Detectou a morte" e "está quebrado" têm de ser distinguíveis (money-path §"O
    // DETECTOR mente"): estes asserts fixam o detector contra as formas REAIS do repo.
    const semCast = `      totalPaginas = result.total_de_paginas || 1;`;
    const comCast = `    totalPaginas = (result.total_de_paginas as number) || 1;`;
    const comCastBang = `    totalPaginas = (result!.total_de_paginas as number) || 1;`;
    const comCastNTot = `    totalPaginas = (result.nTotPaginas as number) || 1;`;
    const coalesce = `      const total = result.total_de_paginas ?? 1;`;
    // Quebra de linha antes do `||` — o que o formatador automático produz numa linha longa.
    // Achado Codex deste PR: a 1ª versão do endurecimento excluía `\n` e deixava passar.
    const multilinha = `    totalPaginas = (result.total_de_paginas as number)\n      || 1;`;
    for (const [rotulo, amostra] of [
      ['sem cast (forma-mãe)', semCast],
      ['com cast `as number`', comCast],
      ['com cast e non-null `!`', comCastBang],
      ['com cast, campo nTotPaginas', comCastNTot],
      ['coalesce `?? 1`', coalesce],
      ['cast + quebra de linha antes do `||`', multilinha],
    ] as const) {
      expect(G4.test(amostra), `G4 deixou de casar o controle: ${rotulo}`).toBe(true);
    }
    // E o pós-fix (piso monotônico + teto fail-fast) NÃO casa — senão o gate ficaria vermelho
    // sobre o código CORRETO e a saída seria afrouxar a regra (falso-VERMELHO, §#1483).
    const posFix = `      totalPaginas = proximoTotalPaginas(totalPaginas, result.total_de_paginas, MAX_PAGINAS_LISTAGEM);`;
    expect(G4.test(posFix), 'G4 casa o pós-fix — falso positivo de calibração').toBe(false);
    // Guard do endurecimento: o `[^;\n]` não pode atravessar statement e casar um `|| 1` de
    // OUTRA instrução (isso transformaria vizinhança inocente em ofensa).
    const doisStatements = `    const t = result.total_de_paginas; const fator = escala || 1;`;
    expect(G4.test(doisStatements), 'G4 atravessou `;` — o padrão pega statement vizinho').toBe(false);
  });

  it('G3 (controle de calibração): laço com `?? []` de página é detectado; callback de helper não', () => {
    // Forma REAL do somarSaldoPorStatus pré-fix (2026-07-23) — laço + range + coalesce:
    const lacoAfetado = `
  for (;;) {
    const { data, error } = await supabase
      .from(tabela)
      .select('saldo')
      .order('id')
      .range(from, from + PAGE - 1);
    if (error) throw new Error('x');
    const rows = (data ?? []) as Array<{ saldo: number | null }>;
    if (rows.length < PAGE) break;
  }`;
    expect(contarG3(lacoAfetado) > 0, 'G3 deixou de casar o laço-controle afetado').toBe(true);
    // Callback de fetchAllPages (sem laço local; o for vive no helper) — não casa:
    const callbackCorreto = `
  const custos = await fetchAllPages(
    (de, ate) =>
      supabase.from('product_costs').select('product_id, cost_final')
        .order('product_id', { ascending: true }).range(de, ate),
    'product_costs/exemplo',
  );
  const mapa = new Map((outraCoisa ?? []).map((x) => [x.id, x]));`;
    expect(contarG3(callbackCorreto), 'G3 casa callback de helper — falso positivo de calibração').toBe(0);
  });

  // ── DENOMINADOR: cada detector publica quanto da sua âncora ele ALCANÇA ───────────────
  //
  // A regra vem do §9 do `money-path.md`, e ela nasceu de duas reincidências do MESMO defeito:
  // o G4 daqui media 0 em arquivos com sites vivos porque `\s*` não atravessava ` as number)`,
  // e oito dias depois o `rpc-set-returning-paginacao-gate` repetiu a façanha com
  // `(supabase.rpc as RpcFn)('nome')`. Nos dois casos o gate deu VERDE por não ter procurado, e
  // nos dois a baseline de dívida deu ao número zero uma aparência de auditado.
  //
  // "Conferir se a regex conhece a forma real do repo" não tem gatilho — ninguém lembra. Contar
  // tem: a diferença entre as ocorrências CRUAS da âncora e as que o detector alcança é uma
  // subtração, e ela aparece antes de você saber qual forma escapou. Os testes abaixo publicam
  // essa subtração para cada gate e falham quando o RESTO cresce — o resto pode até ser grande,
  // desde que esteja explicado; o que não pode é aumentar sem ninguém olhar.
  //
  // Medido em 2026-08-21 sobre as 1.642 fontes varridas:
  //
  //   G1  `.range(`               129 âncoras │ 0 fora do alcance da janela de 600
  //   G3  `.range(`               129 âncoras │ veredito idêntico de 600 a 4000 (ver ANTES_G3)
  //   G4  total de páginas Omie    81 âncoras │ 5 identificadores `*pagina*` vizinhos, absolvidos
  //   G5  `proximoTotalPaginas(`   31 âncoras │ 0 — `indexOf` literal, alcance é 100% por
  //                                             construção; não há janela nem vocabulário a errar
  //   G6  `await fetch(`          122 âncoras │ 26 Omie, 96 excluídos, 11 na vizinhança do corte
  //
  // G2 não entra: ele não VARRE, é uma lista de contract-pins em arquivos nomeados. Um detector
  // sem âncora não tem denominador — e dizer isso é mais honesto que inventar um.

  function todasAsFontes(): Array<{ arquivo: string; fonte: string }> {
    const out: Array<{ arquivo: string; fonte: string }> = [];
    for (const dir of DIRS) {
      for (const arquivo of listarFontes(dir)) {
        out.push({ arquivo, fonte: removerComentarios(readFileSync(resolve(RAIZ, arquivo), 'utf8')) });
      }
    }
    return out;
  }

  it('DENOMINADOR/G1: toda âncora `.range(` está ao alcance da janela de 600', () => {
    // O G1 casa `const { data } = await …[^;]{0,600}?.range(`. Se a instrução que abre a leitura
    // ficar a mais de 600 chars — ou se não houver `;`/`{` no caminho —, o regex não chega lá e
    // o site fica invisível. Hoje isso não acontece em nenhum dos 129; o teste existe para o dia
    // em que um encadeamento longo (muitos `.order()`, muitos filtros) empurrar o início para
    // fora, que é uma mudança silenciosa: o gate não fica vermelho, ele para de olhar.
    const foraDeAlcance: string[] = [];
    for (const { arquivo, fonte } of todasAsFontes()) {
      let i = -1;
      while ((i = fonte.indexOf('.range(', i + 1)) !== -1) {
        const janela = fonte.slice(Math.max(0, i - 600), i);
        if (!janela.includes(';') && !janela.includes('{')) foraDeAlcance.push(`${arquivo} @${i}`);
      }
    }
    expect(
      foraDeAlcance,
      `\`.range(\` cuja instrução o G1 não alcança em 600 chars — o gate PAROU DE OLHAR esses ` +
        `sites (não ficou vermelho, ficou cego). Aumente a janela do G1 e re-meça: ${foraDeAlcance.join(', ')}`,
    ).toEqual([]);
  });

  it('DENOMINADOR/G3: o veredito não depende da janela — 600 a 4000 dão a MESMA lista', () => {
    // A prova de que `ANTES_G3` não foi escolhido a dedo. Um parâmetro de janela é exatamente o
    // tipo de número que se ajusta até o resultado agradar; se o veredito muda dentro da faixa,
    // o valor escolhido está decidindo o resultado e alguém precisa dizer POR QUÊ. Enquanto a
    // lista for a mesma dos 600 aos 4000, a janela não está opinando — só o padrão está.
    const fontes = todasAsFontes();
    const veredito = (janela: number): string[] => {
      const acusados: string[] = [];
      for (const { arquivo, fonte } of fontes) {
        let i = -1;
        while ((i = fonte.indexOf('.range(', i + 1)) !== -1) {
          const antes = fonte.slice(Math.max(0, i - janela), i);
          if (/\b(for|while)\s*\(/.test(antes) && /(\?\?|\|\|)\s*\[\]/.test(fonte.slice(i, i + 260))) {
            acusados.push(arquivo);
          }
        }
      }
      return [...new Set(acusados)].sort();
    };
    const referencia = veredito(ANTES_G3);
    for (const janela of [600, 900, 1600, 2400, 4000]) {
      expect(
        veredito(janela),
        `o veredito do G3 MUDA entre a janela ${ANTES_G3} e ${janela} — então o valor de ` +
          `ANTES_G3 está decidindo quem é acusado, e não o padrão. Investigue o site que entra ` +
          `ou sai antes de mexer no número.`,
      ).toEqual(referencia);
    }
  });

  /**
   * G4 — a vizinhança do VOCABULÁRIO, que é onde o G4 já se enganou uma vez.
   *
   * O gate conhece dois nomes para o total de páginas do Omie (`nTot(al)?Paginas` e
   * `total_de_paginas`). A pergunta que a regra do denominador faz é: existe algum OUTRO
   * identificador com cara de página sendo confiado cru? Estes cinco existem e foram lidos um a
   * um — nenhum é o campo cru da resposta, e é por isso que o G4 não precisa crescer:
   */
  const G4_VIZINHOS: ReadonlyMap<string, number> = new Map([
    // parâmetro do PRÓPRIO validador canônico (`validarTotalPaginas(nTot, maxPaginas)`) — o
    // `?? 1` que aparece na janela é o do `nTot`, dentro da função que existe para tratá-lo.
    ['maxPaginas', 1],
    // página INICIAL vinda do body (`omie-malha-sync`), não o total: `|| 1` aqui é o default de
    // "começa da primeira", que é o significado certo do valor ausente.
    ['desdePagina', 1],
    // idem, backfill do `omie-vendas-sync` (`params.start_page`).
    ['bfPagina', 1],
    // 3 sítios, todos derivados e não crus: em `omie-sync-nfes-recebidas` e `omie-vendas-sync` é
    // a VARIÁVEL recebendo um valor cujo lado direito o G4 já casa (`nTotalPaginas`,
    // `total_de_paginas` — ambos na dívida/allowlist); em `omie-sync-status-produtos/paginacao.ts`
    // é o PISO monotônico (`Math.max(1, p1.totalPaginas || 1)` com `if (t > piso) piso = t`),
    // que é a defesa contra a classe, não a classe.
    ['totalPaginas', 3],
  ]);

  it('DENOMINADOR/G4: nenhum identificador *pagina* NOVO confiado cru fora do vocabulário', () => {
    const medido = new Map<string, number>();
    const onde = new Map<string, Set<string>>();
    for (const { arquivo, fonte } of todasAsFontes()) {
      for (const m of fonte.matchAll(/([A-Za-z_$][\w$]*[Pp]agina[\w$]*)[^;]{0,60}?(\|\||\?\?)\s*1\b/g)) {
        const nome = m[1];
        if (/^(nTot(?:al)?Paginas|total_de_paginas)$/.test(nome)) continue; // o G4 já vigia
        medido.set(nome, (medido.get(nome) ?? 0) + 1);
        (onde.get(nome) ?? onde.set(nome, new Set()).get(nome)!).add(arquivo);
      }
    }
    const novos: string[] = [];
    for (const [nome, n] of medido) {
      const base = G4_VIZINHOS.get(nome) ?? 0;
      if (n > base) novos.push(`${nome} (${base}→${n}) em ${[...(onde.get(nome) ?? [])].join(', ')}`);
    }
    expect(
      novos,
      `identificador com cara de página confiado cru (\`|| 1\`/\`?? 1\`) que o vocabulário do G4 ` +
        `NÃO conhece. Leia cada um: se for o campo cru da resposta do Omie sob outro nome, o G4 ` +
        `precisa aprender o nome — foi assim que ele já mediu 0 com 6 sites vivos. Se for página ` +
        `inicial, piso monotônico ou parâmetro de helper, registre em G4_VIZINHOS com o porquê: ` +
        `${novos.join(' | ')}`,
    ).toEqual([]);
    const sumiram = [...G4_VIZINHOS].filter(([n, b]) => (medido.get(n) ?? 0) < b).map(([n]) => n);
    expect(sumiram, `vizinho do G4 sumiu — ATUALIZE G4_VIZINHOS: ${sumiram.join(', ')}`).toEqual([]);
  });

  /**
   * G6 — a vizinhança do CORTE de relevância.
   *
   * O G6 só inspeciona `await fetch(` que tenha "omie" nos 260 chars seguintes; os outros 96 ele
   * ignora de propósito (Supabase, Resend, Receita e LLM têm outro contrato de erro). Esse corte
   * é uma janela, e janela erra para os dois lados — a diferença é que aqui errar para MENOS não
   * deixa rastro: o gate simplesmente não olha, e a ausência de acusação parece aprovação.
   *
   * Os 11 abaixo são os que ficam entre 260 e 1000 — perto o bastante do corte para merecerem
   * leitura. Foram lidos: são `RESEND_URL`, `${SUPABASE_URL}/rest/v1/…`, `api.resend.com` e a
   * API da Receita, todos dentro de arquivos cujo NOME ou vizinhança menciona Omie. Nenhum é
   * chamada ao Omie, e alargar o corte para 1000 só traria 11 falsos positivos. O corte de 260
   * está certo; este teste é que vigia a próxima linha que cair nessa faixa.
   */
  const G6_VIZINHOS: ReadonlyMap<string, number> = new Map([
    ['supabase/functions/disparar-pedidos-aprovados/index.ts', 4],
    ['supabase/functions/enviar-pedido-portal-sayerlack/index.ts', 1],
    ['supabase/functions/fin-suggest-mapping/index.ts', 1],
    ['supabase/functions/omie-cliente/index.ts', 1],
    ['supabase/functions/omie-nfe-recebimento/index.ts', 1],
    ['supabase/functions/omie-nfe-reconcile/index.ts', 1],
    ['supabase/functions/omie-sync/index.ts', 1],
    ['supabase/functions/omie-sync-vendas-items/index.ts', 1],
  ]);

  it('DENOMINADOR/G6: a vizinhança do corte de 260 não cresce sem alguém ler', () => {
    const medido = new Map<string, number>();
    for (const { arquivo, fonte } of todasAsFontes()) {
      let i = -1;
      while ((i = fonte.indexOf('await fetch(', i + 1)) !== -1) {
        if (/omie/i.test(fonte.slice(i, i + 260))) continue; // o G6 já inspeciona
        if (/omie/i.test(fonte.slice(i, i + 1000))) medido.set(arquivo, (medido.get(arquivo) ?? 0) + 1);
      }
    }
    const { reintroducoes, quitacoes } = desvios(medido, G6_VIZINHOS);
    expect(
      reintroducoes,
      `\`await fetch(\` com "omie" logo depois do corte de 260 — o G6 NÃO olha esses. Leia: se ` +
        `for chamada ao Omie, o corte precisa crescer (e aí 11 não-Omie entram junto, então o ` +
        `filtro tem de ficar mais esperto, não mais largo). Se não for, registre em G6_VIZINHOS: ` +
        `${reintroducoes.join(', ')}`,
    ).toEqual([]);
    expect(
      quitacoes,
      `vizinho do G6 sumiu — ATUALIZE G6_VIZINHOS para ele só encolher: ${quitacoes.join(', ')}`,
    ).toEqual([]);
  });

  it('DENOMINADOR/G5: a âncora é literal, então o alcance é 100% por construção', () => {
    // G5 acha `proximoTotalPaginas(` com `indexOf` — não há janela nem vocabulário entre a âncora
    // e o detector, logo não há resto possível. O que ele pode perder é o helper chamado por
    // ALIAS, e isso o teste abaixo mede: hoje os aliases são todos variáveis que RECEBEM o
    // retorno (`const totalPaginas = proximoTotalPaginas(...)`), não nomes alternativos da
    // função. Um `const p = proximoTotalPaginas; p(x)` seria invisível — nunca aconteceu, e se
    // acontecer é aqui que aparece.
    const reexportado: string[] = [];
    for (const { arquivo, fonte } of todasAsFontes()) {
      for (const m of fonte.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*proximoTotalPaginas\s*[;,\n]/g)) {
        reexportado.push(`${arquivo}: ${m[1]}`);
      }
    }
    expect(
      reexportado,
      `\`proximoTotalPaginas\` guardado em variável SEM chamar — o G5 procura o nome literal e ` +
        `ficaria cego a \`${'${alias}'}(...)\`. Chame o helper pelo nome: ${reexportado.join(', ')}`,
    ).toEqual([]);
  });

  // ── G2: contract-pins — os helpers canônicos mantêm o contrato que a classe exige ────
  // Cada pin ancora numa string EXCLUSIVA do ramo que protege (ASCII no que o assert
  // exige, caixa fixa, sem -i — lição #1483). Se alguém "simplificar" um helper de volta
  // ao `?? []`, é aqui que fica vermelho — não em produção três semanas depois.
  const pins: Array<{ arquivo: string; presente: RegExp; motivo: string }> = [
    {
      arquivo: 'supabase/functions/_shared/paginate.ts',
      presente: /if \(data == null\) throw new Error\(`\$\{label\}: data null sem error/,
      motivo: 'fetchAll voltaria a converter data:null em pagina vazia (EOF falso)',
    },
    {
      arquivo: 'src/lib/scoring/rpcPaginada.ts',
      presente: /throw new Error\(`\$\{rotulo\} pág\.\$\{pagina\}: data null sem error/,
      motivo: 'coletarPaginado voltaria a converter data:null em pagina vazia (EOF falso)',
    },
    {
      arquivo: 'supabase/functions/calculate-scores/index.ts',
      presente: /if \(data == null\) throw new Error\(`\$\{fn\} pág\.\$\{pg\}: data null sem error/,
      motivo: 'o espelho carregarRpcPaginada voltaria a engolir data:null (o src/ lança e o edge nao)',
    },
    {
      arquivo: 'src/services/financeiroService.ts',
      presente: /if \(data == null\) throw new Error\(`Falha ao carregar \$\{contexto\}: data=null sem error/,
      motivo: 'buscarTodasPaginas perderia o fix do #1564 (o ?? [] fechava o laco parcial)',
    },
    {
      arquivo: 'src/lib/postgrest.ts',
      presente: /devolveu data null sem error/,
      motivo: 'fetchAllPages perderia a rejeicao de resposta malformada (#1550/#1560)',
    },
    {
      arquivo: 'src/hooks/unifiedOrder/catalog-helpers.ts',
      presente: /throw new Error\(\s*`paginateAll: teto de maxPages atingido/,
      motivo: 'paginateAll voltaria a RETORNAR o parcial ao esgotar o teto (#1562, money-path §8)',
    },
    // ── Continuação #1581 (edges scoring/carteira/batch) — laços LOCAIS remanescentes.
    // Achado Codex P2 do PR: sem pin, reverter um guard `data == null` destes laços passaria
    // verde em G1/G3/VIGIADAS_ORDER (a forma `if (!data) break` não tem regra automatizada —
    // ver o comentário F2 acima). Âncora em trecho ASCII, caixa fixa, exclusivo do ramo (#1483).
    {
      arquivo: 'supabase/functions/carteira-rebuild/index.ts',
      presente: /if \(data == null\) \{ console\.error\('\[carteira-rebuild\] load aliases: data null sem error'\); return await failLease\('aliases: data null sem error/,
      motivo: 'aliases: data:null sem error voltaria a encerrar o laco com aliasMap PARCIAL (clone re-exposto)',
    },
    {
      arquivo: 'supabase/functions/carteira-rebuild/index.ts',
      presente: /if \(data == null\) \{ console\.error\('\[carteira-rebuild\] load ledger: data null sem error'\); return await failLease\('ledger: data null sem error/,
      motivo: 'ledger: membroIds truncado engana ate a pos-condicao D4 (ela compara contra o conjunto truncado)',
    },
    {
      arquivo: 'supabase/functions/carteira-rebuild/index.ts',
      presente: /if \(data == null\) \{ console\.error\('\[carteira-rebuild\] load proof oben: data null sem error'\); return await failLease\('proof oben: data null sem error/,
      motivo: 'proof oben: truncada rebaixaria membro a orfao/Hunter em massa',
    },
    {
      arquivo: 'supabase/functions/carteira-rebuild/index.ts',
      presente: /if \(data == null\) \{ console\.error\('\[carteira-rebuild\] load flaggeds: data null sem error'\); return await failLease\('flaggeds: data null sem error/,
      motivo: 'flaggeds: truncado re-elegeria fornecedor excluido da carteira',
    },
    {
      arquivo: 'supabase/functions/sinais-batch/index.ts',
      presente: /if \(data == null\) \{\s*\n\s*return new Response\(JSON\.stringify\(\{ ok: false, error: `farmer_calls /,
      motivo: 'sinais-batch: data:null sem error voltaria a fechar a varredura PARCIAL como completa',
    },
    {
      arquivo: 'supabase/functions/ai-ops-agent/index.ts',
      presente: /if \(aPage == null\) throw new Error\(`carteira_assignments /,
      motivo: 'keyset do ownerMap: data:null sem error truncaria o mapa e as decisoes sairiam com farmer_id null',
    },
    // Ordem COMPOSTA (chave total) pinada onde UMA coluna não é única (achado Codex P2:
    // VIGIADAS_ORDER só exige ALGUM .order — remover o desempate passaria verde).
    {
      arquivo: 'supabase/functions/sinais-batch/index.ts',
      presente: /\.order\('started_at', \{ ascending: false \}\)\s*\n\s*\.order\('id', \{ ascending: true \}\)/,
      motivo: 'sem o desempate por id, started_at empatado pula/duplica linhas entre paginas',
    },
    {
      arquivo: 'supabase/functions/tactical-plans-batch/index.ts',
      presente: /\.order\('customer_user_id', \{ ascending: true \}\)\s*\n\s*\.range\(from, to\)/,
      motivo: 'a chave do batch tem de ser customer_user_id (UNIQUE e IMUTAVEL) imediatamente antes do range',
    },
  ];

  for (const pin of pins) {
    it(`G2 pin: ${pin.arquivo} mantém o contrato (${pin.motivo})`, () => {
      const fonte = removerComentarios(readFileSync(resolve(RAIZ, pin.arquivo), 'utf8'));
      expect(pin.presente.test(fonte), `sumiu o guard: ${pin.motivo}`).toBe(true);
    });
  }

  it('G2 anti-regressão: nenhum helper canônico de paginação volta ao `?? []`/`|| []` sobre a página', () => {
    // Só os arquivos-helper (a forma é legítima noutros contextos, ex. mapear resultado
    // de RPC single-shot). Nos helpers de paginação ela é SEMPRE o furo do EOF falso.
    const helpers = [
      'supabase/functions/_shared/paginate.ts',
      'src/lib/scoring/rpcPaginada.ts',
      'src/lib/postgrest.ts',
    ];
    for (const arquivo of helpers) {
      const fonte = removerComentarios(readFileSync(resolve(RAIZ, arquivo), 'utf8'));
      expect(
        /\bdata\s*(\?\?|\|\|)\s*\[\]/.test(fonte),
        `${arquivo}: voltou o \`data ?? []\` — data:null sem error viraria EOF falso de novo`,
      ).toBe(false);
    }
  });

  it('G2 anti-sabotagem: TODO ramo `x == null` dos arquivos pinados ABORTA (nunca break/continue)', () => {
    // Achado Codex (2×). Primeira rodada: `if (data == null) break;` ANTES do
    // `if (data == null) throw ...` satisfaria o pin de PRESENÇA com o throw morto.
    // Segunda rodada (challenge deste PR): a versão anterior deste teste cobria só 5 arquivos e
    // só a variável literal `data` — deixava de fora carteira-rebuild, sinais-batch e o keyset do
    // ai-ops-agent (que usa `aPage`), justamente os 6 pins novos. Um `break` inserido lá passava
    // verde em G1, G3, VIGIADAS_ORDER e no pin de presença.
    //
    // A regra NÃO pode ser "nenhum return": os guards CORRETOS de carteira-rebuild e sinais-batch
    // abortam com `return await failLease(...)` / `return new Response(...)`. O invariante real é
    // que o ramo ABORTE — throw, failLease ou Response de erro. `break`/`continue` (e `return` nu)
    // continuam a leitura como se a página malformada fosse fim.
    const pinados = [
      'supabase/functions/_shared/paginate.ts',
      'src/lib/scoring/rpcPaginada.ts',
      'supabase/functions/calculate-scores/index.ts',
      'src/services/financeiroService.ts',
      'src/lib/postgrest.ts',
      'supabase/functions/carteira-rebuild/index.ts',
      'supabase/functions/sinais-batch/index.ts',
      'supabase/functions/ai-ops-agent/index.ts',
    ];
    // Nomes de página realmente usados nestes laços (não um `\w+` solto, que casaria
    // comparações de domínio como `if (cod == null)` e daria falso-VERMELHO).
    const VARS = /if\s*\(\s*(data|aPage|sPage|page|batch|batch2|rows|linhas)\s*==\s*null\s*\)/g;
    // O predicado é de ORDEM, não de presença — e isto NÃO é sofisticação gratuita: a primeira
    // versão perguntava "existe break na janela?" e ficou vermelha no baseline em paginate.ts e
    // financeiroService.ts, porque a janela alcançava o `break` LEGÍTIMO do fim-de-página
    // (`if (rows.length < PAGE) break`) que vem 3 linhas abaixo do guard. Assert que mede além do
    // ramo é falso-VERMELHO (irmão do que mede prosa — §"O ALVO mente"). O que importa é o que
    // vem PRIMEIRO depois do `if (x == null)`: se for abortar, o guard está vivo; se for
    // break/continue, o aborto pinado logo abaixo é código morto.
    const ABORTO = /\bthrow\b|failLease\s*\(|new Response\s*\(/;
    const ENGOLE = /\b(break|continue)\b/;
    const ofensas: string[] = [];
    for (const arquivo of pinados) {
      const fonte = removerComentarios(readFileSync(resolve(RAIZ, arquivo), 'utf8'));
      for (const m of fonte.matchAll(VARS)) {
        const ramo = fonte.slice(m.index!, m.index! + 240);
        const iAborto = ramo.search(ABORTO);
        const iEngole = ramo.search(ENGOLE);
        if (iAborto < 0) {
          ofensas.push(`${arquivo}: \`${m[0]}\` não aborta (sem throw/failLease/Response)`);
        } else if (iEngole >= 0 && iEngole < iAborto) {
          ofensas.push(`${arquivo}: \`${m[0]}\` ENGOLE (break/continue ANTES do aborto)`);
        }
      }
    }
    expect(
      ofensas,
      `ramo de página malformada que NÃO aborta — o throw/failLease pinado vira código morto e ` +
        `data:null volta a ser lido como fim da lista: ${ofensas.join(' | ')}`,
    ).toEqual([]);
  });

  it('G2: a chave de paginação do tactical-plans-batch não volta a ser o `farmer_id` (MUTÁVEL)', () => {
    // Achado do challenge /codex, confirmado em prod: o trigger trg_carteira_reconcile_score_owner
    // faz `SET farmer_id = EXCLUDED.farmer_id` em farmer_client_scores a cada mudança de dono, e o
    // carteira-rebuild roda 07:30 UTC — 30min ANTES deste batch. Ordenar por (farmer_id, ...) é
    // ordem TOTAL mas não ESTÁVEL: a linha que troca de farmer entre dois offsets muda de posição
    // e some (cliente sem plano) ou duplica (disputa o TOP_N 2×). Um pin de presença de
    // `.order('customer_user_id')` não barra alguém REACRESCENTAR o farmer_id antes dele — por
    // isso este é um pin de AUSÊNCIA. Total ≠ estável: a chave tem de ser IMUTÁVEL.
    const fonte = removerComentarios(
      readFileSync(resolve(RAIZ, 'supabase/functions/tactical-plans-batch/index.ts'), 'utf8'),
    );
    expect(
      /\.order\(\s*['"]farmer_id['"]/.test(fonte),
      'voltou o .order(farmer_id): coluna MUTÁVEL na chave de paginação — o trigger de carteira ' +
        'move a linha entre páginas e o cliente some ou duplica no TOP_N',
    ).toBe(false);
  });
});
