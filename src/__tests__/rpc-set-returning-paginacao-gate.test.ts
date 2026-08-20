import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

/**
 * Gate: RPC **set-returning** chamada do frontend precisa PAGINAR.
 *
 * A capa de 1.000 linhas do PostgREST vale para `.rpc()` exatamente como vale para `.from()`,
 * e é SILENCIOSA: a resposta capada é indistinguível de "acabou". `fetchAllPages` só protege
 * quem passa por ele, então a RPC crua é o ponto cego — e a varredura que paginou as TABELAS
 * não alcança RPC nenhuma. Já mordeu duas vezes, nas duas o motor parecia funcionar:
 *
 *   #1782 `get_skus_margem_positiva` (2.462 linhas) — gate de EXCLUSÃO: perdida a cauda, o lote
 *         sai vazio, o writer pula a gravação de propósito e `farmer_bundle_recommendations`
 *         CONGELA. Sem erro, sem toast.
 *   #1765→este `get_carteira_margem_faixa` (1.227 linhas) — 227 clientes caem fora do Map e
 *         viram `margemFaixa: 'neutro'` com o health score renormalizado: veredito FABRICADO,
 *         indistinguível de "margem não apurável".
 *
 * Em ambos a defesa existente cobria o vazio TOTAL (erro de transporte, `data: null`) e era
 * cega ao vazio PARCIAL. É o §6 do money-path: um universo lido pela metade produz um
 * resultado que PARECE completo.
 *
 * COMO ESTE GATE FUNCIONA. A fonte da verdade de "quem é set-returning" é o próprio
 * `types.ts` gerado do schema (`Returns: {...}[]`), então RPC nova entra sozinha na vigilância
 * — não há lista para alguém esquecer de atualizar.
 *
 * A BASELINE abaixo é dívida ENUMERADA, não aprovada, e o gate impede a lista de CRESCER e
 * obriga a encolher: entrada que some do código tem de sair daqui também.
 *
 * Quando o gate nasceu (2026-08-19) as 23 entradas tinham um motivo honesto porém CEGO —
 * `claude_ro` não tem EXECUTE nessas funções, então o universo de cada uma era desconhecido, e
 * paginar no escuro mudaria comportamento de reposição/financeiro/pricing sem prova. Em
 * 2026-08-20 esse motivo caiu para 15 delas: dá para medir sem EXECUTE, lendo
 * `pg_get_functiondef` e reproduzindo o corpo como SELECT sobre a prod (psql-ro). Duas passaram
 * a paginar e saíram; as outras trocaram o palpite por um teto com prova. Sobraram 8 sem número
 * — marcadas `nao_medido`, não "provavelmente pequeno", que seria o `Number(null)===0` da
 * apuração.
 *
 * ⚠️ AS 8 ERAM AS QUE TINHAM `LIMIT` NO CORPO — e o `LIMIT` foi o disfarce, não a proteção.
 * Medidas (2026-08-20, 2ª fatia), cinco tinham LIMIT constante mesmo e uma precisou de
 * contagem; as outras duas eram as que o `LIMIT` escondia, cada uma de um jeito:
 *
 *   `carteira_por_municipio` — o `LIMIT 1` do corpo é do `SELECT … INTO` que resolve o NOME do
 *       município. O `RETURN QUERY` não tem LIMIT nenhum. Teto = dado, e o dado é 1.014 em
 *       DIVINÓPOLIS/MG: acima da capa. Não era risco futuro, estava truncando — 14 clientes da
 *       carteira sumiam do planejamento de rota, em silêncio, exatamente como no #1765. PAGINA.
 *
 *   `radar_prospects_para_rota` — `LIMIT GREATEST(1, LEAST(p_limit, 2000))`, e o caller passa
 *       `PROSPECTS_POR_CIDADE = 1000`. Teto EXATAMENTE igual à capa, que é o pior lugar para um
 *       teto estar: nada se perde hoje (1.000 pedidos = 1.000 entregues), então nenhum sintoma
 *       aponta para cá, e o número que separa "correto" de "trunca em silêncio" é uma const TS
 *       que sobe com um caractere — sem migration, sem SQL Editor, sem ritual. E há para onde
 *       subir: 80 municípios têm ≥1.000 prospects elegíveis, São Paulo tem 25.512. PAGINA.
 *
 * A lição que sobra é sobre a EVIDÊNCIA, não sobre `LIMIT`: "tem LIMIT no corpo" descreve o
 * texto da função, não o número de linhas que ela devolve. As duas só se separaram das outras
 * seis quando alguém contou.
 *
 * ⚠️ Estar na baseline NÃO é atestado de segurança, e o waiver não é texto livre: cada entrada
 * declara a PROVA do teto e, quando essa prova envelhece (medição em dados), um PRAZO. O que
 * mora aqui é uma chamada que o gate CONSEGUE ver — durante um tempo o scanner só reconhecia
 * `.rpc('…')` com aspas simples, e a própria frase "a baseline enumera a dívida" era falsa.
 */

