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
  // (Achado do Codex xhigh na revisão deste PR; conferido com `git grep '\.rpc("'`.)
  for (const m of txt.matchAll(/\.rpc\(\s*(?:'([a-z0-9_]+)'|"([a-z0-9_]+)")/g)) {
    const nome = m[1] ?? m[2];
    if (!setReturning.has(nome)) continue;
    if (!/\.range\(/.test(txt.slice(m.index!, m.index! + 400))) achados.push(nome);
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

  // ── NÃO medidas: 2ª fatia. Têm `LIMIT` no corpo, que NÃO é garantia — `LIMIT p_limit` com
  //    parâmetro grande não protege, e o valor precisa ser conferido constante e < 1.000.
  ['carteira_por_municipio @ src/hooks/useRoutePlanner.ts',
    { tipo: 'nao_medido', bloqueio: 'tem LIMIT no corpo; falta conferir se é constante e < 1.000', revisarAte: '2027-02-20' }],
  ['fin_regua_condicao_prazo @ src/hooks/useCustoPrazoRegua.ts',
    { tipo: 'nao_medido', bloqueio: 'tem LIMIT no corpo; falta conferir se é constante e < 1.000', revisarAte: '2027-02-20' }],
  ['get_whatsapp_pendentes @ src/hooks/useWhatsappPendentes.ts',
    { tipo: 'nao_medido', bloqueio: 'tem LIMIT no corpo; falta conferir se é constante e < 1.000', revisarAte: '2027-02-20' }],
  ['listar_pedidos_a_separar @ src/queries/usePedidosASeparar.ts',
    { tipo: 'nao_medido', bloqueio: 'tem LIMIT no corpo; falta conferir se é constante e < 1.000', revisarAte: '2027-02-20' }],
  ['radar_contagem_por_municipio @ src/queries/useRadarCidadesRota.ts',
    { tipo: 'nao_medido', bloqueio: 'tem LIMIT no corpo; falta conferir se é constante e < 1.000', revisarAte: '2027-02-20' }],
  ['radar_prospects_para_rota @ src/hooks/useRoutePlanner.ts',
    { tipo: 'nao_medido', bloqueio: 'tem LIMIT no corpo; falta conferir se é constante e < 1.000', revisarAte: '2027-02-20' }],
  ['reposicao_pos_candidatos @ src/pages/AdminReposicaoPedidos.tsx',
    { tipo: 'nao_medido', bloqueio: 'MONEY-PATH: tem LIMIT no corpo; falta conferir se é constante e < 1.000', revisarAte: '2027-02-20' }],
  ['reposicao_pos_marcador @ src/pages/AdminReposicaoPedidos.tsx',
    { tipo: 'nao_medido', bloqueio: 'tem LIMIT no corpo; falta conferir se é constante e < 1.000', revisarAte: '2027-02-20' }],
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
