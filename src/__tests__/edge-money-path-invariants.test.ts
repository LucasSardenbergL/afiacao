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

// Recortes do edge de vendas para vigiar o WIRING da criação de PV (e não só a presença de tokens):
// o corpo do `case "criar_pedido"` (até o próximo `case` na mesma indentação) e a função de derivação
// de identidade. Textual pelo mesmo motivo do resto do arquivo: o edge roda no Lovable Cloud, fora do
// typecheck/vitest, e o deploy pelo chat pode reverter o fix e commitar a reversão na `main`.
function blocoCriarPedido(s: string): string {
  const i = s.indexOf('case "criar_pedido": {');
  if (i < 0) throw new Error('case "criar_pedido" não encontrado no edge');
  const resto = s.slice(i);
  const fim = resto.search(/\n {6}case "/);
  return fim < 0 ? resto : resto.slice(0, fim);
}

function blocoDeriveIdentity(s: string): string {
  const i = s.indexOf('async function deriveOmieAccountIdentity(');
  if (i < 0) throw new Error('deriveOmieAccountIdentity não encontrada no edge');
  const resto = s.slice(i);
  const fim = resto.search(/\n\}\n/);
  return fim < 0 ? resto : resto.slice(0, fim + 2);
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

// ── criar_pedido NÃO depende do espelho legado omie_clientes (inverte o P0-A — 2026-07-16) ──
// O P0-A provava "conta errada" pelo RÓTULO `empresa_omie` do espelho. O rótulo é DEFAULT POLUÍDO:
// 6909/6909 linhas da prod estão como 'colacor' (ZERO 'oben'), e o código oben do bulk syncCustomers
// mora ali sob esse rótulo. Para account='oben' a "prova positiva" era então estruturalmente falsa —
// `matchesTarget` nunca casa e qualquer código conhecido acusa. Bloqueou o PC 214820 (Lider) portando
// o código OBEN CORRETO: 8689689628 é oben na proof-table omie_customer_account_map (user 2ff308c9,
// account='oben', source='document'). A premissa escrita no invariante antigo ("oben não vive no
// espelho") é falsa — oben vive nele, rotulado 'colacor'.
// O design do P0-B já registrava o guard como REDUNDANTE nesta via (§4.3 de docs/superpowers/specs/
// 2026-07-05-identidade-omie-por-conta-design.md): a divergência advisory×derivado já é fail-closed,
// então o guard não barra nenhum código errado que a derivação aceitaria — só adiciona falso-positivo.
// LER era inútil (mirrorRows filtra empresa_omie=account → sempre vazio); ESCREVER era o 2º bloqueio,
// em série: o backfill upsertava sob `unique_user_omie UNIQUE(user_id)` — a constraint REAL da prod,
// enquanto o design §4.4 assumiu (user_id, empresa) — violava, a RPC devolvia 'contested' e o edge
// barrava o MESMO PV legítimo. Fonte única agora: documento + API Omie, divergência fail-closed.
describe('guardrail money-path: criar_pedido não confia no espelho legado omie_clientes', () => {
  const src = read(VENDAS);
  const criar = blocoCriarPedido(src);
  const derive = blocoDeriveIdentity(src);

  it('sentinela: extraiu os blocos REAIS do edge (case criar_pedido + derivação de identidade)', () => {
    expect(criar).toContain('criarPedidoVenda(');
    expect(derive).toContain('decideAccountIdentity(');
  });

  // Vigia DEFINIÇÃO e CHAMADA, não a menção: o tombstone no edge cita o nome de propósito, para que
  // quem for restaurá-lo leia antes por que ele saiu.
  it('não define nem chama codeBelongsToWrongAccount (o rótulo do espelho não é prova de conta)', () => {
    expect(
      src,
      'guard A voltou (definição): empresa_omie é default poluído (6909/6909 "colacor") — prova positiva falsa',
    ).not.toMatch(/function codeBelongsToWrongAccount/);
    expect(
      src,
      'guard A voltou (chamada): o rótulo local não prova conta — barra PV legítimo (PC 214820)',
    ).not.toMatch(/codeBelongsToWrongAccount\(/);
  });

  it('NÃO LÊ o espelho omie_clientes em nenhuma via do edge', () => {
    expect(
      src,
      'voltou a ler o espelho: o rótulo mente e mirrorRows nunca casa (não há linha "oben"/"colacor_sc")',
    ).not.toMatch(/from\("omie_clientes"\)/);
  });

  it('NÃO ESCREVE no espelho (o backfill contesta sob UNIQUE(user_id) e barra PV legítimo)', () => {
    expect(
      src,
      'backfill voltou: upsert sob unique_user_omie devolve "contested" e bloqueia o pedido — 2º bloqueio em série',
    ).not.toMatch(/omie_cliente_upsert_mapping/);
  });

  it('criarPedidoVenda recebe o código DERIVADO (ident), nunca o advisory do payload', () => {
    expect(criar).toMatch(
      /criarPedidoVenda\(\s*supabaseAdmin,\s*sales_order_id,\s*ident\.codigo_cliente,\s*ident\.codigo_vendedor,/,
    );
  });

  it('a derivação autoritativa (documento + API Omie) segue na fronteira', () => {
    expect(criar).toMatch(/deriveOmieAccountIdentity\(/);
    expect(derive, 'a derivação parou de consultar o Omie por documento').toMatch(/buscarClienteVendasMatches\(/);
  });

  it('deriva do PEDIDO LOCAL (customer_user_id + customer_document), não confia no payload', () => {
    expect(
      src,
      'o edge deixou de ler customer_user_id/customer_document do pedido local — voltaria a confiar no payload',
    ).toMatch(/select\("account, customer_user_id, customer_document, created_by"\)/);
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

// ── Fatia 1 do fix de rótulo (BUG-1) — SUPERADA em 2026-07-16, ver o invariante do espelho acima ──
// A Fatia 1 tirava o espelho poluído do derive SÓ para account='colacor' (gates `account !== "colacor"`
// no mirrorRows e no backfill), porque o rótulo 'colacor' é o default nunca-setado pelos 5 writers.
// A premissa que sobrou era falsa: "oben não vive no espelho". Vive — 6909/6909 linhas da prod estão
// rotuladas 'colacor', e é lá que mora o código oben do bulk syncCustomers. Com oben fora dos gates,
// o backfill oben violava `unique_user_omie` e devolvia 'contested' → bloqueava PV legítimo, o mesmo
// perigo que os gates evitavam para colacor. Em vez de estender os gates conta a conta, o espelho saiu
// INTEIRO do caminho de criação (todas as contas) — o invariante 'criar_pedido não confia no espelho
// legado omie_clientes' cobre isto e é estritamente mais forte: sem leitura, sem escrita, em conta
// nenhuma. Não recrie gates por conta aqui; se o espelho voltar, é este describe que precisa voltar.

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

  // Bloco INTEIRO da action doc_ambiguo_probe (até o próximo case/default). A probe TAMBÉM chama o
  // helper — sem removê-la, o assert de "o edge chama o helper" abaixo passaria mesmo se a chamada do
  // REAL-PATH (syncCustomers) sumisse. Ver o `it` da canária no fim deste describe.
  const PROBE_RE = /case "doc_ambiguo_probe":[\s\S]*?\n {6}(?=case |default:)/;

  it('o edge USA o helper: define o espelho E o chama NO REAL-PATH (não só define, nem só na probe)', () => {
    expect(src, 'edge não define mais o helper espelhado de doc-ambíguo').toMatch(/function docsComCodigoAmbiguoNoOmie/);
    expect(
      src,
      'REGRESSÃO: edge não chama mais docsComCodigoAmbiguoNoOmie — P1b voltou a gravar last-write-wins?',
    ).toMatch(/docsComCodigoAmbiguoNoOmie\(/);
    // precisão: a chamada tem de existir FORA da canária. Senão a probe (que chama o helper para
    // testá-lo) mascararia a remoção do fail-closed do syncCustomers — o guard viraria teatro.
    const semProbe = src.replace(PROBE_RE, '');
    expect(
      semProbe,
      'REGRESSÃO: a ÚNICA chamada a docsComCodigoAmbiguoNoOmie está na canária — o real-path (syncCustomers) parou de aplicar o fail-closed',
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

  // ── Canária comportamental: os asserts acima cobrem a FONTE na main (paridade textual src×edge). A
  // probe HTTP `doc_ambiguo_probe` é a única prova do COMPORTAMENTO no build DEPLOYADO — e aqui ela é
  // indispensável: a ausência do helper NÃO aparece no dado (a proof-table só encolhe se houver
  // duplicata-CNPJ real na conta, e não há — colacor_sc 5275→5275, psql-ro 2026-07-10). Sem a probe, uma
  // reversão do Lovable (como #1272) seria invisível em prod. Ver docs/agent/money-path.md (§ canária).
  it('CANÁRIA de deploy: doc_ambiguo_probe existe, expõe probe_no_ar e roda o helper {resolved,expected,ok}', () => {
    expect(
      src,
      'canária doc_ambiguo_probe ausente/renomeada — sem prova do COMPORTAMENTO deployado (só o commit + paridade textual, mais fraco)',
    ).toContain('case "doc_ambiguo_probe":');
    const m = src.match(PROBE_RE);
    expect(m, 'bloco da action doc_ambiguo_probe não encontrado').toBeTruthy();
    const bloco = m![0];
    expect(bloco, 'a probe deveria expor probe_no_ar (existência do helper P1b no build deployado)').toContain('probe_no_ar');
    expect(bloco, 'a probe não roda mais docsComCodigoAmbiguoNoOmie — deixou de provar o helper deployado').toContain('docsComCodigoAmbiguoNoOmie(');
    expect(bloco, 'a probe perdeu o contrato {resolved, expected, ok}').toMatch(/resolved[\s\S]{0,160}expected[\s\S]{0,80}ok:/);
  });

  it('CANÁRIA read-only: doc_ambiguo_probe é dry-run puro e cobre a tabela-verdade (+/- se falsificam)', () => {
    const m = src.match(PROBE_RE);
    expect(m, 'bloco da action doc_ambiguo_probe não encontrado').toBeTruthy();
    const bloco = m![0];
    expect(bloco, 'a probe NÃO pode tocar o client supabase (supabaseAdmin) — deixaria de ser dry-run puro').not.toContain('supabaseAdmin');
    expect(bloco, 'a probe NÃO pode escrever/consultar o DB (.insert/.update/.delete/.upsert/.rpc)').not.toMatch(/\.(insert|update|delete|upsert|rpc)\(/);
    expect(bloco, 'a probe NÃO pode chamar o Omie — deixaria de ser dry-run determinístico').not.toMatch(/callOmie|fetchOmie/);
    // precisão>recall: a probe só morde se cobrir os DOIS lados. Um helper sempre-∅ (o que a reversão do
    // Lovable produz) passa nos casos limpos; um que marca tudo passa no caso ambíguo. Exigir ambos.
    expect(bloco, 'a probe deveria cobrir o caso AMBÍGUO (2 códigos distintos) — senão um helper sempre-∅ passaria').toContain('doc_2_codigos_distintos');
    expect(bloco, 'a probe deveria cobrir o doc de 1 código (limpo) — senão um helper que marca tudo passaria').toContain('doc_1_codigo');
    expect(bloco, 'a probe deveria cobrir o MESMO código repetido (duplicata da paginação ≠ ambiguidade)').toContain('doc_mesmo_codigo_repetido');
    expect(bloco, 'a probe deveria cobrir o doc vazio (não vira chave)').toContain('doc_vazio_ignorado');
  });
});

// ── P1/P2 hardening do resolver de identidade do syncPedidos (omie-vendas-sync) — Codex xhigh 2026-07-10 ──
// Resolver de identidade dos pedidos (evolução: #1288 fez o fail-closed em TS; PR-1/A1 moveu p/ SQL).
// (A1) o docToUserMap (doc->user de profiles) era montado por paginação NO EDGE — não-atômica (Codex xhigh):
// um profile nascendo/mudando entre páginas escapava da detecção de doc-ambíguo. Migrado p/ a RPC atômica
// omie_sync_identity_snapshot (doc com 2+ users DISTINTOS fica FORA de doc_to_user, fail-closed no SQL,
// provado em db/test-omie-identidade-snapshot.sh). (P2, do #1288, MANTIDO) o resolveClientUserId passa
// throwOnTransient INCONDICIONAL — transitório no incremental não vira skip permanente. A sentinela textual
// aqui pega a reversão do deploy do Lovable. Ver docs/superpowers/specs/2026-07-11-omie-identidade-snapshot-atomico-design.md.

const IDENTITY_SNAPSHOT = 'src/lib/omie/omie-identity-snapshot.ts';

describe('guardrail money-path: identidade dos pedidos pela RPC atômica + contrato fail-closed (A1 + P2)', () => {
  const src = read(VENDAS);
  const analytics = read(ANALYTICS);
  const helper = read(IDENTITY_SNAPSHOT);

  it('sentinela: leu os arquivos reais (edge vendas + edge analytics + helper)', () => {
    expect(src).toContain('async function syncPedidos');
    expect(analytics).toContain('async function fetchProfileDocUserMap');
    expect(helper).toContain('parseIdentitySnapshot');
  });

  // ── A1 VENDAS: docToUserMap vem do snapshot atômico + validação estrita de contrato ──
  it('A1 vendas: docToUserMap vem da RPC via parseIdentitySnapshot (não paginação, não helper antigo)', () => {
    expect(src, 'edge vendas não chama mais a RPC').toContain("rpc('omie_sync_identity_snapshot'");
    expect(src, 'REGRESSÃO: docToUserMap não vem mais de parseIdentitySnapshot').toMatch(/docToUserMap[\s\S]{0,40}=[\s\S]{0,40}parseIdentitySnapshot\(/);
    expect(src, 'erro da RPC deve ser FAIL-CLOSED (throw)').toMatch(/if \(snapErr\) throw new Error/);
    expect(src, 'REVERSÃO Lovable? voltou a paginar profiles por keyset').not.toMatch(/from\('profiles'\)[\s\S]{0,200}\.order\('user_id'\)[\s\S]{0,120}\.gt\('user_id'/);
    expect(src, 'REVERSÃO: voltou a chamar o helper TS antigo').not.toMatch(/buildDocUserMapFailClosed\(/);
  });

  // ── A1 ANALYTICS: fetchProfileDocUserMap idem (Codex PR-1: o analytics podia ser revertido sem o CI ver) ──
  it('A1 analytics: fetchProfileDocUserMap usa a RPC + parseIdentitySnapshot + fail-closed, não paginação OFFSET', () => {
    // escopa ao CORPO da função (o analytics tem outros leitores legítimos de profiles com .range noutros pontos)
    const bloco = analytics.match(/async function fetchProfileDocUserMap[\s\S]*?\n}/)?.[0] ?? '';
    expect(bloco, 'não achei o corpo de fetchProfileDocUserMap (âncora quebrada)').not.toBe('');
    expect(bloco, 'analytics não chama mais a RPC').toContain("rpc('omie_sync_identity_snapshot'");
    expect(bloco, 'REGRESSÃO: analytics não usa mais parseIdentitySnapshot').toContain('parseIdentitySnapshot(snap)');
    expect(bloco, 'erro da RPC deve ser FAIL-CLOSED (throw)').toMatch(/if \(error\) throw new Error/);
    expect(
      bloco,
      'REVERSÃO Lovable? fetchProfileDocUserMap voltou a paginar profiles por OFFSET (.range)',
    ).not.toMatch(/\.range\(/);
  });

  // ── Contrato fail-closed (Codex challenge PR-1): error=null não prova o JSON; shape inválido LANÇA ──
  it('contrato: o helper valida shape/UUID/disjunção e LANÇA (não Map vazio silencioso)', () => {
    expect(helper).toMatch(/throw new Error/);
    expect(helper, 'valida UUID dos user_id').toMatch(/OMIE_SNAPSHOT_UUID_RE/);
    expect(helper, 'valida disjunção doc_to_user × ambiguous_docs').toMatch(/ambiguousDocs\.has\(doc\)/);
  });

  it('canário identidade_snapshot_probe valida o contrato e reprova deploy quebrado (PGRST202/nulls)', () => {
    expect(src, 'canário de deploy da RPC ausente').toContain('identidade_snapshot_probe');
    expect(src, 'canário deve VALIDAR o contrato via parseIdentitySnapshot').toContain('parseIdentitySnapshot(snapProbe)');
    expect(
      src,
      'REGRESSÃO (Codex PR-1): canário voltou a success:true fixo — PGRST202/nulls davam falso-verde',
    ).toMatch(/success: !snapProbeErr && parsedOk/);
  });

  // ── PARIDADE: o MIRROR do helper é idêntico entre src e os DOIS edges (pega reversão do Lovable) ──
  it('PARIDADE: parseIdentitySnapshot idêntico em src × vendas × analytics', () => {
    const h = mirrorBlockNamed(helper, 'omie identity-snapshot-parse');
    expect(mirrorBlockNamed(src, 'omie identity-snapshot-parse'), 'vendas divergiu do helper de src/').toBe(h);
    expect(mirrorBlockNamed(analytics, 'omie identity-snapshot-parse'), 'analytics divergiu do helper de src/').toBe(h);
  });

  // ── P2 (do #1288, MANTIDO): resolveClientUserId fail-safe em transitório nos DOIS modos ──
  it('P2: resolveClientUserId passa throwOnTransient INCONDICIONAL (não só no cursor) e sem catch fail-open', () => {
    const bloco = src.match(/async function resolveClientUserId[\s\S]*?async function getClientAddressPhone/)?.[0] ?? '';
    expect(bloco, 'não achei o corpo de resolveClientUserId (âncora quebrada)').not.toBe('');
    expect(
      bloco,
      'REGRESSÃO P2: resolveClientUserId voltou a condicionar throwOnTransient ao cursor — transitório no incremental vira skip permanente',
    ).not.toMatch(/cursor \?/);
    expect(
      bloco,
      'REGRESSÃO P2: resolveClientUserId não passa mais { throwOnTransient: true } ao ConsultarCliente',
    ).toMatch(/\{ throwOnTransient: true \}/);
    expect(
      bloco,
      'REGRESSÃO P2: voltou o catch que engole o transitório no incremental (fail-open → null cacheado + skip)',
    ).not.toMatch(/catch\s*\(/);
  });
});

// ── P0-B-bis PR-1 (omie-sync self-service USA a view fresca account-correta + helper espelhado) ──
// O pedido self-service (conta colacor_sc) resolvia a identidade Omie pelo espelho poluído omie_clientes
// (mix de contas, rótulo 'colacor' mentiroso) e fallback registros:1 (last-write-wins). Migrado p/ a view
// fresca omie_customer_account_map_fresco + fallback API fail-closed (registros:2, rejeita doc-ambíguo)
// via helper puro espelhado. A paridade textual aqui pega a reversão do deploy do Lovable (mesma armadilha
// do #1272). Ver docs/superpowers/plans/2026-07-09-omie-sync-self-service-view-fresca-pr1.md.
const OMIE_SYNC = 'supabase/functions/omie-sync/index.ts';
const SYNC_IDENTIDADE = 'src/lib/omie/omie-sync-identidade.ts';

describe('guardrail money-path: omie-sync self-service USA view fresca account-correta (P0-B-bis PR-1)', () => {
  const src = read(OMIE_SYNC);
  const helper = read(SYNC_IDENTIDADE);

  it('sentinela: leu os arquivos reais (edge + helper)', () => {
    expect(src).toContain('syncClienteOmie');
    expect(helper).toContain('decidirIdentidadeSelfService');
  });

  it('o helper puro existe e exporta decidirIdentidadeSelfService', () => {
    expect(helper).toMatch(/export function decidirIdentidadeSelfService/);
  });

  it('o edge USA o helper: define o espelho MIRROR E o chama (≥2 menções)', () => {
    expect(src, 'edge não define mais o helper espelhado de identidade').toMatch(/function decidirIdentidadeSelfService/);
    expect(
      src,
      'REGRESSÃO: edge não chama mais decidirIdentidadeSelfService — voltou a usar o espelho direto?',
    ).toMatch(/decidirIdentidadeSelfService\(/);
    expect(
      count(src, 'decidirIdentidadeSelfService'),
      'helper deve ser DEFINIDO e CHAMADO (≥2 menções)',
    ).toBeGreaterThanOrEqual(2);
  });

  it('LÊ a view fresca account-correta (colacor_sc); omie_clientes só resta como WRITER', () => {
    // As 3 leituras money-path (pedido, vendedor, check_client) usam a view fresca por conta.
    expect(
      count(src, '.from("omie_customer_account_map_fresco")'),
      'REVERSÃO Lovable? sumiu leitura da view fresca account-correta (esperado 3: pedido, vendedor, check_client)',
    ).toBe(3);
    // O filtro de conta é o fail-closed por-conta. Codex P2: contar == 3 (uma por leitura), não um toMatch
    // genérico — senão o pedido poderia perder o filtro e o teste passar só porque check_client o mantém.
    expect(
      count(src, '.eq("account", "colacor_sc")'),
      'cada uma das 3 leituras da view DEVE filtrar account=colacor_sc (fail-closed por-conta)',
    ).toBe(3);
    // O espelho poluído só pode restar como WRITER (o write-back INSERT → Fatia 4), nunca como LEITOR.
    expect(
      count(src, '.from("omie_clientes")'),
      'REGRESSÃO: omie_clientes voltou como LEITOR (deveria restar só o write-back INSERT)',
    ).toBe(1);
    expect(
      src,
      'REGRESSÃO: o único omie_clientes restante não é o write-back (upsert) — leitura do espelho voltou?',
    ).toMatch(/\.from\("omie_clientes"\)\s*\.upsert\(/);
    expect(
      src,
      'REVERSÃO Lovable? voltou a .select() do espelho poluído omie_clientes no caminho money-path',
    ).not.toMatch(/\.from\("omie_clientes"\)\s*\.select/);
  });

  it('fallback API do PEDIDO é fail-closed: registros:2 + guard de truncamento (não 1=last-write-wins)', () => {
    // Ancorado no log único do pedido self-service (evita casar outros handlers que legitimamente usam :1).
    expect(
      src,
      'REVERSÃO Lovable? o fallback do pedido self-service não usa mais registros_por_pagina:2',
    ).toMatch(/buscando no Omie por CPF\/CNPJ[\s\S]{0,300}registros_por_pagina:\s*2/);
    expect(
      src,
      'REGRESSÃO: o fallback do pedido self-service voltou a registros_por_pagina:1 (last-write-wins)',
    ).not.toMatch(/buscando no Omie por CPF\/CNPJ[\s\S]{0,300}registros_por_pagina:\s*1/);
    // Codex P1: registros:2 não prova unicidade se truncado → o edge deriva omieTruncado de total_de_paginas
    // e passa ao helper. Sem isso, [200,200] na pág.1 esconderia um 201 na pág.2 (chuta 200).
    expect(
      src,
      'REGRESSÃO: sumiu o guard de truncamento (total_de_paginas → omieTruncado) — furo do registros:2 reaberto',
    ).toMatch(/omieTruncado\s*=\s*\(searchResult\.total_de_paginas[\s\S]{0,140}omieTruncado/);
  });

  it('fail-closed em doc-ambíguo presente (não chuta o 1º código na duplicata-CNPJ)', () => {
    expect(src, 'sumiu o ramo fail-closed doc-ambíguo do pedido').toMatch(/erro === "doc-ambíguo"/);
  });

  it('PARIDADE: o bloco espelhado no edge é IDÊNTICO ao helper de src/ (pega reversão do Lovable)', () => {
    expect(
      mirrorBlockNamed(src, 'omie-sync-identidade'),
      'edge divergiu do helper de src/ — o Lovable reescreveu a lógica de identidade no deploy?',
    ).toBe(mirrorBlockNamed(helper, 'omie-sync-identidade'));
  });
});

// ── P0-B-bis PR-2 (omie-vendas-sync syncPedidos: cache codigo->user pela view fresca account-correta) ──
// O cache que resolve codigo_cliente->user_id nos pedidos vinha do espelho poluído omie_clientes SEM filtro
// de conta. Código Omie é numerado POR conta → o mesmo número em contas diferentes colidia na chave global
// do cache e mapeava o user_id ERRADO (bug #4 do design; o espelho é sobrescrito ao longo do dia pelos
// writers colacor_sc, então a colisão é intermitente). Migrado p/ a view fresca account-correta
// (.eq('account', account)) + .order estável no .range (armadilha PostgREST). A paridade textual aqui pega
// a reversão do deploy do Lovable. As leituras de omie_clientes em ~:1703/~:2393 são o guard
// codeBelongsToWrongAccount (P0-A, precisa ver TODAS as contas) — FORA desta PR, intocadas. Ver design §4/§5.
const VENDAS_SYNC = 'supabase/functions/omie-vendas-sync/index.ts';

describe('guardrail money-path: syncPedidos resolve user pela view fresca account-correta (P0-B-bis PR-2)', () => {
  const src = read(VENDAS_SYNC);

  it('sentinela: leu o arquivo real (edge)', () => {
    expect(src).toContain('syncPedidos');
    expect(src).toContain('clientCache');
  });

  it('o cache codigo->user vem da VIEW FRESCA account-correta, por conta, paginado por KEYSET', () => {
    // Exige a cadeia keyset completa: from(fresco) → eq(account) → gt(codigo) → limit. Fecha o furo Codex P3
    // (o regex antigo não exigia paginação: remover o .limit truncaria o cache em 1 página e passaria).
    expect(
      src,
      'REVERSÃO Lovable? o cache do syncPedidos não lê a view fresca por conta com paginação keyset (.gt+.limit)',
    ).toMatch(/from\('omie_customer_account_map_fresco'\)[\s\S]{0,180}\.eq\('account', account\)[\s\S]{0,80}\.gt\('omie_codigo_cliente'[\s\S]{0,80}\.limit\(/);
  });

  it('o pré-load do cache é FAIL-CLOSED em erro de query (não engole o error → cache parcial, Codex P2)', () => {
    expect(
      src,
      'REGRESSÃO: o pré-load engole o erro da query — cache parcial silencioso → rate-limit no fallback',
    ).toMatch(/if \(cacheErr\) throw new Error/);
  });

  it('o cache NÃO voltou a carregar do espelho poluído omie_clientes (anti-reversão do bug #4)', () => {
    expect(
      src,
      'REGRESSÃO: o cache do syncPedidos voltou a carregar do espelho omie_clientes (bug #4 reaberto)',
    ).not.toMatch(/Client cache from omie_clientes/);
    expect(
      src,
      'sentinela do log novo: o cache reporta a fonte account-correta',
    ).toMatch(/Client cache from omie_customer_account_map_fresco/);
  });

  // [2026-07-16] O assert que travava a NÃO-migração do guard `codeBelongsToWrongAccount` saiu com o
  // guard. Ele exigia que o guard lesse o espelho por user SEM filtro de conta — correto para a ideia
  // ("filtrar só a conta-alvo o desligaria"), mas a leitura sem filtro é justamente o que trazia a
  // linha rotulada 'colacor' com o código OBEN e produzia a prova positiva FALSA. O guard foi removido
  // (ver o invariante do espelho no topo); esta via segue vigiada pelo assert do cache acima.
});

// ── P0-B-bis (incidente carteira, ponta 1/2): o writer popula o vendedor de recomendacoes NA PROOF ──
// A carteira estava 100% Hunter: o writer gravava omie_codigo_vendedor lendo só c.codigo_vendedor (raiz
// vazio) → proof NULL → todo cliente órfão. O vendedor mora em recomendacoes.codigo_vendedor. O writer
// popula o vendedor SÓ na PROOF (document-first, account-safe) via helper extrairCodigoVendedor (Codex R2:
// recomendacoes é autoritativa, só inteiro safe positivo). O mirror code-first NÃO recebe (Codex BLOCKou
// popular o mirror inseguro). A ponta 2/2 (carteira-rebuild LER a proof) é PR próprio — o rebuild tem
// consolidação B-lite (herança cross-account) que exige redesign account-safe (Codex R2: 3 P1).
const ANALYTICS_V = 'supabase/functions/omie-analytics-sync/index.ts';
const VEND_HELPER = 'src/lib/omie/codigo-vendedor.ts';

describe('guardrail money-path: writer popula vendedor de recomendacoes na PROOF (P0-B-bis)', () => {
  const analytics = read(ANALYTICS_V);
  const helper = read(VEND_HELPER);

  it('sentinela: leu os arquivos reais', () => {
    expect(analytics).toContain('syncCustomers');
    expect(helper).toContain('extrairCodigoVendedor');
  });

  it('o helper puro existe e exporta extrairCodigoVendedor', () => {
    expect(helper).toMatch(/export function extrairCodigoVendedor/);
  });

  it('o writer USA o helper espelhado na PROOF (define + chama), NÃO o campo raiz cru', () => {
    expect(analytics, 'sumiu a definição espelhada do helper').toMatch(/function extrairCodigoVendedor/);
    expect(
      analytics,
      'REVERSÃO Lovable? a proof não usa mais extrairCodigoVendedor (vendedor volta a NULL → carteira Hunter)',
    ).toMatch(/omie_codigo_vendedor: extrairCodigoVendedor\(c\),\s*\n\s*source: "document"/);
    expect(count(analytics, 'extrairCodigoVendedor'), 'helper deve ser DEFINIDO e CHAMADO (≥2)').toBeGreaterThanOrEqual(2);
  });

  it('PARIDADE: o bloco espelhado do helper é IDÊNTICO ao src/ (pega reversão do Lovable)', () => {
    expect(
      mirrorBlockNamed(analytics, 'omie-codigo-vendedor'),
      'edge divergiu do helper de src/ — Lovable reescreveu a extração do vendedor?',
    ).toBe(mirrorBlockNamed(helper, 'omie-codigo-vendedor'));
  });
});

// ── P0-B-bis (incidente carteira, ponta 2/2): carteira-rebuild LÊ o vendedor da PROOF oben ──
// O rebuild deixou de tirar o vendedor do espelho poluído (omie_clientes.omie_codigo_vendedor, NULL) e
// passou a lê-lo da view fresca account-correta omie_customer_account_map_fresco(account='oben'). A LISTA
// de membros continua do espelho (preserva a herança B-lite + cobertura). Guards fail-closed: proof oben
// anômala (vazia/<50%/0-vendedor) OU resultado 100% Hunter → aborta ANTES de escrever (não zera a carteira).
const REBUILD = 'supabase/functions/carteira-rebuild/index.ts';
const REBUILD_HELPER = 'src/lib/carteira/rebuild-helpers.ts';

describe('guardrail money-path: carteira-rebuild lê o vendedor da PROOF oben (P0-B-bis ponta 2/2)', () => {
  const rebuild = read(REBUILD);
  const rebuildHelper = read(REBUILD_HELPER);

  it('sentinela: leu os arquivos reais (edge + helper)', () => {
    expect(rebuild).toContain('computeCarteira');
    expect(rebuildHelper).toContain('coerceCodigoVendedor');
  });

  it('o VENDEDOR vem da view fresca account=oben (4ª leitura money-path), não do espelho poluído', () => {
    expect(
      rebuild,
      'REVERSÃO Lovable? sumiu a leitura da proof fresca account-correta (vendedor volta ao espelho NULL → carteira Hunter)',
    ).toMatch(/from\(['"]omie_customer_account_map_fresco['"]\)[\s\S]{0,220}\.eq\(['"]account['"],\s*['"]oben['"]\)/);
  });

  // D1/D6: o outro lado do join TEM de ser account-scoped. Esta é a única defesa contra a remoção do filtro:
  // a quarentena do conflito (D2) NÃO pega o caso mais perigoso — um código oben que casa com UMA única linha
  // de outra conta resolve users.size===1 → source='omie', eligible=true, vendedor ERRADO, sem conflito nenhum
  // (misatribuição SILENCIOSA). O helper puro não pode detectá-la: ele só vê o mapa que o edge lhe entrega.
  it('D1: o omie_vendedor_map é lido account-scoped (oben) — sem isso o join cruza namespaces de conta', () => {
    expect(
      rebuild,
      'REVERSÃO Lovable? sumiu o .eq(omie_account, oben) do vendedor_map — código oben pode casar com linha colacor/colacor_sc de OUTRO vendedor → source=omie + eligible=true + vendedor ERRADO, sem sinal de conflito',
    ).toMatch(/from\(['"]omie_vendedor_map['"]\)[\s\S]{0,160}\.eq\(['"]omie_account['"],\s*['"]oben['"]\)/);
  });

  // D3: sem Hunter o helper não emite órfão NEM conflito (owner_user_id é NOT NULL) → ~4162 membros sem row →
  // upsert-only preserva o assignment ANTIGO (stale). Nenhum guard de cardinalidade pega (contam linhas).
  it('D3: aborta quando carteira_hunter_user_id está ausente (senão órfão/conflito somem → stale)', () => {
    expect(
      rebuild,
      'sumiu o guard fail-closed de Hunter ausente — órfãos e conflitos ficariam sem row e o assignment antigo seguiria válido',
    ).toMatch(/if\s*\(!hunterUserId\)\s*\{[\s\S]{0,200}failLease\(/);
  });

  // D4: a pós-condição prova o CONJUNTO (os outros guards contam LINHAS e são cegos ao membro omitido).
  it('D4: pós-condição de cobertura roda sobre o payload real e ANTES do upsert', () => {
    expect(rebuild, 'sumiu a chamada de verificarCobertura').toMatch(/verificarCobertura\(membroIds,\s*rows\)/);
    expect(
      rebuild,
      'cobertura não aborta o run — membro sem row entraria como assignment antigo STALE',
    ).toMatch(/if\s*\(!cobertura\.ok\)[\s\S]{0,160}failLease\(/);
    const iCobertura = rebuild.indexOf('verificarCobertura(membroIds, rows)');
    const iUpsert = rebuild.indexOf(".from('carteira_assignments')");
    expect(iCobertura, 'âncora: não achei a chamada de verificarCobertura').toBeGreaterThan(-1);
    expect(iUpsert, 'âncora: não achei o upsert de carteira_assignments').toBeGreaterThan(-1);
    expect(iCobertura, 'a cobertura é verificada DEPOIS do upsert — inútil: o stale já foi gravado').toBeLessThan(iUpsert);
  });

  it('A LISTA de membros vem do carteira_membership_ledger, COM identity_state (Fatia 1 + 2)', () => {
    expect(
      rebuild,
      'REVERSÃO Lovable? a LISTA de membros não vem mais do ledger — voltou ao espelho omie_clientes?',
    ).toMatch(/from\(['"]carteira_membership_ledger['"]\)[\s\S]{0,80}select\(['"]user_id,\s*identity_state['"]\)/);
  });

  // ── P0-B-bis Fatia 2 (quarantine). O erro CATASTRÓFICO seria filtrar o quarantinado no BANCO: o membro
  // sumiria da entrada e o upsert-only (sem DELETE) preservaria o assignment antigo STALE — vendedor errado,
  // válido, cobrando comissão. É o mecanismo exato pelo qual o Codex refutou a opção A′ deste épico.
  it('o rebuild NÃO filtra identity_state no banco — o membro quarantinado TEM que vir na lista', () => {
    const selectLedger = /from\(['"]carteira_membership_ledger['"]\)[\s\S]{0,200}?\.range\(/;
    const bloco = rebuild.match(selectLedger)?.[0] ?? '';
    expect(bloco, 'sentinela: não achei o bloco de leitura do ledger').toContain('carteira_membership_ledger');
    expect(
      bloco,
      'REGRESSÃO GRAVE: o rebuild passou a filtrar identity_state no banco → o membro quarantinado SOME da entrada → o upsert-only deixa o assignment antigo STALE (vendedor errado cobrando comissão). Filtre em memória (extrairQuarantinados), nunca na query.',
    ).not.toMatch(/\.(eq|neq|in|not|filter)\(\s*['"]identity_state['"]/);
  });

  it('o quarantine é aplicado às rows finais (máscara ligada — não é dead code)', () => {
    expect(rebuild, 'sumiu a extração dos quarantinados do ledger').toContain('extrairQuarantinados(ledgerRows)');
    expect(
      rebuild,
      'REVERSÃO: as rows finais não passam mais por aplicarMascaras(flaggeds, quarantinados) → quarantine inerte, ambíguo volta a gerar comissão',
    ).toMatch(/aplicarMascaras\(assignments,\s*flaggeds,\s*quarantinados\)/);
  });

  it('o consumo de identity_state é FAIL-CLOSED (!== verified), não === ambiguous', () => {
    expect(
      rebuildHelper,
      'FAIL-OPEN: extrairQuarantinados passou a testar um estado específico — estado futuro/NULL deixaria de quarantinar',
    ).toMatch(/identity_state\s*!==\s*['"]verified['"]/);
  });

  it('anti-reversão: o carteira-rebuild NÃO lê mais omie_clientes em lugar nenhum (nem lista, nem vendedor)', () => {
    expect(
      rebuild,
      'REGRESSÃO: o carteira-rebuild voltou a ler o espelho poluído omie_clientes (lista ou vendedor)',
    ).not.toMatch(/from\(['"]omie_clientes['"]\)/);
  });

  it('guards presentes E USADOS — não ignorados (wiring, P2 Codex)', () => {
    expect(rebuild, 'guard pré não usa proofCrua como denominador (#4)').toMatch(/avaliarGuardProof\(\{\s*proofCrua/);
    expect(rebuild, 'retorno do guard pré ignorado').toContain('guardPre.abortar');
    expect(rebuild, 'sumiu o guard comparativo pós-compute (#1/#2)').toMatch(/avaliarGuardResultado\(\{\s*omieElegivelNovo/);
    expect(rebuild, 'retorno do guard pós ignorado').toContain('guardPos.abortar');
    expect(rebuild, 'guard pós não filtra por eligible — conta inelegíveis (#3)').toMatch(/r\.source === 'omie' && r\.eligible/);
    expect(rebuild, 'sumiu a leitura de count (proof crua + carteira atual)').toContain("count: 'exact'");
  });
  it('guard comparativo vem ANTES do upsert da carteira (não movido p/ depois — P2 Codex)', () => {
    const iGuard = rebuild.indexOf('avaliarGuardResultado({');
    const iUpsert = rebuild.indexOf("from('carteira_assignments').upsert(");
    expect(iGuard, 'avaliarGuardResultado não encontrado').toBeGreaterThan(0);
    expect(iUpsert, 'upsert da carteira não encontrado').toBeGreaterThan(0);
    expect(iGuard, 'guard comparativo foi movido p/ DEPOIS do upsert').toBeLessThan(iUpsert);
  });
  it('baseline persistido + bootstrap flag presentes E USADOS (Codex R2-R3)', () => {
    expect(rebuild, 'sumiu a leitura do baseline persistido').toContain("'carteira_omie_baseline'");
    expect(rebuild, 'guard não recebe baselinePersistido + autorizado').toMatch(/avaliarGuardResultado\(\{[\s\S]{0,120}baselinePersistido,\s*autorizado\s*\}/);
    expect(rebuild, 'flag de bootstrap não vem do query param').toMatch(/searchParams\.get\('bootstrap'\)/);
    expect(rebuild, 'baseline não é PERSISTIDO após o upsert (catraca volta)').toMatch(/upsert\(\{\s*key: 'carteira_omie_baseline'/);
    // R3 #2: a flag é gated em service_role/cron (não staff comum — employee comprometido não força bootstrap)
    expect(rebuild, 'flag de bootstrap não é gated por auth.via').toMatch(/auth\.via === 'service_role'/);
    // R3 P2: o baseline lido é VALIDADO (corrompido → aborta, não vira valor inseguro)
    expect(rebuild, 'baseline lido não é validado (parseBaselineSaudavel)').toContain('parseBaselineSaudavel(');
    expect(rebuild, 'baseline corrompido não aborta').toMatch(/baselinePersistido === null/);
  });

  it('PARIDADE: as funções de load espelhadas são IDÊNTICAS ao src/ (pega reversão do Lovable)', () => {
    expect(
      mirrorBlockNamed(rebuild, 'carteira-load'),
      'edge divergiu de rebuild-helpers.ts — Lovable reescreveu o load/guard?',
    ).toBe(mirrorBlockNamed(rebuildHelper, 'carteira-load'));
  });

  // ── CANÁRIA DE DEPLOY (?canary=1) — prova o que está SERVIDO (a paridade textual só cobre a FONTE) ──
  describe('canária de deploy ?canary=1', () => {
    const bloco = rebuild.match(/searchParams\.get\('canary'\) === '1'\)[\s\S]*?\n  \}/)?.[0] ?? '';

    it('sentinela: o bloco da canária existe no edge', () => {
      expect(bloco, 'sumiu a canária ?canary=1 — sem ela não há prova do DEPLOY, só da fonte').not.toBe('');
    });

    it('roda o helper REAL (computeCarteira + verificarCobertura), não uma reimplementação', () => {
      expect(bloco, 'canária não chama computeCarteira — não provaria o helper deployado').toContain('computeCarteira(');
      expect(bloco, 'canária não chama verificarCobertura').toContain('verificarCobertura(');
    });

    it('o `expected` casa a verdade-base provada em rebuild-helpers.test.ts (senão a canária mente verde)', () => {
      expect(bloco).toMatch(/membroConflitadoPresente: true/);
      expect(bloco).toMatch(/conflitadoSource: 'hunter_orphan'/);
      expect(bloco).toMatch(/conflitadoEligible: false/);
      expect(bloco).toMatch(/conflitadoCodigo: 222/);
      expect(bloco).toMatch(/coberturaOk: true/);
    });

    it('a fixture tem o CONFLITO (código 222 → 2 vendedores) — é o que discrimina velho×novo', () => {
      expect(bloco, 'fixture sem código repetido p/ 2 user_ids → canária não discrimina deploy velho').toMatch(
        /omie_codigo_vendedor: 222, user_id: '[^']*a'[\s\S]{0,120}omie_codigo_vendedor: 222, user_id: '[^']*b'/,
      );
    });

    it('NÃO escreve e NÃO toma o lease: roda ANTES do claim e retorna dentro do próprio bloco', () => {
      const iCanary = rebuild.indexOf("searchParams.get('canary')");
      const iClaim = rebuild.indexOf('claim_carteira_rebuild');
      expect(iCanary, 'âncora: não achei a canária').toBeGreaterThan(-1);
      expect(iClaim, 'âncora: não achei o claim do lease').toBeGreaterThan(-1);
      expect(iCanary, 'canária DEPOIS do lease — uma checagem bloquearia um rebuild real').toBeLessThan(iClaim);
      expect(bloco, 'canária faz escrita (upsert/insert/update/delete) — deve ser PURA').not.toMatch(/\.(upsert|insert|update|delete)\(/);
      expect(bloco, 'canária não retorna dentro do bloco — cairia no fluxo de rebuild real').toContain('return new Response(');
    });

    it('é staff-gated: vem DEPOIS do authorizeCronOrStaff', () => {
      const iAuth = rebuild.indexOf('authorizeCronOrStaff(req)');
      expect(iAuth).toBeGreaterThan(-1);
      expect(iAuth, 'canária ANTES do gate de auth — exposta a anônimo').toBeLessThan(rebuild.indexOf("searchParams.get('canary')"));
    });
  });

  // D5: computeCarteira (o CORE money-path) vivia duplicada no edge FORA de qualquer guarda de paridade —
  // dava p/ corrigir o helper testado e esquecer o edge real (achado Codex). Agora está no bloco carteira-compute.
  it('PARIDADE: computeCarteira é IDÊNTICA ao src/ (o core money-path — pega reversão do Lovable)', () => {
    expect(
      mirrorBlockNamed(rebuild, 'carteira-compute'),
      'edge divergiu de rebuild-helpers.ts — Lovable reescreveu computeCarteira?',
    ).toBe(mirrorBlockNamed(rebuildHelper, 'carteira-compute'));
  });

  // D2: o conflito de mapeamento é QUARANTINADO no edge, não omitido (senão upsert-only → stale).
  it('D2: emitLegado quarantina o conflito (hunter_orphan + eligible:false), não omite', () => {
    const bloco = mirrorBlockNamed(rebuild, 'carteira-compute');
    expect(
      bloco,
      'REGRESSÃO: o ramo de conflito de emitLegado voltou a NÃO emitir → membro some → assignment antigo STALE',
    ).toMatch(/else if \(hunterUserId\)[\s\S]{0,220}source: 'hunter_orphan'[\s\S]{0,80}eligible: false/);
  });
});

// ── P0-B-bis Fatia 2 — ESCRITOR do identity_state (omie-analytics-sync). Par do DELETE da proof: o vínculo
// sai da proof, mas o MEMBRO fica no ledger marcado `ambiguous` → o rebuild o quarantina. Sem a marcação o
// ambíguo perde o vendedor, vira órfão e cai no Hunter com eligible=TRUE (comissão sobre identidade que não
// conhecemos). Sem a REVERSÃO vira catraca de mão única (doc corrigido → cliente invisível para sempre).
describe('guardrail money-path: omie-analytics-sync popula identity_state no ledger (P0-B-bis Fatia 2)', () => {
  const src = read(ANALYTICS);

  it('sentinela: leu o arquivo real', () => {
    expect(src).toContain('docsComCodigoAmbiguoNoOmie');
  });

  it('marca `ambiguous` no ledger — o par do DELETE da proof', () => {
    expect(
      src,
      'REVERSÃO: sumiu a marcação de ambiguous no ledger → o doc ambíguo volta a cair no Hunter ELEGÍVEL (comissão indevida)',
    ).toMatch(/from\(["']carteira_membership_ledger["']\)[\s\S]{0,160}identity_state:\s*["']ambiguous["']/);
  });

  it('reverte `ambiguous`→`verified` p/ quem o run PROVOU limpo (senão: catraca de mão única)', () => {
    expect(
      src,
      'REGRESSÃO: sumiu a reversão → doc corrigido no Omie deixaria o cliente quarantinado (invisível, sem comissão) PARA SEMPRE',
    ).toMatch(/identity_state:\s*["']verified["']/);
    expect(
      src,
      'a reversão não está escopada ao que o run provou limpo (accountMapByUser) → risco de reverter ambíguo real',
    ).toMatch(/accountMapByUser\.has\(/);
  });

  it('SÓ o run oben (account===vendas) escreve o ledger — identity_state é global, ambiguidade é por conta', () => {
    // D5: os 3 runs escrevendo se sobrescreveriam (flapping — um marca, o outro desmarca).
    const marcacao = src.match(/if \(account === "vendas" && usersAmbiguosOmie\.size > 0\)/);
    expect(marcacao, 'a marcação de ambiguous não está gateada em account==="vendas" → flapping entre contas').not.toBeNull();
  });

  it('o ledger NUNCA recebe INSERT/upsert aqui — quem popula é o trigger da Fatia 0 (acumulador)', () => {
    const blocos = src.match(/from\(["']carteira_membership_ledger["']\)\s*\.\w+/g) ?? [];
    expect(blocos.length, 'sentinela: não achei acesso ao ledger no sync').toBeGreaterThan(0);
    for (const b of blocos) {
      expect(b, `o sync está escrevendo no ledger com algo que não é update/select ("${b}") — o ledger é acumulador; inserir aqui fura o trigger da Fatia 0`).toMatch(/\.(update|select)$/);
    }
  });
});

// ── P0-B-bis PR-4 #8 (fin-valor-cockpit: mapa user->codigo de DISPLAY pela view fresca account=oben) ──
// O cockpit (COMPANY='oben') montava o mapa user_id->omie_codigo_cliente lendo o espelho poluído
// omie_clientes SEM filtro de conta — o código exibido podia ser de OUTRA conta do mesmo user (colacor_sc
// domina o espelho). Migrado p/ a view fresca account-correta com account=oben. Display (ℹ️ baixo, não
// roteia dinheiro) → paginação offset .range basta (o syncPedidos, money-path, exige keyset; aqui um miss
// de TTL entre páginas só omitiria 1 código do display). Este canário pega a reversão do deploy do Lovable.
const VALOR_COCKPIT = 'supabase/functions/fin-valor-cockpit/index.ts';

describe('guardrail: fin-valor-cockpit lê o código do cliente pela view fresca account=oben (P0-B-bis PR-4 #8)', () => {
  const src = read(VALOR_COCKPIT);

  it('sentinela: leu o arquivo real (mapa de display userToOmie)', () => {
    expect(src).toContain('userToOmie');
  });

  it('o mapa user->codigo (display) vem da view fresca account=oben, não do espelho poluído', () => {
    expect(
      src,
      'REVERSÃO Lovable? o cockpit voltou a ler o código do cliente do espelho omie_clientes sem conta',
    ).toMatch(/from\("omie_customer_account_map_fresco"\)[\s\S]{0,200}\.eq\("account", "oben"\)/);
    expect(
      src,
      'REGRESSÃO: fin-valor-cockpit ainda lê o espelho poluído omie_clientes no mapa de display',
    ).not.toMatch(/from\("omie_clientes"\)/);
  });
});

// ── PR1 reconciliação PO excluído: publicação diferida (edge USA os predicados espelhados) — Codex xhigh 2026-07-12 ──
// A edge omie-sync-pedidos-compra publica o marcador de run + last_seen SÓ no fim de um completo LIMPO e
// NÃO-filtrado (P1#1/#2) e só avança a cadência com volume_ok=true (P1#3). Essas 2 decisões são helpers puros
// (vitest) espelhados no edge; a paridade textual aqui pega a reversão do deploy do Lovable. O coração
// money-path (volume_ok robusto, atomicidade, RLS) é provado no PG17 (db/test-reposicao-publicar-run-completo.sh).
const SYNC_PEDIDOS = 'supabase/functions/omie-sync-pedidos-compra/index.ts';
const PUBLICACAO_RUN = 'src/lib/reposicao/publicacao-run.ts';
const OMIE_PAGINA = 'src/lib/reposicao/omie-pagina.ts';

describe('guardrail money-path: publicação diferida de run (edge USA os predicados espelhados) — PR1 PO excluído', () => {
  const src = read(SYNC_PEDIDOS);
  const helper = read(PUBLICACAO_RUN);
  const parser = read(OMIE_PAGINA);

  it('sentinela: leu os arquivos reais (edge + helpers)', () => {
    expect(src).toContain('reposicao_publicar_run_completo');
    expect(helper).toContain('devePublicarRun');
    expect(parser).toContain('classificarPagina');
  });

  it('o helper puro existe e exporta devePublicarRun', () => {
    expect(helper).toMatch(/export function devePublicarRun/);
  });

  it('o edge USA o predicado: define o MIRROR de devePublicarRun E o chama (≥2 menções)', () => {
    expect(src, 'edge não define mais devePublicarRun espelhado').toMatch(/function devePublicarRun/);
    expect(count(src, 'devePublicarRun'), 'devePublicarRun deve ser DEFINIDO e CHAMADO (≥2)').toBeGreaterThanOrEqual(2);
  });

  it('v3.2 P1#2: devePublicarRun NÃO gateia por summary.erros (erro de persistência do espelho não barra)', () => {
    // erro de PERSISTÊNCIA (upsert torto) não corrompe idsVistos; erro de COLETA já vira varredura_completa=false.
    const bloco = mirrorBlockNamed(src, 'reposicao publicacao-run');
    expect(bloco, 'REGRESSÃO Codex v3.2 P1#2: devePublicarRun voltou a checar erros===0 (trava em upsert torto)')
      .not.toMatch(/erros\s*===\s*0/);
  });

  it('P1#1/single-writer: a edge NÃO escreve o last_seen direto (só a RPC toca reposicao_po_last_seen)', () => {
    // o last_seen mora numa tabela DEDICADA service_role-only — a edge só chama a RPC, nunca escreve nela.
    expect(
      src,
      'REGRESSÃO: a edge escreve reposicao_po_last_seen direto (deveria ser só pela RPC service_role-only)',
    ).not.toMatch(/from\(["']reposicao_po_last_seen["']\)/);
  });

  it('P1#3/v3.2 P1: marcarCompletoOk é gated pelo SUCESSO da publicação (publicou), NÃO por volume_ok', () => {
    // a cadência avança se a RPC publicou (marcador gravado) — não pelo volume_ok, senão um run de baixo
    // volume/vazio travaria o completo permanentemente (Codex v3.2 P1). Erro da RPC → publicou=false → não avança.
    expect(
      src,
      'REGRESSÃO P1#3: a cadência não é mais gated pelo sucesso da publicação',
    ).toMatch(/if\s*\(publicou\)\s*await marcarCompletoOk/);
    expect(
      src,
      'REGRESSÃO Codex v3.2 P1: a cadência voltou a depender de volume_ok (trava o completo em baixo volume)',
    ).not.toMatch(/cadenciaPodeAvancar/);
  });

  it('v3.9: a edge DELEGA a classificação ao parser PURO e falha fechado em anomalia', () => {
    // SEIS Codex challenge xhigh acharam furos na classificação inline, um shape por vez — e os guardrails eram
    // textuais (grep de nome), que não provam comportamento. Agora a decisão vive no parser PURO
    // (src/lib/reposicao/omie-pagina.ts) com matriz COMPORTAMENTAL em omie-pagina.test.ts; aqui só garantimos
    // que a edge realmente delega, trata anomalia fail-closed e não reintroduz o TETO.
    expect(src, 'a edge não acumula o piso pelo parser (acumularPiso)').toContain('piso = acumularPiso(resp, piso)');
    expect(
      src,
      'a edge não classifica a página pelo parser (classificarPagina)',
    ).toMatch(/classificarPagina\(resp,\s*\{\s*pagina,\s*idsVistos,\s*piso\s*\}\)/);
    expect(src, 'a edge não aborta em anomalia do parser (fail-closed)').toMatch(/cls\.tipo === "anomalia"/);
    expect(src, 'a edge não encerra pelo fim do parser').toMatch(/cls\.tipo === "fim"/);
    expect(
      src,
      'varredura_completa deixou de exigir fim && !abortado (toda invalidação vem como anomalia → abortado)',
    ).toMatch(/varredura_completa = fim && !abortado/);
    // o TETO segue PROIBIDO: parar a paginação por nTotalPaginas reintroduz #979/#1009 (o Omie SUB-REPORTA).
    expect(
      src,
      'REGRESSÃO: a edge voltou a PARAR a paginação por nTotalPaginas (sub-reporta → perde POs)',
    ).not.toMatch(/pagina\s*>\s*(resp\.)?nTotalPaginas|>=\s*(resp\.)?nTotalPaginas\)\s*(\{)?\s*break/);
  });

  it('v3.3 P1/fencing: a edge aloca o run_seq ANTES da coleta e passa p_seq à RPC (ordem de INÍCIO)', () => {
    // fencing token (reposicao_alocar_run_seq) alocado ANTES de syncEmpresa e passado como p_seq: um coletor que
    // começa antes mas publica depois recebe seq MENOR → NÃO suprime a prova por ID de um PO excluído (Codex v3.3 P1).
    expect(src, 'a edge não aloca o fencing token (reposicao_alocar_run_seq)').toContain('reposicao_alocar_run_seq');
    expect(src, 'a RPC de publicação não recebe p_seq (perdeu a ordem total de INÍCIO)').toMatch(/p_seq:\s*runSeq/);
    const idxAloca = src.indexOf('await alocarRunSeq(');
    const idxSync = src.indexOf('await syncEmpresa(');
    expect(idxAloca, 'alocarRunSeq não é chamado com await').toBeGreaterThan(0);
    expect(
      idxAloca < idxSync,
      'REGRESSÃO Codex v3.3 P1: o fencing token deve ser alocado ANTES de syncEmpresa (ordem de INÍCIO, não de publicação)',
    ).toBe(true);
    // Codex #9 P1: NENHUM await de REDE entre o token e a 1ª página. Com o heartbeatRunning no meio, um run mais
    // NOVO coleta e publica primeiro enquanto o R1 trava no heartbeat; o token velho deixa de refletir a ordem de
    // início, e um PO excluído nessa janela fica com last_seen == marcador → nunca vira candidato, a prova por ID
    // nunca roda e o fantasma sobrevive. O heartbeat tem de vir ANTES da alocação.
    const idxHeartbeat = src.indexOf('await heartbeatRunning(');
    expect(idxHeartbeat, 'heartbeatRunning não encontrado').toBeGreaterThan(0);
    expect(
      idxHeartbeat < idxAloca,
      'REGRESSÃO Codex #9 P1: heartbeatRunning (await de REDE) voltou a ficar ENTRE o fencing token e a coleta',
    ).toBe(true);
  });

  it('PARIDADE: o parser omie-pagina espelhado no edge é IDÊNTICO ao de src/ (pega reversão do Lovable)', () => {
    // A classificação de página é a lógica que SEIS Codex challenge furaram, um shape por vez. Ela vive no parser
    // PURO (matriz comportamental em src/lib/reposicao/omie-pagina.test.ts); o edge carrega um espelho, porque
    // Deno não importa de src/. Se o deploy do Lovable reescrever o espelho, a divergência aparece AQUI.
    expect(
      mirrorBlockNamed(src, 'reposicao omie-pagina'),
      'edge divergiu do parser de src/ — o Lovable reescreveu a classificação de página no deploy?',
    ).toBe(mirrorBlockNamed(parser, 'reposicao omie-pagina'));
  });

  it('PARIDADE: o helper publicacao-run espelhado no edge é IDÊNTICO ao de src/ (pega reversão do Lovable)', () => {
    expect(
      mirrorBlockNamed(src, 'reposicao publicacao-run'),
      'edge divergiu do helper de src/ — o Lovable reescreveu os predicados no deploy?',
    ).toBe(mirrorBlockNamed(helper, 'reposicao publicacao-run'));
  });
});

// ── P0-B-bis ponta 3 (ai-ops-agent: farmer_id vem da carteira canônica, não do espelho circular) ──
// DOIS bugs (investigados 2026-07-12, psql-ro + leitura): BUG-1 (circular, PRÉ-EXISTENTE) — o edge fazia
// `farmer_id: assignment?.user_id` com assignment.user_id === m.customer_user_id → o "dono" era o PRÓPRIO
// cliente (useExcecoesGestor.ts:112 `donoNome: nome(d.farmer_id)` mostra o nome do cliente como dono no
// Console de Exceções do gestor). BUG-2 (regressão da ponta 1 #1293) — omie_clientes.omie_codigo_vendedor
// virou 100% NULL (o vendedor mudou-se p/ a proof). Fix (Opção A, decisão do founder 2026-07-12): resolve o
// farmer da fonte CANÔNICA carteira_assignments.owner_user_id via owner-map (buildOwnerMap/resolveOwner),
// herdando os guards fail-closed + Hunter/B-lite/eligible da ponta 2 (carteira-rebuild). Edge TS puro, sem SQL.
// Este canário textual pega a reversão do deploy do Lovable (mesma armadilha do #1272). Ver
// docs/agent/money-path.md e o design da ponta 2 (2026-07-11-carteira-rebuild-vendedor-proof-ponta2-design.md).
const AIOPS = 'supabase/functions/ai-ops-agent/index.ts';
const OWNER_MAP = 'src/lib/carteira/owner-map.ts';

describe('guardrail money-path: ai-ops-agent resolve farmer_id da carteira (Opção A, anti-circular)', () => {
  const src = read(AIOPS);
  const helper = read(OWNER_MAP);

  it('sentinela: leu os arquivos reais (edge + helper)', () => {
    expect(src).toContain('farmer_id');
    expect(helper).toContain('buildOwnerMap');
  });

  it('o helper puro existe e exporta buildOwnerMap + resolveOwner', () => {
    expect(helper).toMatch(/export function buildOwnerMap/);
    expect(helper).toMatch(/export function resolveOwner/);
  });

  it('o edge LÊ a carteira canônica (carteira_assignments) por KEYSET, e monta o mapa dos dados REAIS', () => {
    expect(
      src,
      'REVERSÃO Lovable? o ai-ops não lê mais carteira_assignments — o farmer voltou ao espelho circular?',
    ).toMatch(/from\(["']carteira_assignments["']\)/);
    // Keyset (.gt + .limit), não offset: carteira_assignments é dinâmica (rebuild concorrente 07:30) e o
    // offset pularia linha por churn → farmer_id null (Codex ponta 3 #3). Sem paginação a cauda >1000 sumiria.
    expect(
      src,
      'a leitura da carteira precisa ser KEYSET: .gt(customer_user_id) + .order + .limit',
    ).toMatch(/from\(["']carteira_assignments["']\)[\s\S]{0,260}\.gt\(["']customer_user_id["'][\s\S]{0,140}\.limit\(/);
    expect(
      src,
      'REGRESSÃO (Codex #2): a paginação keyset perdeu o avanço do cursor — truncaria em 1 página',
    ).toMatch(/lastCustomerId\s*=\s*rows\[rows\.length - 1\]/);
    // REGRESSÃO real (o 1º deploy ABORTOU em runtime): o cursor keyset em coluna UUID não pode iniciar em
    // "" — "" não casta para uuid no Postgres (invalid input syntax for type uuid ""). Sentinela = nil UUID.
    expect(
      src,
      'REGRESSÃO: cursor keyset inicia em "" — inválido em coluna UUID; derrubou o 1º deploy do ai-ops-agent',
    ).not.toMatch(/lastCustomerId\s*=\s*""/);
    expect(
      src,
      'o cursor keyset precisa de sentinela nil UUID válida (00000000-...-000000000000)',
    ).toMatch(/0{8}-0{4}-0{4}-0{4}-0{12}/);
    // Falso-verde que o Codex #2 pegou: buildOwnerMap([]) passaria os asserts frouxos. Trava o argumento REAL.
    expect(
      src,
      'REGRESSÃO (Codex #2): o ownerMap não é montado dos assignments reais (virou buildOwnerMap([])?)',
    ).toMatch(/buildOwnerMap\(assignmentsRaw\)/);
  });

  it('ANTI-CIRCULAR (BUG-1): farmer_id NÃO é mais o user_id do próprio cliente — vem de resolveOwner', () => {
    expect(
      src,
      'REGRESSÃO BUG-1: farmer_id voltou a ser assignment.user_id (o próprio cliente) — referência circular',
    ).not.toMatch(/farmer_id:\s*assignment\?\.user_id/);
    // Args EXATOS (Codex #2): fallback null e chave = customer_user_id. `farmer_id: m.customer_user_id`
    // (o bug circular) NÃO casaria isto — fecha o falso-verde do resolveOwner-sem-args.
    expect(
      src,
      'farmer_id deveria vir de resolveOwner(ownerMap, m.customer_user_id, null) — dono account-safe da carteira',
    ).toMatch(/farmer_id:\s*resolveOwner\(ownerMap,\s*m\.customer_user_id,\s*null\)/);
  });

  it('ANTI-REVERSÃO (BUG-2): o farmer NÃO vem mais do espelho poluído nem do dead code de employees', () => {
    expect(
      src,
      'REGRESSÃO BUG-2: o ai-ops voltou a ler omie_clientes p/ o vendedor (espelho 100% NULL)',
    ).not.toMatch(/from\(["']omie_clientes["']\)/);
    expect(
      src,
      'sumiu a limpeza do dead code — o edge ainda busca profiles is_employee sem usar (mapeamento fantasma)?',
    ).not.toContain('is_employee');
  });

  it('PURGE completo (Codex #1): apaga TODAS as pending, sem filtro de data — limpa o farmer_id circular antigo', () => {
    // O delete antigo filtrava created_at de HOJE → as 228 linhas circulares antigas (BUG-1) sobreviviam e
    // reapareciam no Console de Exceções quando a run gerava < 200 decisões. Purge sem data limpa o legado.
    expect(
      src,
      'REGRESSÃO (Codex #1): o purge de pending voltou a filtrar por created_at — o circular antigo sobrevive',
    ).not.toMatch(/\.eq\("status",\s*"pending"\)[\s\S]{0,140}created_at/);
    expect(
      src,
      'o purge de pending deveria ser fail-closed (erro do delete aborta antes de inserir → sem duplicata)',
    ).toMatch(/if \(purgeError\) throw/);
  });

  it('o edge USA o helper espelhado (define buildOwnerMap E chama), ≥2 menções', () => {
    expect(src, 'edge não define mais o helper espelhado owner-map').toMatch(/function buildOwnerMap/);
    expect(src, 'edge não chama mais buildOwnerMap — voltou à lógica inline?').toMatch(/buildOwnerMap\(/);
    expect(src, 'edge não chama mais resolveOwner').toMatch(/resolveOwner\(/);
    expect(
      count(src, 'buildOwnerMap'),
      'helper deve ser DEFINIDO e CHAMADO (≥2 menções)',
    ).toBeGreaterThanOrEqual(2);
  });

  it('PARIDADE: o bloco espelhado no edge é IDÊNTICO ao owner-map de src/ (pega reversão do Lovable)', () => {
    expect(
      mirrorBlockNamed(src, 'owner-map'),
      'edge divergiu de owner-map.ts — o Lovable reescreveu o mapeamento no deploy?',
    ).toBe(mirrorBlockNamed(helper, 'owner-map'));
  });
});

// ── Fila do sync de leadtime por item de NFe (omie-sync-sku-items) ──
// Incidente OBEN 2026-07-14: NFe cuja ConsultarRecebimento responde 0 itens não upserta,
// então nunca saía da fila (a fila era "sem linha em sku_leadtime_history") e era
// re-consultada em todo run — sob rate-limit, UMA consulta come os 50s do guard e as NFes
// antigas expiram da janela sem virar leadtime. O backoff vive num helper puro espelhado
// aqui; sem a paridade, um deploy do Lovable pode reverter o espelho e ressuscitar o poison.
const SKU_ITEMS = 'supabase/functions/omie-sync-sku-items/index.ts';
const SKU_ITEMS_FILA = 'src/lib/reposicao/sku-items-fila-helpers.ts';

describe('guardrail money-path: omie-sync-sku-items (fila de leadtime)', () => {
  const src = read(SKU_ITEMS);
  const helper = read(SKU_ITEMS_FILA);

  it('sentinela: leu os arquivos reais (edge + helper)', () => {
    expect(src).toContain('sku_leadtime_history');
    expect(src).toContain('ConsultarRecebimento');
    expect(helper).toContain('skuItemsBackoffMs');
  });

  it('o edge USA o helper espelhado: define E chama a elegibilidade + a ordenação', () => {
    expect(src, 'edge não define mais skuItemsElegivel').toMatch(/function skuItemsElegivel/);
    expect(src, 'REGRESSÃO: edge não filtra mais por elegibilidade — poison volta a entupir a fila')
      .toMatch(/skuItemsElegivel\(/);
    expect(src, 'REGRESSÃO: edge não ordena mais a fila — antigas voltam a nunca ser alcançadas')
      .toMatch(/skuItemsCompararFila\(/);
  });

  it('PARIDADE: o bloco espelhado no edge é IDÊNTICO ao helper de src/ (pega reversão do Lovable)', () => {
    expect(
      mirrorBlockNamed(src, 'sku-items-fila'),
      'edge divergiu de sku-items-fila-helpers.ts — o Lovable reescreveu a fila no deploy?',
    ).toBe(mirrorBlockNamed(helper, 'sku-items-fila'));
  });

  it('toda consulta marca tentativa: sem isso a NFe de 0 itens nunca sai da fila', () => {
    expect(
      count(src, 'marcarTentativa('),
      'marcarTentativa deve ser DEFINIDA e chamada no sucesso E na falha (≥3 menções)',
    ).toBeGreaterThanOrEqual(3);
  });

  it('erro sistêmico mede consultas TENTADAS, não NFes pendentes (mata o alerta falso)', () => {
    expect(
      src,
      'REGRESSÃO: voltou a marcar error por NFes pendentes — janela só com NFe sem nIdReceb ' +
        'acorda o Sentinela com "rate-limit?" falso, sem ter chamado a Omie (OBEN 2026-07-14)',
    ).toMatch(/consultas_tentadas\s*>\s*0\s*&&\s*\w*\.?consultas_detalhadas\s*===\s*0/);
    expect(src).not.toMatch(/nfes_processadas\s*>\s*0\s*&&\s*\w*\.?consultas_detalhadas\s*===\s*0/);
  });

  it('controle da fila é FAIL-CLOSED: tabela ausente grita, não degrada em silêncio', () => {
    expect(
      src,
      'REGRESSÃO: voltou a degradar quando sku_items_sync_controle falha — o poison ' +
        'reviveria sem ninguém saber (edge deployada antes da migration)',
    ).toMatch(/throw new Error\(\s*\n?\s*`sku_items_sync_controle ilegível/);
  });

  // O recompute derivado (RPC recomputar_leadtime_derivado) conserta o leadtime que nasce
  // NULL no faturamento e nunca volta à fila quando o t4 chega. Ele é LOCAL — não gasta Omie.
  it('o recompute derivado roda ANTES do loop da Omie, não depois', () => {
    const chamada = src.indexOf('await recomputarLeadtimeDerivado(supabase');
    const loop = src.indexOf('for (const nfeRaw of fila)');
    expect(chamada, 'edge não chama mais o recompute derivado — o leadtime volta a morrer NULL').toBeGreaterThan(-1);
    expect(loop, 'sentinela: o loop da fila sumiu do edge').toBeGreaterThan(-1);
    expect(
      chamada,
      'REGRESSÃO: o recompute saiu do início do run. O guard de 50s dá break no meio do ' +
        'loop justamente quando a fila está grande — no fim, ele deixaria de rodar EXATAMENTE ' +
        'nos dias com mais t4 novo para derivar.',
    ).toBeLessThan(loop);
  });

  it('falha do recompute é reportada ao Sentinela, não engolida', () => {
    expect(
      src,
      'REGRESSÃO: recompute falhando em silêncio — a causa provável é migration não ' +
        'aplicada (deploy fora de ordem), e o gap de ~30% voltaria a crescer sem ninguém saber',
    ).toMatch(/falhaSistemica \?\? falhaControle \?\? falhaRecompute/);
  });
});

// ── Fatia 3-edges PR-B (omie-analytics-sync: o snapshot de não-vinculados lê a proof por conta) ──
// classifyClienteForSnapshot decide se um cliente Omie entra no relatório omie_clientes_nao_vinculados:
// código no Set = "linked" (fica de fora). O Set vinha do espelho omie_clientes SEM filtro de conta —
// mas o espelho é UNIQUE(user_id) (1 linha/user, sobrescrita pelo writer da vez, hoje dominado por oben)
// e por isso NÃO contém os códigos das outras contas. Medido em prod (2026-07-16), códigos da proof
// ausentes do espelho: colacor 5.148/5.148 (100%), colacor_sc 3.604/5.275 (68%), oben 0/5.238 (0%).
// Rodar o snapshot de colacor/colacor_sc reportava clientes VINCULADOS como não-vinculados em massa;
// só oben roda hoje, o que mascarava o furo. Agora o Set vem da fresca com .eq("account", empresa).
// Os outros omie_clientes deste edge NÃO migram nesta PR e o motivo é estrutural, não esquecimento:
//   • :238 fetchOmieClienteUserMap alimenta o upsertByUser CODE-FIRST → é a leitura de suporte do
//     WRITER do espelho (:515), par indivisível: morre junto com ele na Fatia 4;
//   • :1669 fetchAlvosSemProfile / :1890 fetchOmieCodigoPorUser operam sobre os CLONES (user sem
//     profile). Medido: 1.633 alvos pelo espelho, 0 pela proof (clone não tem linha lá), 1.633 pelo
//     ledger — mas o ledger não tem omie_codigo_cliente, e essas funções precisam do par
//     (clone → código). Migrá-las p/ a proof zeraria syncBackfillCadastro e mapaConsolidacao em
//     SILÊNCIO. Bloqueio de design escalado — o DROP (Fatia 5) depende de resolvê-lo.
const OMIE_ANALYTICS = 'supabase/functions/omie-analytics-sync/index.ts';

describe('guardrail money-path: snapshot de não-vinculados lê a proof por conta (Fatia 3-edges PR-B)', () => {
  const src = read(OMIE_ANALYTICS);

  it('sentinela: leu o arquivo real (edge)', () => {
    expect(src).toContain('syncNaoVinculados');
    expect(src).toContain('classifyClienteForSnapshot');
  });

  it('o Set de "já vinculados" vem da fresca, filtrado pela conta do run, paginado com .order', () => {
    expect(
      src,
      'REVERSÃO Lovable? o Set de vinculados não lê a fresca com .eq("account", empresa) + .order + .range',
    ).toMatch(
      /\.from\("omie_customer_account_map_fresco"\)[\s\S]{0,120}\.eq\("account", empresa\)[\s\S]{0,240}\.order\("omie_codigo_cliente"\)[\s\S]{0,120}\.range\(/,
    );
    // A conta TEM de chegar na função: sem o parâmetro o Set volta a ser global (o bug).
    expect(
      src,
      'REGRESSÃO: fetchAllOmieClienteCodigos perdeu o parâmetro de conta — Set global de novo',
    ).toMatch(/async function fetchAllOmieClienteCodigos\(db: SupabaseClient, empresa: Empresa\)/);
    expect(
      src,
      'REGRESSÃO: o chamador não passa mais a empresa do run para o Set de vinculados',
    ).toMatch(/fetchAllOmieClienteCodigos\(db, empresa\)/);
  });

  it('o Set de vinculados NÃO voltou ao espelho poluído', () => {
    expect(
      src,
      'REGRESSÃO: fetchAllOmieClienteCodigos voltou a ler omie_clientes (Set global → falso não-vinculado)',
    ).not.toMatch(/fetch omie_clientes codigos/);
  });

  it('os omie_clientes restantes são o writer + as 2 funções de CLONE (bloqueadas), nunca mais', () => {
    // Trava o escopo: 4 = :238 (leitura de suporte do writer) + :515 (upsert) + fetchAlvosSemProfile
    // + fetchOmieCodigoPorUser. Se virar 5, alguém reabriu uma leitura do espelho neste edge.
    expect(
      count(src, '.from("omie_clientes")'),
      'omie_clientes mudou de contagem neste edge — leitura nova do espelho ou migração não registrada aqui',
    ).toBe(4);
  });
});

// ── Fatia 3-edges PR-A (omie-cliente: os 3 LEITORES saem do espelho → proof fresca account-correta) ──
// Os 3 leitores do edge de cadastro resolviam identidade por um código de conta INDETERMINADA. O espelho
// omie_clientes é UNIQUE(user_id) — 1 linha por user, sobrescrita pelo writer da vez (oben, colacor_sc…) —
// e empresa_omie está 'colacor' em 6.909/6.909 linhas (o DEFAULT, nunca populado): o rótulo de conta é
// mentiroso. Migrados p/ omie_customer_account_map_fresco, que é UNIQUE(user_id, account) e
// UNIQUE(omie_codigo_cliente, account) → .maybeSingle() seguro. A conta de CADA leitor saiu do CHAMADOR,
// não de presunção (as credenciais do edge enganam: callOmieApi é colacor_sc, mas não é ela que decide):
//   • criar_perfil_local → 'oben'  — useUnifiedOrder.handleStaffAddTool passa selectedCustomer.codigo_cliente
//     (código OBEN) e resolve o MESMO código com .eq('account','oben') logo antes de invocar (#1331);
//   • sync_all_clients   → conta do account_index (useAnalyticsSync itera "Conta N/3", 0→2);
//   • sync_addresses     → multi-conta por natureza: usa o account de CADA linha da proof (não filtra uma).
// Restam 3 omie_clientes, todos WRITERS (inserts → migram na Fatia 4 p/ register_carteira_member).
// A paridade textual pega a reversão do deploy do Lovable (armadilha do #1272). Ver design §4/§5.
const OMIE_CLIENTE = 'supabase/functions/omie-cliente/index.ts';
const UNIFIED_ORDER = 'src/hooks/useUnifiedOrder.ts';

// Recorta o corpo de um `case "<nome>": {` do edge (até o próximo case na mesma indentação). Necessário
// porque o omie-cliente tem 9 handlers e vários compartilham vocabulário: `for (const account of accounts)`
// é REGRESSÃO no sync_addresses (chutar o código nas 3 contas) e LEGÍTIMO no buscar_logos_empresas, que
// varre as contas de propósito. Um assert no arquivo inteiro confundiria os dois.
function blocoCaseCliente(s: string, nome: string): string {
  const i = s.indexOf(`case "${nome}": {`);
  if (i < 0) throw new Error(`case "${nome}" não encontrado no omie-cliente`);
  const resto = s.slice(i);
  const fim = resto.search(/\n {6}case "/);
  return fim < 0 ? resto : resto.slice(0, fim);
}

// Recorta handleStaffAddTool (o único chamador de criar_perfil_local) para amarrar edge × chamador
// dentro do MESMO fluxo, sem depender de contar caracteres entre as duas âncoras.
function blocoHandleStaffAddTool(s: string): string {
  const i = s.indexOf('const handleStaffAddTool = async () => {');
  if (i < 0) throw new Error('handleStaffAddTool não encontrada em useUnifiedOrder');
  const resto = s.slice(i);
  const fim = resto.search(/\n {2}\};\n/);
  return fim < 0 ? resto : resto.slice(0, fim);
}

describe('guardrail money-path: omie-cliente lê a proof fresca account-correta (Fatia 3-edges PR-A)', () => {
  const src = read(OMIE_CLIENTE);

  it('sentinela: leu o arquivo real (edge) e os 3 handlers migrados', () => {
    expect(src).toContain('criar_perfil_local');
    expect(src).toContain('sync_all_clients');
    expect(src).toContain('sync_addresses');
  });

  it('os 3 LEITORES vêm da view fresca; omie_clientes só resta como WRITER', () => {
    expect(
      count(src, '.from("omie_customer_account_map_fresco")'),
      'REVERSÃO Lovable? sumiu leitura da view fresca (esperado 3: criar_perfil_local, sync_all_clients, sync_addresses)',
    ).toBe(3);
    expect(
      count(src, '.from("omie_clientes")'),
      'REGRESSÃO: omie_clientes voltou como LEITOR (deveria restar só os 3 writers INSERT → Fatia 4)',
    ).toBe(3);
    // Os 3 restantes TÊM de ser inserts: contar == 3 sozinho não impede trocar um insert por um select.
    expect(
      (src.match(/\.from\("omie_clientes"\)\s*\.insert\(/g) ?? []).length,
      'REGRESSÃO: algum dos 3 omie_clientes restantes deixou de ser o writer INSERT',
    ).toBe(3);
    expect(
      src,
      'REVERSÃO Lovable? voltou a .select() do espelho poluído omie_clientes (código de conta indeterminada)',
    ).not.toMatch(/\.from\("omie_clientes"\)\s*\.select/);
  });

  it('a credencial Omie carrega o slug canônico da conta (não o índice instável nem o nome de UI)', () => {
    // getOmieAccounts monta a lista CONDICIONALMENTE (só com as env vars presentes): faltar
    // OMIE_OBEN_APP_KEY faria o índice 1 virar Colacor e o filtro de conta mentir em silêncio.
    expect(src, 'sumiu o slug canônico do OmieAccountConfig — o filtro de conta volta a depender do índice')
      .toMatch(/account:\s*OmieAccountSlug/);
    expect(
      count(src, 'account: "colacor_sc"') + count(src, 'account: "oben"') + count(src, 'account: "colacor"'),
      'as 3 contas devem declarar seu slug canônico (domínio do CHECK chk_ocam_account)',
    ).toBe(3);
  });

  it('criar_perfil_local resolve codigo->user na fresca account=oben (a conta do chamador)', () => {
    expect(
      src,
      'REVERSÃO Lovable? criar_perfil_local não resolve mais o código pela fresca com account=oben',
    ).toMatch(
      /\.from\("omie_customer_account_map_fresco"\)[\s\S]{0,200}\.eq\("omie_codigo_cliente", cliente\.codigo_cliente\)[\s\S]{0,120}\.eq\("account", "oben"\)/,
    );
    // Miss (ausente/stale >7d) NÃO pode virar código chutado: o ramo cai no fallback por documento.
    expect(
      src,
      'REGRESSÃO: sumiu o guard de miss (existingMapping?.user_id) — user_id null da view viraria hit falso',
    ).toMatch(/if \(existingMapping\?\.user_id\)/);
  });

  it('COERÊNCIA cross-file: o edge usa a MESMA conta que o chamador — senão resolvem users diferentes', () => {
    // O frontend resolve o código pela fresca account=oben e SÓ ENTÃO invoca criar_perfil_local com ele.
    // Se um dos dois mudar de conta, o edge acha um user diferente do que o chamador acabou de achar e
    // a ferramenta é anexada ao cliente ERRADO (Codex P2). Este assert amarra os dois lados no MESMO fluxo.
    const fluxo = blocoHandleStaffAddTool(read(UNIFIED_ORDER));
    expect(
      fluxo,
      'sentinela: handleStaffAddTool deixou de ser o chamador de criar_perfil_local',
    ).toMatch(/action: 'criar_perfil_local'/);
    expect(
      fluxo,
      'o chamador de criar_perfil_local não resolve mais o código pela fresca account=oben — o edge divergiu dele?',
    ).toMatch(/omie_customer_account_map_fresco[\s\S]{0,260}\.eq\('account', 'oben'\)/);
  });

  it('sync_all_clients dedupa pela conta DO LOTE, paginado e fail-closed em erro de query', () => {
    expect(
      src,
      'REVERSÃO Lovable? o dedup do sync_all_clients não lê a fresca filtrando a conta do account_index',
    ).toMatch(
      /\.from\("omie_customer_account_map_fresco"\)[\s\S]{0,120}\.eq\("account", account\.account\)[\s\S]{0,120}\.order\("omie_codigo_cliente"\)[\s\S]{0,120}\.range\(/,
    );
    // Sem .range o PostgREST capa em 1.000 linhas SILENCIOSO (eram 1.000 de 6.909 → o dedup enxergava 1/7).
    expect(
      src,
      'REGRESSÃO: o pré-load do dedup perdeu a paginação — volta a capar em 1.000 e reprocessar o resto',
    ).toMatch(/codePage\.length < codePageSize/);
    // Codex P2 do PR-2: engolir o erro deixa o Set vazio e o loop tenta RECRIAR milhares de clientes.
    expect(
      src,
      'REGRESSÃO: o pré-load do dedup engole o erro da query — Set vazio → reimportação em massa',
    ).toMatch(/if \(codeErr\) throw new Error/);
  });

  it('sync_addresses lê (user, conta, código) da proof e consulta a conta CERTA de cada código', () => {
    // Ancorado no bloco do handler: `for (const account of accounts)` é regressão AQUI e legítimo no
    // buscar_logos_empresas (que varre as contas de propósito) — no arquivo inteiro os dois se confundem.
    const bloco = blocoCaseCliente(src, 'sync_addresses');
    expect(
      bloco,
      'REVERSÃO Lovable? sync_addresses não lê mais (user_id, account, omie_codigo_cliente) da fresca paginada',
    ).toMatch(
      /\.from\("omie_customer_account_map_fresco"\)[\s\S]{0,120}\.select\("user_id, account, omie_codigo_cliente"\)[\s\S]{0,160}\.range\(/,
    );
    // O código agora vem PAREADO com a conta dele: nada de chutar o mesmo código nas 3 contas.
    expect(
      bloco,
      'REGRESSÃO: sync_addresses voltou a varrer as 3 contas com o mesmo código indeterminado',
    ).not.toMatch(/for \(const account of accounts\)/);
    expect(
      bloco,
      'sentinela: a consulta usa a credencial da conta DA LINHA da proof',
    ).toMatch(/accountBySlug\.get\(entry\.account\)/);
    // A proof tem até 1 linha por (user, conta) — sem agrupar, batch_size=30 viraria ~10 users.
    expect(
      bloco,
      'REGRESSÃO: sumiu o agrupamento por user — o lote passa a contar LINHAS da proof, não clientes',
    ).toMatch(/codesByUser/);
    expect(
      bloco,
      'REGRESSÃO: o pré-load dos mapeamentos engole o erro — vira "No client mappings found" (no-op mudo)',
    ).toMatch(/if \(pageErr\) throw new Error/);
  });
});