const RAIZ = resolve(__dirname, '../..');

/** Comentário entre `.rpc()` e `.range()` é ruído — e neste repo ele é LONGO de propósito. */
function semComentarios(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/[^\n]*/gm, '');
}

/** Nomes cujo `Returns` no types.ts é ARRAY — só esses sofrem a capa de linhas. */
export function nomesSetReturning(types: string): Set<string> {
  const nomes = new Set<string>();
  for (const m of types.matchAll(/^ {6}(\w+): \{\s*$/gm)) {
    const trecho = types.slice(m.index!, m.index! + 2500);
    const fim = trecho.indexOf('\n      }');
    const corpo = fim > 0 ? trecho.slice(0, fim) : trecho;
    if (/Returns:[\s\S]*?\}\[\]/.test(corpo) || /Returns:\s*\w+\[\]/.test(corpo)) nomes.add(m[1]);
  }
  for (const m of types.matchAll(/^ {6}(\w+): \{[^\n]*Returns:\s*[^;\n}]*\[\][^\n]*\}/gm)) nomes.add(m[1]);
  return nomes;
}

/**
 * Chamadas `.rpc('nome')` de função set-returning SEM `.range()` à vista.
 * Puro de propósito: é o que as fixtures abaixo falsificam sem tocar arquivo real.
 */
