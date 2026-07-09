import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// repo root: src/__tests__ → src → repo (2 níveis).
const CWD = resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(resolve(CWD, rel), 'utf8');
const count = (hay: string, needle: string) => hay.split(needle).length - 1;

// ── Guard de invariante money-path dos EDGES (Deno, fora do typecheck/vitest do src) ──
// Por que TEXTUAL: edge function roda no Lovable Cloud; o deploy via chat pode REVERTER um
// fix mergeado e COMMITAR a reversão na `main` como "Changes" (mordido 2026-06-26: o fallback
// do analyze #1077 voltou a override no deploy; re-aplicado #1080 — ver docs/agent/deploy.md).
// Este teste roda no CI (`validate`) e FALHA se o invariante sumir da `main` → a reversão do
// bot fica visível em vez de mascarada. NÃO substitui a canária de comportamento, só a fonte.

const ANALYZE = 'supabase/functions/analyze-unified-order/index.ts';
const AUDIT = 'supabase/functions/algorithm-a-audit/index.ts';
const HELPER = 'src/lib/pricing/mergeCustomerPrices.ts';

// Extrai o bloco espelhado entre os marcadores-COMENTÁRIO `// MIRROR-START`/`// MIRROR-END` e
// normaliza (remove `export `, comentários e whitespace) para comparar o helper de src/ × a cópia
// no edge. O `// ` ancora no comentário-marcador real (a prosa de JSDoc menciona o token sem `//`).
function mirrorBlock(s: string): string {
  const m = s.match(/\/\/ MIRROR-START[^\n]*\n([\s\S]*?)\n[^\n]*\/\/ MIRROR-END/);
  if (!m) throw new Error('bloco // MIRROR-START.../END não encontrado');
  return m[1]
    .replace(/\bexport\s+/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('//'))
    .join('\n');
}

// Variante que casa o bloco MIRROR por NOME (`// MIRROR-START <label>`), para arquivos com >1 bloco
// (o edge omie-vendas-sync tem account-coherence E derive-account-identity).
function mirrorBlockNamed(s: string, label: string): string {
  const re = new RegExp(`// MIRROR-START ${label}[^\\n]*\\n([\\s\\S]*?)\\n[^\\n]*// MIRROR-END`);
  const m = s.match(re);
  if (!m) throw new Error(`bloco // MIRROR-START ${label}.../END não encontrado`);
  return m[1]
    .replace(/\bexport\s+/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('//'))
    .join('\n');
}