export function chamadasSemPaginacao(fonte: string, setReturning: Set<string>): string[] {
  const txt = semComentarios(fonte);
  const achados: string[] = [];
  // ASPAS SIMPLES **OU DUPLAS**. O regex original só via `'` e por isso deixava passar
  // `supabase.rpc("nome")` — que não é hipótese: `src/` tem 10 chamadas assim, duas delas
  // set-returning (`fin_projecao_13_semanas` em CaixaCompraCard, `ciclo_oportunidade_do_dia`
  // em AdminReposicaoOportunidades). Enquanto o furo existiu, a frase "a baseline enumera a
  // dívida" era FALSA: o gate não olhava para o universo inteiro que dizia vigiar, e o
  // veredito verde vinha de não ter procurado — a versão-scanner do `Number(null)===0`.
  // (Achado do Codex xhigh na revisão daquele PR; conferido com `git grep '\.rpc("'`.)
  //
  // E o `(` COLADO em `.rpc` era a MESMA cegueira num segundo disfarce, encontrado ao medir a
  // 2ª fatia (2026-08-20). O idioma deste repo para RPC ainda não tipada é o cast:
  //
  //     await (supabase.rpc as RpcFn)('nome', params)
  //     await (supabase.rpc as (fn: string, a: unknown) => ReturnType<typeof supabase.rpc>)('nome', p)
  //
  // — 22 das 108 ocorrências de `.rpc` em `src/` (fonte que o gate lê: sem testes/types.ts, comentários já removidos) escapavam ao regex antigo, e duas delas eram
  // set-returning e estavam FORA da baseline: `radar_contagem_por_municipio` em
  // useRadarContagemMunicipios.ts e `buscar_skus_candidatos` em useProductSpecLink.ts. Ambas
  // com teto estrutural — mas isso o gate não sabia, porque nunca as viu. Enumerar dívida com
  // um scanner que não alcança o idioma dominante do repo é contar o que é fácil de contar.
  //
  // Por isso a tolerância entre `.rpc` e o literal deixou de ser "nada" e passou a ser "até 200
  // caracteres", com a checagem de verdade no `types.ts`: o nome tem de ser uma função
  // set-returning REAL. É o que segura o falso positivo — uma string arbitrária dentro da
  // janela não vira achado por acaso; ela teria de coincidir com o nome de uma RPC que devolve
  // ARRAY. Nome dinâmico (`.rpc(fn, params)`, como em `services/pcp-apontamento.ts`) continua
  // invisível e é limite CONHECIDO: não há literal para casar, e inventar heurística de fluxo
  // aqui daria falsa cobertura — vigiar por nome é o contrato deste gate.
  const RE_RPC = /\.rpc\b[\s\S]{0,200}?(?:'([a-z0-9_]+)'|"([a-z0-9_]+)")/g;
  for (const m of txt.matchAll(RE_RPC)) {
    const nome = m[1] ?? m[2];
    if (!setReturning.has(nome)) continue;
    // A janela do `.range()` conta a partir do FIM do match, não do início: com o cast, o
    // próprio match já consome até 200 caracteres, e medir da abertura encurtaria a busca
    // justamente nas chamadas mais verbosas — que são as que este trecho passou a enxergar.
    const depois = m.index! + m[0].length;
    if (!/\.range\(/.test(txt.slice(depois, depois + 400))) achados.push(nome);
  }
  return achados;
}

function arquivosFonte(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) {
      if (n !== 'node_modules' && n !== '__tests__') arquivosFonte(p, out);
    } else if (/\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n) && !p.endsWith('types.ts')) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Folga mínima para uma chamada MEDIDA continuar sem paginar: metade da capa.
 *
 * Abaixo de 500 o universo precisa DOBRAR para romper os 1.000. Nas séries que medi o
 * crescimento é de ~14% ao ano no pior caso — anos de margem, e um intervalo que cabe numa
 * re-medição. Acima disso a distância vira uma safra de dados e o modo de falha não avisa.
 * Foi por esta régua que `fin_analise_cp_dimensoes_rpc` saiu daqui: 877 medidos, 88% da capa.
 * (O Codex propôs 80%; recusado por ser folga de 1,25× — uma única safra de 14% consome
 * metade dela e o waiver continuaria verde.)
 */
const FOLGA_MINIMA = 500;

/**
 * Por que uma chamada pode ficar sem `.range()`. Não é texto livre: cada forma carrega a
 * PROVA e, quando a prova envelhece, um PRAZO — um waiver que só o autor sabe interpretar é
 * indistinguível de nenhum waiver.
 *
 * `estrutural` — a DEFINIÇÃO da função limita as linhas (`FOR i IN 0..12`, `UNION ALL` de
 *   agregados, `RETURN NEXT` fora de laço, `WHERE id = ANY(arr)` com o caller passando `[id]`).
 *   NÃO expira, e a diferença é de mecanismo, não de gosto: dado cresce sozinho, todo dia, sem
 *   ninguém decidir nada; definição só muda por `CREATE OR REPLACE`, que neste repo passa pelo
 *   ritual de migration + SQL Editor. O que protege o teto estrutural é aquele ritual, não um
 *   prazo aqui. (O Codex pediu um `definitionHash` que revalidasse o estrutural. RECUSADO: o
 *   gate roda no CI SEM banco, então o hash só poderia ser do arquivo de migration — e neste
 *   repo a prod DIVERGE do repo por apply manual, o próprio motivo de o CLAUDE.md mandar
 *   conferir `pg_get_functiondef` antes de qualquer replace. O hash daria verde com a prod já
 *   mudada e vermelho num refactor de migration que não mudou a prod: falsa precisão nos dois
 *   sentidos.)
 *
 * `medido` — contei o pior caso sobre os valores REAIS de parâmetro na prod. É uma fotografia:
 *   verdadeira no dia, e por isso tem `medidoEm` + `revisarAte`. Vencido o prazo, o gate
 *   reprova até alguém re-rodar a contagem que está em `prova`.
 *
 * `nao_medido` — dívida honesta: não sei o universo. Prazo mais CURTO que o do medido, porque
 *   é a pior das três e a única que não tem número nenhum por trás.
 */
type Waiver =
  | { tipo: 'estrutural'; teto: number; prova: string }
  | { tipo: 'medido'; teto: number; prova: string; medidoEm: string; revisarAte: string }
  | { tipo: 'nao_medido'; bloqueio: string; revisarAte: string };

/**
 * A dívida que existia quando o gate nasceu (2026-08-19), agora com o teto de cada entrada.
 *
 * Ao nascer, o gate registrou as chamadas com um motivo honesto porém cego: `claude_ro` não tem
 * EXECUTE nessas funções, logo o universo era desconhecido. Em 2026-08-20 medi 15 delas por
 * outra via — `pg_get_functiondef` + reprodução do corpo como SELECT sobre a prod (psql-ro).
 * Duas ganharam paginação e saíram (`fin_analise_c{p,r}_dimensoes_rpc`); as demais trocaram o
 * palpite por um número. Nenhuma linha aqui diz "universo provavelmente pequeno": ou tem prova,
 * ou está marcada `nao_medido`.
 */
const BASELINE = new Map<string, Waiver>([
  // ── Teto ESTRUTURAL: a definição limita, medido em 2026-08-20 ───────────────────────────
  ['fin_projecao_13_semanas @ src/hooks/dashboard/useFinanceiroZone.ts',
    { tipo: 'estrutural', teto: 13, prova: '`FOR i IN 0..12 LOOP … RETURN NEXT` — 13 linhas, sempre' }],
  ['fin_projecao_13_semanas @ src/components/reposicao/pedidos/CaixaCompraCard.tsx',
    { tipo: 'estrutural', teto: 13, prova: 'mesma função do hook acima; entrou na lista quando o scanner passou a ver `.rpc("…")`' }],
  ['fin_consolidado_intercompany @ src/pages/FinanceiroIntercompany.tsx',
    { tipo: 'estrutural', teto: 4, prova: '`UNION ALL` de 4 SELECTs agregados sem GROUP BY' }],
  ['fin_estimar_estoque_omie @ src/hooks/useEstoqueValor.ts',
    { tipo: 'estrutural', teto: 1, prova: 'um SELECT agregado (SUM/COUNT) sem GROUP BY' }],
  ['get_whatsapp_funil @ src/hooks/useWhatsappFunil.ts',
    { tipo: 'estrutural', teto: 1, prova: 'SELECT de subqueries escalares, sem FROM' }],
  ['get_data_health @ src/hooks/useDataHealth.ts',
    { tipo: 'estrutural', teto: 25, prova: 'CTE `checks` = 25 ramos UNION ALL, 1 linha cada; o único ramo com JOIN é limitado por `sync_state` (26 linhas)' }],
  ['gerar_pedidos_sugeridos_ciclo @ src/pages/AdminReposicaoPedidos.tsx',
    { tipo: 'estrutural', teto: 1, prova: '`RETURN QUERY SELECT v_pedidos, v_skus, v_valor, v_bloqueados` — variáveis, sem FROM' }],
  ['reverter_run_auto @ src/hooks/useParamAutoMudancas.ts',
    { tipo: 'estrutural', teto: 1, prova: 'um `RETURN NEXT` fora de laço' }],
  ['ciclo_oportunidade_do_dia @ src/pages/AdminReposicaoOportunidades.tsx',
    { tipo: 'estrutural', teto: 1, prova: 'dois `RETURN QUERY SELECT <escalares>` em ramos exclusivos (o primeiro seguido de `RETURN;`)' }],
  ['staff_get_sales_order_payload @ src/components/salesOrderEdit/useSalesOrderEdit.ts',
    { tipo: 'estrutural', teto: 1, prova: '`WHERE id = ANY(p_order_ids)` e o caller passa `[id]`' }],
  ['staff_get_sales_order_payload @ src/components/salesOrders/useSalesOrderDetail.ts',
    { tipo: 'estrutural', teto: 1, prova: '`WHERE id = ANY(p_order_ids)` e o caller passa `[id]`' }],

  // ── Teto MEDIDO nos dados: pior caso sobre os parâmetros reais ──────────────────────────
  ['get_ultimos_precos_cliente @ src/hooks/unifiedOrder/useCustomerSelection.ts',
    { tipo: 'medido', teto: 407, medidoEm: '2026-08-20', revisarAte: '2027-08-20',
      prova: 'SELECT customer_user_id, count(DISTINCT product_id) FROM order_items oi JOIN sales_orders so ON so.id=oi.sales_order_id (mesmos filtros da função: deleted_at IS NULL, status NOT IN (cancelado,orcamento), unit_price>0) GROUP BY 1 ORDER BY 2 DESC — máx 407' }],
  ['get_whatsapp_proposta_cotacao @ src/pages/RotaPropostas.tsx',
    { tipo: 'medido', teto: 412, medidoEm: '2026-08-20', revisarAte: '2027-08-20',
      prova: 'devolve ≤ |p_skus|, e a cesta é principal (⊆ SKUs já comprados pelo cliente, ≤407 pela contagem acima) + 3 secundários + MAX_CROSS_SELL=2' }],
  ['staff_get_sales_order_payload @ src/pages/SalesPrintDashboard.tsx',
    { tipo: 'medido', teto: 68, medidoEm: '2026-08-20', revisarAte: '2027-08-20',
      prova: 'o lote é o de UM dia (o caller filtra created_at entre dayStart/dayEnd); SELECT date(created_at), count(*) FROM sales_orders GROUP BY 1 ORDER BY 2 DESC — pior dia da história = 68' }],
  ['list_impersonation_targets @ src/hooks/useImpersonationTargets.ts',
    { tipo: 'medido', teto: 3, medidoEm: '2026-08-20', revisarAte: '2027-08-20',
      prova: 'SELECT count(DISTINCT owner_user_id) FROM carteira_assignments = 3' }],

  // ── 2ª fatia (2026-08-20): o `LIMIT` no corpo virou NÚMERO. Das 8, cinco tinham LIMIT
  //    constante de verdade, uma precisou de contagem, e duas foram PAGINAR — ver o rodapé.
  ['fin_regua_condicao_prazo @ src/hooks/useCustoPrazoRegua.ts',
    { tipo: 'estrutural', teto: 1, prova: '`LIMIT 1` constante no `RETURN QUERY` (busca a condição de pagamento por `codigo`+`empresa`)' }],
  ['reposicao_pos_marcador @ src/pages/AdminReposicaoPedidos.tsx',
    { tipo: 'estrutural', teto: 1, prova: '`FROM (SELECT 1) AS sempre LEFT JOIN LATERAL (… ORDER BY seq DESC LIMIT 1)` — o lado esquerdo tem 1 linha e o LEFT JOIN preserva-a, então devolve exatamente 1 (o "sem marcador" vem como NULL, não como zero linhas)' }],
  ['listar_pedidos_a_separar @ src/queries/usePedidosASeparar.ts',
    { tipo: 'estrutural', teto: 100, prova: '`LIMIT 100` constante no `RETURN QUERY`' }],
  ['get_whatsapp_pendentes @ src/hooks/useWhatsappPendentes.ts',
    { tipo: 'estrutural', teto: 500, prova: '`LIMIT 500` constante (função SQL pura); o universo hoje é 0 — a janela é `last_inbound_at > now() - 24h` sem resposta' }],
  ['radar_contagem_por_municipio @ src/queries/useRadarCidadesRota.ts',
    { tipo: 'estrutural', teto: 500, prova: '`LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 500), 2000))` nos DOIS ramos (fast e slow path) e o caller passa a constante literal `p_limit: 500`' }],
  // ── Chamadas que o scanner só passou a ENXERGAR em 2026-08-20, quando aprendeu a ler o cast
  //    `(supabase.rpc as RpcFn)('nome')`. Estavam no código o tempo todo, fora da baseline.
  ['radar_contagem_por_municipio @ src/queries/useRadarContagemMunicipios.ts',
    { tipo: 'estrutural', teto: 500, prova: 'mesma função da entrada acima, mesmo `LEAST(p_limit, 2000)`; este caller também passa a constante `p_limit: 500` (com os filtros do Radar, que só REDUZEM o conjunto)' }],
  ['buscar_skus_candidatos @ src/hooks/useProductSpecLink.ts',
    { tipo: 'estrutural', teto: 100, prova: '`LIMIT 100` constante no `RETURN QUERY` sobre `omie_products`' }],

  // ── Teto MEDIDO nos dados: 2ª fatia ────────────────────────────────────────────────────
  ['reposicao_pos_candidatos @ src/pages/AdminReposicaoPedidos.tsx',
    { tipo: 'medido', teto: 101, medidoEm: '2026-08-20', revisarAte: '2027-08-20',
      prova: 'MONEY-PATH. O único LIMIT do corpo é o `LIMIT 1` da CTE `marcador`; o `RETURN QUERY` não tem teto, então é dado. `SELECT upper(btrim(empresa)), count(*) FROM pedido_compra_sugerido WHERE status IN (disparado, aprovado_aguardando_disparo) AND omie_pedido_compra_id IS NOT NULL AND btrim(omie_pedido_compra_id) <> \'\' GROUP BY 1` — máx 101 (OBEN; COLACOR, a outra da enum `empresa_reposicao`, tem 0). É TETO SUPERIOR: os filtros `ls.run_id <> m.run_id` e `omie_po_inexistente_antes_de <= m.finalizado_em` só reduzem. Sem o filtro de status são 109, e a tabela INTEIRA tem 428 linhas — ou seja, nem o universo acumulado alcança a capa' }],
]);