// O merge de preço (order_items vence, Omie só preenche gap) foi extraído para um helper puro
// (src/lib/pricing/mergeCustomerPrices.ts, testado por vitest) e ESPELHADO verbatim no edge,
// porque o Deno do edge não importa de src/. Estes testes provam que o edge USA o helper (não
// só que tem os gates) e que a cópia NÃO divergiu — a canária {canary:true} fecha o ciclo
// provando o comportamento DEPLOYADO. Ver docs/agent/money-path.md (§ "Helper espelhado").
describe('guardrail money-path: analyze-unified-order USA o helper de merge de preço', () => {
  const src = read(ANALYZE);
  const helper = read(HELPER);

  it('sentinela: leu os arquivos reais (edge + helper)', () => {
    expect(src).toContain('priceMap');
    expect(src).toContain('mergeCustomerPrices');
    expect(helper).toContain('mergeCustomerPrices');
  });

  it('o helper puro existe e exporta mergeCustomerPrices + isValidUnitPrice', () => {
    expect(helper).toMatch(/export function mergeCustomerPrices/);
    expect(helper).toMatch(/export function isValidUnitPrice/);
  });

  it('o edge USA o helper: define o espelho E o chama (não só define)', () => {
    expect(src, 'edge não define mais o helper espelhado').toMatch(/function mergeCustomerPrices/);
    expect(src, 'REGRESSÃO: edge não chama mais mergeCustomerPrices — voltou à lógica inline?')
      .toMatch(/priceMap\s*=\s*mergeCustomerPrices\(/);
    expect(
      count(src, 'mergeCustomerPrices'),
      'helper deve ser DEFINIDO e CHAMADO (≥2 menções)',
    ).toBeGreaterThanOrEqual(2);
  });

  it('PARIDADE: o bloco espelhado no edge é IDÊNTICO ao helper de src/ (pega reversão do Lovable)', () => {
    expect(
      mirrorBlock(src),
      'edge divergiu do helper de src/ — o Lovable reescreveu o merge no deploy?',
    ).toBe(mirrorBlock(helper));
  });

  it('Omie é FALLBACK, não override: o helper preserva o gate de gap `!(… in priceMap)`', () => {
    expect(
      mirrorBlock(helper),
      'sumiu o gate de gap — Omie voltaria a sobrescrever order_items (override)',
    ).toMatch(/!\(\s*\w+\s+in\s+priceMap\s*\)/);
    expect(src).not.toContain('// Omie overrides local');
  });

  it('NÃO lê sales_price_history no price path (lê order_items, fonte de verdade)', () => {
    expect(src).not.toContain('from("sales_price_history")');
    expect(src).not.toContain("from('sales_price_history')");
  });

  it('canária comportamental {canary:true} prova o merge DEPLOYADO (123 local vence 999 Omie)', () => {
    expect(src, 'canária {canary:true} ausente — sem prova do comportamento deployado').toContain('canary');
    expect(src, 'canária sem o valor esperado 123 — não prova local-vence-Omie').toMatch(/expected[^0-9]*123/);
  });
});

describe('guardrail money-path: algorithm-a-audit (margem)', () => {
  const src = read(AUDIT);

  it('sentinela: leu o arquivo real do edge', () => {
    expect(src).toContain('bestPriceMap');
    expect(src).toContain('margin_audit_log');
  });

  it('bestPriceMap (potencial) só de pedidos praticados: filtra excludedOrderIds', () => {
    expect(
      src,
      'o filtro de praticados sumiu do bestPriceMap — orçamento de preço absurdo voltaria a inflar margin_potential',
    ).toContain('excludedOrderIds.has(sp.sales_order_id)');
  });

  it('margem real só de pedidos praticados: filtra excludedOrderIds no agrupamento', () => {
    expect(
      src,
      'o filtro de praticados sumiu do recentOrders — orçamento absurdo voltaria a inflar margin_real',
    ).toContain('excludedOrderIds.has(oi.sales_order_id)');
  });

  it('bestPriceMap lê order_items (não a sph poluída)', () => {
    expect(src).toContain("'order_items', 'product_id, unit_price, sales_order_id'");
  });
});

// ── Trava de crédito Fase 2: log de bloqueio DURÁVEL + canária de deploy ──
// O gate mora no edge (Deno, fora do vitest/typecheck do src). Dois invariantes money-path que
// o deploy do Lovable pode reverter em silêncio (e o CI `validate` reexpõe na main):
//  1. (a) bloqueio sem log gravado vira ERRO, não {blocked} silencioso — a aprovação remota do
//     gestor depende do último log do pedido; bloqueio sem rastro = gestor sem form.
//  2. a canária `credito_gate_probe` existe, chama a RPC (prova de mordida) e é read-only (não
//     cria PV nem toca o Omie) — é a prova do gate DEPLOYADO, mais forte que o commit de deploy.
const VENDAS = 'supabase/functions/omie-vendas-sync/index.ts';

describe('guardrail money-path: trava de crédito Fase 2 (gate + log durável + canária)', () => {
  const src = read(VENDAS);

  it('sentinela: leu o edge real e o gate/log existem', () => {
    expect(src).toContain('gateCredito');
    expect(src).toContain('venda_gate_credito');
    expect(src).toContain('venda_bloqueio_credito_log');
  });

  it('(a) LOG DE BLOQUEIO DURÁVEL: falha do insert vira ERRO, não console.warn best-effort', () => {
    expect(
      src,
      'REGRESSÃO: o log de bloqueado voltou a best-effort (console.warn) — bloqueio ficaria sem rastro',
    ).not.toMatch(/log bloqueado falhou/);
    expect(
      src,
      'sumiu o throw durável do log de bloqueio (aprovação remota do gestor perde a evidência)',
    ).toMatch(/Bloqueio de crédito sem log durável/);
  });

  it('CANÁRIA de deploy: credito_gate_probe existe, expõe gate_no_ar e chama a RPC do gate', () => {
    expect(
      src,
      'canária credito_gate_probe ausente/renomeada — sem prova do gate DEPLOYADO (só o commit, mais fraco)',
    ).toContain('case "credito_gate_probe":');
    expect(src, 'a probe deveria expor gate_no_ar (existência do gate no build deployado)').toContain('gate_no_ar');
    expect(
      src,
      'a probe não chama mais a RPC venda_gate_credito — deixou de provar mordida',
    ).toMatch(/case "credito_gate_probe":[\s\S]{0,700}venda_gate_credito/);
  });

  it('CANÁRIA read-only: a probe NÃO cria PV nem chama o Omie (dry-run seguro mesmo com gate fora do ar)', () => {
    // bloco INTEIRO da action (até o próximo case) — a action tem 2 breaks (early-return + fim).
    const m = src.match(/case "credito_gate_probe":[\s\S]*?\n {6}case /);
    expect(m, 'bloco da action credito_gate_probe não encontrado').toBeTruthy();
    const bloco = m![0];
    expect(bloco, 'a probe NÃO pode criar PV (criarPedidoVenda) — deixaria de ser dry-run').not.toContain('criarPedidoVenda');
    expect(bloco, 'a probe NÃO pode chamar o Omie (callOmieVendasApi) — deixaria de ser dry-run').not.toContain('callOmieVendasApi');
    // [P2 Codex] codigo obrigatório: sem código a probe recusa (não dá gate_no_ar sozinho como prova).
    expect(bloco, 'a probe deveria exigir `codigo` (senão falsa-tranquilidade)').toMatch(/requer `codigo`/);
  });

  it('gate é CHAMADO em criar_pedido E alterar_pedido (não só definido)', () => {
    // 1 definição (async function gateCredito) + ≥2 chamadas (criação + edição).
    expect(
      count(src, 'await gateCredito('),
      'gateCredito não é mais chamado nas 2 vias de pedido (criar + alterar) — gate furado',
    ).toBeGreaterThanOrEqual(2);
  });

  it('(a) o throw durável está NO ramo do insert de "bloqueado" (não solto em outro lugar)', () => {
    const m = src.match(/acao: contexto === "edicao"[\s\S]*?return \{ permitido: false/);
    expect(m, 'ramo do log de bloqueado não encontrado').toBeTruthy();
    expect(m![0], 'o throw durável saiu do ramo do insert de bloqueado').toMatch(/Bloqueio de crédito sem log durável/);
  });

  it('P1+P2 anti-duplicação: alterar_pedido aborta se consult falha, sem itens OU item sem id deletável', () => {
    expect(
      src,
      'sumiu o guard anti-duplicação — edição com estado incerto voltaria a duplicar itens no Omie',
    ).toMatch(/!consultEditOk \|\| omieCurrentItems\.length === 0 \|\| itemSemIdDeletavel/);
    // [P2 Codex] item sem chave deletável (ide.codigo_item/codigo_item_integracao) → aborta antes do delete+add.
    expect(
      src,
      'sumiu o guard de identificador deletável — item sem id seria pulado no delete e duplicado no add',
    ).toMatch(/itemSemIdDeletavel = omieCurrentItems\.some/);
    expect(src, 'o guard anti-duplicação perdeu o rótulo').toMatch(/anti-duplicação/);
  });
});

// ── Coerência conta×código (prova positiva) — guard na FRONTEIRA comum de criar_pedido ──
// [P0-A, veredito Codex 2026-07-05] Fecha o vazamento cross-conta em TODAS as vias de criação de PV
// (SalesQuotes, selectCustomerByUserId, fallback de IA, futuras): um caller pode resolver o código no
// espelho PARCIAL omie_clientes sem filtrar empresa e mandar o código de OUTRA conta do mesmo cliente.
// O edge deriva a conta do PEDIDO LOCAL (customer_user_id) e recusa só com PROVA POSITIVA — nunca por
// ausência (oben resolve o código via API e não vive no espelho). Helper puro em src/ (vitest)
// ESPELHADO verbatim no edge (Deno); a paridade textual aqui pega a reversão do deploy do Lovable.
const ACCOUNT_COHERENCE = 'src/lib/omie/account-coherence.ts';

describe('guardrail money-path: coerência conta×código no criar_pedido (edge USA o helper espelhado)', () => {
  const src = read(VENDAS);
  const helper = read(ACCOUNT_COHERENCE);

  it('sentinela: leu os arquivos reais (edge + helper)', () => {
    expect(src).toContain('criar_pedido');
    expect(helper).toContain('codeBelongsToWrongAccount');
  });

  it('o helper puro existe e exporta codeBelongsToWrongAccount', () => {
    expect(helper).toMatch(/export function codeBelongsToWrongAccount/);
  });

  it('o edge USA o helper: define o espelho E o chama (não só define)', () => {
    expect(src, 'edge não define mais o helper espelhado de coerência').toMatch(/function codeBelongsToWrongAccount/);
    expect(
      src,
      'REGRESSÃO: edge não chama mais codeBelongsToWrongAccount — voltou a confiar no código do payload?',
    ).toMatch(/codeBelongsToWrongAccount\(/);
    expect(
      count(src, 'codeBelongsToWrongAccount'),
      'helper deve ser DEFINIDO e CHAMADO (≥2 menções)',
    ).toBeGreaterThanOrEqual(2);
  });

  it('deriva do PEDIDO LOCAL (customer_user_id + customer_document), não confia no payload', () => {
    expect(
      src,
      'o guard deixou de ler customer_user_id/customer_document do pedido local — voltaria a confiar no payload',
    ).toMatch(/select\("account, customer_user_id, customer_document, created_by"\)/);
  });

  it('PARIDADE: o bloco espelhado no edge é IDÊNTICO ao helper de src/ (pega reversão do Lovable)', () => {
    expect(
      mirrorBlock(src),
      'edge divergiu do helper de src/ — o Lovable reescreveu a coerência no deploy?',
    ).toBe(mirrorBlock(helper));
  });
});

// ── Derivação de identidade Omie por conta (prova POSITIVA server-side) — P0-B ──
// Fecha o gap do P0-A (código de OUTRO user passava): o edge deriva o código AUTORITATIVO do DOCUMENTO
// do pedido (âncora imune ao fallback customer_user_id || user.id) e fail-closa em ambiguidade/ausência/
// divergência. Decisão pura em src/ (vitest) ESPELHADA verbatim no edge; a paridade aqui pega a reversão
// do deploy do Lovable. A prova do COMPORTAMENTO deployado é a canária `identidade_probe` (roda a decisão
// pura no build no ar, read-only); o quote OBEN que converte pós-deploy é a prova end-to-end.
const DERIVE = 'src/lib/omie/derive-account-identity.ts';

describe('guardrail money-path: derivação de identidade Omie por conta (edge USA a decisão espelhada)', () => {
  const src = read(VENDAS);
  const helper = read(DERIVE);

  it('sentinela: leu os arquivos reais (edge + helper)', () => {
    expect(src).toContain('deriveOmieAccountIdentity');
    expect(helper).toContain('decideAccountIdentity');
  });

  it('o helper puro existe e exporta decideAccountIdentity', () => {
    expect(helper).toMatch(/export function decideAccountIdentity/);
  });

  it('o edge USA a decisão: define o espelho E deriva na fronteira (deriveOmieAccountIdentity)', () => {
    expect(src, 'edge não define mais decideAccountIdentity espelhada').toMatch(/function decideAccountIdentity/);
    expect(
      src,
      'REGRESSÃO: edge não chama mais deriveOmieAccountIdentity — voltou a confiar no código do payload?',
    ).toMatch(/await deriveOmieAccountIdentity\(/);
    expect(
      count(src, 'deriveOmieAccountIdentity'),
      'deve ser DEFINIDO e CHAMADO (≥2 menções)',
    ).toBeGreaterThanOrEqual(2);
  });

  it('criar_pedido USA o DERIVADO (ident.*), não o codigo_cliente do payload, no gate e no PV', () => {
    expect(src, 'gateCredito/criarPedidoVenda deixaram de usar ident.codigo_cliente — voltaram ao payload?')
      .toContain('ident.codigo_cliente');
    expect(src, 'criarPedidoVenda deixou de usar ident.codigo_vendedor — voltou ao payload?')
      .toContain('ident.codigo_vendedor');
  });

  it('alterar_pedido verifica a identidade antes da edição destrutiva (verify-before-edit)', () => {
    expect(
      src,
      'sumiu o verify-before-edit — a edição voltaria a poder mutar um PV mal-atribuído',
    ).toMatch(/omieCodigoClienteEdit !== null[\s\S]{0,200}deriveOmieAccountIdentity\(/);
  });

  it('PARIDADE: o bloco espelhado no edge é IDÊNTICO à decisão de src/ (pega reversão do Lovable)', () => {
    expect(
      mirrorBlockNamed(src, 'omie derive-account-identity'),
      'edge divergiu da decisão de src/ — o Lovable reescreveu a derivação no deploy?',
    ).toBe(mirrorBlockNamed(helper, 'omie derive-account-identity'));
  });

  // ── Canária comportamental: fecha a assimetria de verificação (frontend prova-se por bytes do
  // bundle; edge prova-se por CANÁRIA). O guard TEXTUAL acima cobre a FONTE (paridade src×edge); a
  // probe HTTP `identidade_probe` é a única prova do COMPORTAMENTO no build DEPLOYADO — roda a decisão
  // pura com fixtures fixos e retorna {resolved, expected, ok}. Ver docs/agent/money-path.md (§ canária).
  it('CANÁRIA de deploy: identidade_probe existe, expõe probe_no_ar e roda a decisão pura {resolved,expected,ok}', () => {
    expect(
      src,
      'canária identidade_probe ausente/renomeada — sem prova do COMPORTAMENTO deployado (só o commit + paridade textual, mais fraco)',
    ).toContain('case "identidade_probe":');
    // bloco INTEIRO da action (até o próximo case) — read-only mais robusto que limites {0,N}.
    const m = src.match(/case "identidade_probe":[\s\S]*?\n {6}case /);
    expect(m, 'bloco da action identidade_probe não encontrado').toBeTruthy();
    const bloco = m![0];
    expect(bloco, 'a probe deveria expor probe_no_ar (existência da derivação P0-B no build deployado)').toContain('probe_no_ar');
    expect(bloco, 'a probe não roda mais decideAccountIdentity — deixou de provar a tabela-verdade deployada').toContain('decideAccountIdentity(');
    expect(bloco, 'a probe perdeu o contrato {resolved, expected, ok}').toMatch(/resolved[\s\S]{0,120}expected[\s\S]{0,80}ok:/);
  });

  it('CANÁRIA read-only: identidade_probe roda a decisão PURA (sem deriveOmieAccountIdentity/Omie/PV/DB) e cobre fail-closed', () => {
    const m = src.match(/case "identidade_probe":[\s\S]*?\n {6}case /);
    expect(m, 'bloco da action identidade_probe não encontrado').toBeTruthy();
    const bloco = m![0];
    expect(bloco, 'a probe NÃO pode chamar deriveOmieAccountIdentity (faz I/O — perderia o dry-run determinístico)').not.toContain('deriveOmieAccountIdentity(');
    expect(bloco, 'a probe NÃO pode chamar o Omie (callOmieVendasApi) — deixaria de ser dry-run').not.toContain('callOmieVendasApi');
    expect(bloco, 'a probe NÃO pode criar PV (criarPedidoVenda) — deixaria de ser dry-run').not.toContain('criarPedidoVenda');
    // [Codex] read-only textual mais forte: barra QUALQUER escrita/leitura no DB, não só os 3 nomes
    // literais (um insert/update/rpc via supabaseAdmin passaria pelo guard antigo).
    expect(bloco, 'a probe NÃO pode tocar o client supabase (supabaseAdmin) — deixaria de ser dry-run puro').not.toContain('supabaseAdmin');
    expect(bloco, 'a probe NÃO pode escrever/consultar o DB (.insert/.update/.delete/.upsert/.rpc)').not.toMatch(/\.(insert|update|delete|upsert|rpc)\(/);
    // precisão>recall: a probe morde só se cobrir a tabela-verdade, não só o caminho feliz. [Codex]
    // cobertura completa: os fail-closeds do mirror-path E do omie-path.
    expect(bloco, 'a probe deveria cobrir o fail-closed de divergência (advisory ≠ derivado)').toContain('divergence');
    expect(bloco, 'a probe deveria cobrir o fail-closed de ambiguidade no espelho (2 códigos → não chuta)').toContain('ambiguous_mirror');
    expect(bloco, 'a probe deveria cobrir ambiguous_omie (duplicata-CNPJ no Omie)').toContain('ambiguous_omie');
    expect(bloco, 'a probe deveria cobrir unsafe_integer (código ≥ 2^53 não vai pro Omie)').toContain('unsafe_integer');
    expect(bloco, 'a probe deveria cobrir o omie-path com backfill (source omie)').toContain('backfill: true');
  });
});

// ── Fatia 1 do fix de rótulo (BUG-1): edge não confia no espelho 'colacor' POLUÍDO ──
// empresa_omie='colacor' é o default nunca-setado pelos 5 writers → MIX de código oben (bulk
// syncCustomers) + colacor_sc (writers manuais), ZERO colacor real (provado via psql-ro 2026-07-07).
// Confiar nele rotearia o pedido colacor ao cliente ERRADO (BUG-1, integridade, silencioso). Para
// account='colacor' o derive NÃO usa o espelho (força verificação Omie por documento) e NÃO backfilla
// (evitando contest/block sob unique_user_omie). O deploy do Lovable pode reverter isso na main; este
// guard textual reexpõe no CI. Temporário: a Fatia 3 re-rotula por conta e reverte. Ver
// docs/superpowers/specs/2026-07-07-espelho-omie-rotulo-por-conta-design.md.
describe('guardrail money-path: edge ignora o espelho colacor poluído (BUG-1, Fatia 1)', () => {
  const src = read(VENDAS);

  it('sentinela: leu o edge e o derive existe', () => {
    expect(src).toContain('deriveOmieAccountIdentity');
  });

  it('mirror do derive NÃO é usado para account=colacor (força needOmie → Omie por documento)', () => {
    expect(
      src,
      'REGRESSÃO: o derive voltou a usar o espelho para colacor — pedido colacor rotearia ao cliente errado (BUG-1)',
    ).toMatch(/userIds\.length === 1 && account !== "colacor"/);
  });

  it('backfill do espelho é desabilitado para colacor (evita contest/block sob unique_user_omie)', () => {
    expect(
      src,
      'REGRESSÃO: o backfill colacor voltou — a verificação forçada poderia bloquear pedido colacor legítimo',
    ).toMatch(/decision\.backfill && userIds\.length === 1 && account !== "colacor"/);
  });
});

// ── P1b (fail-closed no doc-dup-Omie) — syncCustomers USA o helper espelhado ──
// A proof-table omie_customer_account_map é populada document-first. Se 2 registros Omie DISTINTOS na
// MESMA conta compartilham o mesmo doc normalizado, o last-write-wins gravava um código arbitrário (o lado
// profile já era fail-closed; o lado Omie não). O helper puro (vitest) espelhado no edge detecta o doc
// ambíguo; a paridade textual aqui pega a reversão do deploy do Lovable. Fail-closed COMPLETO exige remover
// do mapa E deletar o vínculo pré-existente (furo P1 do Codex — "só não upsertar" deixa a linha antiga viva
// até o TTL). Ver docs/superpowers/specs/2026-07-09-omie-proof-table-staleness-doc-ambiguo-design.md.
const ANALYTICS = 'supabase/functions/omie-analytics-sync/index.ts';
const DOC_AMBIGUO = 'src/lib/omie/omie-doc-ambiguo.ts';

describe('guardrail money-path: P1b doc-ambíguo-Omie (syncCustomers USA o helper espelhado)', () => {
  const src = read(ANALYTICS);
  const helper = read(DOC_AMBIGUO);

  it('sentinela: leu os arquivos reais (edge + helper)', () => {
    expect(src).toContain('omie_customer_account_map');
    expect(helper).toContain('docsComCodigoAmbiguoNoOmie');
  });

  it('o helper puro existe e exporta docsComCodigoAmbiguoNoOmie', () => {
    expect(helper).toMatch(/export function docsComCodigoAmbiguoNoOmie/);
  });

  it('o edge USA o helper: define o espelho E o chama (não só define)', () => {
    expect(src, 'edge não define mais o helper espelhado de doc-ambíguo').toMatch(/function docsComCodigoAmbiguoNoOmie/);
    expect(
      src,
      'REGRESSÃO: edge não chama mais docsComCodigoAmbiguoNoOmie — P1b voltou a gravar last-write-wins?',
    ).toMatch(/docsComCodigoAmbiguoNoOmie\(/);
    expect(
      count(src, 'docsComCodigoAmbiguoNoOmie'),
      'helper deve ser DEFINIDO e CHAMADO (≥2 menções)',
    ).toBeGreaterThanOrEqual(2);
  });

  it('fail-closed COMPLETO: remove do mapa, deleta o vínculo pré-existente E preserva source=manual (Codex)', () => {
    expect(src, 'sumiu a remoção do accountMapByUser — voltaria a gravar código ambíguo').toMatch(/accountMapByUser\.delete\(/);
    expect(
      src,
      'REGRESSÃO: sumiu o DELETE cirúrgico — a linha antiga do last-write-wins viveria até o TTL (furo P1)',
    ).toMatch(/\.delete\(\)[\s\S]{0,220}\.in\("user_id", ambiguosList/);
    expect(
      src,
      'REGRESSÃO: o DELETE não preserva mais source=document — apagaria override humano manual (Codex item 3)',
    ).toMatch(/\.delete\(\)[\s\S]{0,160}\.eq\("source", "document"\)/);
  });

  it('PARIDADE: o bloco espelhado no edge é IDÊNTICO ao helper de src/ (pega reversão do Lovable)', () => {
    expect(
      mirrorBlockNamed(src, 'omie doc-ambiguo'),
      'edge divergiu do helper de src/ — o Lovable reescreveu a detecção no deploy?',
    ).toBe(mirrorBlockNamed(helper, 'omie doc-ambiguo'));
  });
});