/**
 * Waivers cujo teto MEDIDO já não tem a folga mínima — esses precisam paginar, não ficar aqui.
 * Puras de propósito (recebem a baseline como argumento): é o que as fixtures de falsificação
 * lá embaixo exercitam sem tocar na lista real. Regra inerte é pior que regra nenhuma, porque
 * passa verde para sempre e ninguém desconfia.
 */
export function waiversSemFolga(baseline: Map<string, Waiver>, folgaMinima: number): string[] {
  const fora: string[] = [];
  for (const [chave, w] of baseline) {
    if (w.tipo === 'nao_medido') continue; // sem número não há folga a comparar — é o outro teste
    if (w.teto > folgaMinima) fora.push(`${chave} (teto ${w.teto} > ${folgaMinima})`);
  }
  return fora.sort();
}

/** Waivers cuja prova envelheceu (data no formato ISO `AAAA-MM-DD`, comparável como string). */
export function waiversVencidos(baseline: Map<string, Waiver>, hoje: string): string[] {
  const vencidos: string[] = [];
  for (const [chave, w] of baseline) {
    if (w.tipo === 'estrutural') continue; // definição não envelhece sozinha — ver o tipo Waiver
    if (w.revisarAte < hoje) vencidos.push(`${chave} (venceu em ${w.revisarAte})`);
  }
  return vencidos.sort();
}

function achadosAtuais(): string[] {
  const setReturning = nomesSetReturning(
    readFileSync(resolve(RAIZ, 'src/integrations/supabase/types.ts'), 'utf8'),
  );
  const achados: string[] = [];
  for (const f of arquivosFonte(resolve(RAIZ, 'src'))) {
    const rel = f.replace(RAIZ + '/', '');
    for (const nome of chamadasSemPaginacao(readFileSync(f, 'utf8'), setReturning)) {
      achados.push(`${nome} @ ${rel}`);
    }
  }
  return achados;
}

describe('RPC set-returning chamada do frontend pagina', () => {
  it('não nasce chamada NOVA sem `.range()`', () => {
    const novas = [...new Set(achadosAtuais())].filter((a) => !BASELINE.has(a)).sort();
    expect(
      novas,
      `RPC set-returning chamada sem paginar (a capa de 1.000 do PostgREST vale para .rpc()):\n` +
        novas.map((n) => `  - ${n}`).join('\n') +
        `\nPagine com fetchAllPages + .order() ESTÁVEL + .range(), como em useBundleEngine.ts.`,
    ).toEqual([]);
  });

  it('a baseline encolhe: entrada que sumiu do código sai da lista', () => {
    // Sem isto a lista apodrece e passa a "aprovar" chamadas que não existem mais — e o
    // próximo leitor lê 23 dívidas onde há 5.
    const atuais = new Set(achadosAtuais());
    const obsoletas = [...BASELINE.keys()].filter((b) => !atuais.has(b)).sort();
    expect(obsoletas, `saíram do código — remova da BASELINE:\n${obsoletas.join('\n')}`).toEqual([]);
  });

  it('teto medido sem folga não fica na baseline: pagine', () => {
    // A régua que tirou daqui `fin_analise_cp_dimensoes_rpc` (877 medidos, 88% da capa). Sem
    // ela a medição vira decoração: alguém contaria 950, escreveria o número com orgulho e o
    // gate aprovaria a chamada que rompe na safra seguinte.
    const semFolga = waiversSemFolga(BASELINE, FOLGA_MINIMA);
    expect(
      semFolga,
      `medido perto da capa de 1.000 — PAGINE em vez de registrar aqui ` +
        `(fetchAllPages + .order() de ordem TOTAL + .range(), como em financeiroV2Service.ts):\n` +
        semFolga.map((x) => `  - ${x}`).join('\n'),
    ).toEqual([]);
  });

  it('waiver medido em DADOS vence: a fotografia de um dia não aprova o universo de sempre', () => {
    // `estrutural` não entra aqui de propósito (ver o tipo `Waiver`): dado cresce sozinho, todo
    // dia; definição só muda por CREATE OR REPLACE, que passa pelo ritual de migration.
    const hoje = new Date().toISOString().slice(0, 10);
    const vencidos = waiversVencidos(BASELINE, hoje);
    expect(
      vencidos,
      `waiver VENCIDO — re-rode a contagem que está no campo \`prova\` da entrada e escreva o ` +
        `número novo (com \`medidoEm\`), ou pagine a chamada. Só empurrar \`revisarAte\` para a ` +
        `frente sem medir é fabricar a apuração:\n` + vencidos.map((x) => `  - ${x}`).join('\n'),
    ).toEqual([]);
  });

  it('todo waiver carrega a prova do teto — placeholder vazio não passa', () => {
    // Heurística contra o campo em branco / "ok" / "TODO", não contra prova FALSA: essa só o
    // leitor humano pega. Serve para que o custo de registrar um waiver seja escrever a query.
    const semProva: string[] = [];
    for (const [chave, w] of BASELINE) {
      const texto = w.tipo === 'nao_medido' ? w.bloqueio : w.prova;
      if (texto.trim().length < 20) semProva.push(chave);
    }
    expect(semProva.sort(), `waiver sem prova escrita:\n${semProva.join('\n')}`).toEqual([]);
  });

  it('FALSIFICAÇÃO: as duas réguas do waiver acusam de verdade', () => {
    const folga = (t: number): Map<string, Waiver> =>
      new Map([['x @ y.ts', { tipo: 'medido', teto: t, prova: 'p', medidoEm: '2026-01-01', revisarAte: '2099-01-01' }]]);
    expect(waiversSemFolga(folga(501), 500)).toEqual(['x @ y.ts (teto 501 > 500)']);
    expect(waiversSemFolga(folga(500), 500)).toEqual([]);

    // Estrutural NÃO vence, medido vence — a assimetria é o desenho, então tem de ser provada.
    const emDia = new Map<string, Waiver>([
      ['med @ a.ts', { tipo: 'medido', teto: 1, prova: 'p', medidoEm: '2026-01-01', revisarAte: '2026-06-30' }],
      ['est @ b.ts', { tipo: 'estrutural', teto: 1, prova: 'RETURN NEXT único' }],
    ]);
    expect(waiversVencidos(emDia, '2026-06-30')).toEqual([]);
    expect(waiversVencidos(emDia, '2026-07-01')).toEqual(['med @ a.ts (venceu em 2026-06-30)']);
  });

  it('FALSIFICAÇÃO: o gate acusa uma chamada crua e absolve a paginada', () => {
    // Gate inerte é o pior desfecho: passa verde para sempre e ninguém percebe. Estas
    // fixtures provam a detecção sem sabotar arquivo real.
    const setRet = new Set(['minha_rpc_grande']);

    expect(chamadasSemPaginacao(`const { data } = await supabase.rpc('minha_rpc_grande');`, setRet))
      .toEqual(['minha_rpc_grande']);

    // ASPAS DUPLAS — o furo real do scanner até 2026-08-20. `src/` tem 10 chamadas `.rpc("…")`
    // e duas eram set-returning: enquanto o regex só via `'`, elas não estavam nem na baseline
    // nem nos achados, e o verde do gate vinha de não ter procurado.
    expect(chamadasSemPaginacao(`const { data } = await supabase.rpc("minha_rpc_grande");`, setRet))
      .toEqual(['minha_rpc_grande']);

    // CAST — o segundo disfarce da mesma cegueira, e o idioma DOMINANTE do repo para RPC ainda
    // não tipada: das 108 ocorrências de `.rpc` em `src/`, o regex antigo casava 86 — 22 escapavam. Estas duas formas
    // são literais dos dois callers que estavam fora da baseline até esta medição.
    expect(
      chamadasSemPaginacao(`const { data } = await (supabase.rpc as RpcFn)('minha_rpc_grande', params);`, setRet),
    ).toEqual(['minha_rpc_grande']);
    expect(
      chamadasSemPaginacao(
        `const { data, error } = await (\n` +
          `  supabase.rpc as (fn: string, args: unknown) => ReturnType<typeof supabase.rpc>\n` +
          `)('minha_rpc_grande', params);`,
        setRet,
      ),
    ).toEqual(['minha_rpc_grande']);
    // …e o cast PAGINADO continua absolvido: a janela do `.range()` conta do fim do match, senão
    // a tolerância nova acusaria justamente quem já se defendeu.
    expect(
      chamadasSemPaginacao(
        `fetchAllPages((de, ate) => (supabase.rpc as RpcFn)('minha_rpc_grande', p).order('id').range(de, ate), 'x')`,
        setRet,
      ),
    ).toEqual([]);
    expect(
      chamadasSemPaginacao(
        `fetchAllPages((de, ate) => supabase.rpc("minha_rpc_grande").order('id').range(de, ate), 'x')`,
        setRet,
      ),
    ).toEqual([]);

    expect(
      chamadasSemPaginacao(
        `fetchAllPages((de, ate) => supabase.rpc('minha_rpc_grande').order('id').range(de, ate), 'x')`,
        setRet,
      ),
    ).toEqual([]);

    // Escalar não sofre capa de LINHAS — acusá-la seria ruído que faria o gate ser ignorado.
    expect(chamadasSemPaginacao(`await supabase.rpc('rpc_escalar')`, setRet)).toEqual([]);

    // O comentário longo entre `.rpc()` e `.range()` é o idioma deste repo: não pode gerar
    // falso positivo (foi o que aconteceu na primeira medição, com o próprio fix do #1782).
    expect(
      chamadasSemPaginacao(
        `supabase.rpc('minha_rpc_grande')\n` +
          Array.from({ length: 12 }, (_, i) => `  // linha de comentário bem comprida número ${i} explicando o porquê`).join('\n') +
          `\n  .order('id', { ascending: true })\n  .range(de, ate)`,
        setRet,
      ),
    ).toEqual([]);
  });

  it('a fonte da verdade é o types.ts: set-returning é `Returns` ARRAY', () => {
    const types = readFileSync(resolve(RAIZ, 'src/integrations/supabase/types.ts'), 'utf8');
    const nomes = nomesSetReturning(types);
    // As duas que já morderam o repo — se o parser parar de reconhecê-las, o gate fica cego.
    expect(nomes.has('get_carteira_margem_faixa')).toBe(true);
    expect(nomes.has('get_skus_margem_positiva')).toBe(true);
    // Escalar (`Returns: Json`) fica de fora.
    expect(nomes.has('get_carteira_saude')).toBe(false);
  });
});
