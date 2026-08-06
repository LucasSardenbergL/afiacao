import { describe, it, expect } from 'vitest';
import { enviarProposta, dedupeKeyProposta, TEMPLATE_PROPOSTA } from '../enviarProposta';
import type { SupabaseWhatsappProposta } from '../enviarProposta';
import { avaliarCotacaoProposta, type CotacaoRow } from '@/lib/whatsapp/proposta-cotacao';
import type { CestaItem, CestaResult } from '@/lib/whatsapp/cesta-recompra';

function mkItem(sku: number, qtd: number): CestaItem {
  return {
    omie_codigo_produto: sku, qtdSugerida: qtd, dueRatio: 1, nPedidos: 4,
    cadenciaDias: 30, confidence: 'alta', motivo: 'recorrente_due', ultimoPrecoRef: 999,
  };
}
function mkCesta(principal: CestaItem[]): CestaResult {
  return { principal, secundarios: [], totalPedidos: 6, confianca: 'alta' };
}
function mkRow(sku: number, over: Partial<CotacaoRow> = {}): CotacaoRow {
  return {
    omie_codigo_produto: sku, product_id: `uuid-${sku}`, codigo: `C${sku}`,
    descricao: `PRODUTO ${sku}`, unidade: 'UN', ativo: true, estoque: 100,
    preco: 10.5, fonte_preco: 'praticado', ...over,
  };
}

const CORPO_REF = 'Olá, {{1}}! Entrega de {{2}}: {{3}}. Responda SIM. Para não receber mais, responda PARAR.';

const cotacaoOk = () => avaliarCotacaoProposta({
  cesta: mkCesta([mkItem(1, 2)]),
  crossSell: [],
  cotacao: [mkRow(1)],
  nomesPorSku: { 1: 'LIXA A275' },
  prazoEntrega: { iso: '2026-07-14', label: 'amanhã (14/07)' },
  primeiroNome: 'João',
  telefone: '5537999990000',
  template: { corpoReferencia: CORPO_REF, ativo: true },
});

interface MockCfg {
  invoke?: { data: unknown; error: unknown };
  sendRow?: { conversation_id: string } | null;
  insertError?: { message: string; code?: string } | null;
  orcamentoExistenteId?: string | null; // lido pelo maybeSingle de sales_orders (pós-23505)
}
interface Calls {
  invokes: Array<{ name: string; body: Record<string, unknown> }>;
  inserts: Array<{ table: string; payload: Record<string, unknown> }>;
}

/** Response-like com o shape que o parser de erro da edge usa (context.clone().json()). */
function edgeErrorCtx(status: number, body: unknown) {
  return {
    message: 'Edge Function returned a non-2xx status code',
    status,
    context: { clone: () => ({ json: async () => body }) },
  };
}

function mkSb(cfg: MockCfg): { sb: SupabaseWhatsappProposta; calls: Calls } {
  const calls: Calls = { invokes: [], inserts: [] };
  const sb: SupabaseWhatsappProposta = {
    functions: {
      invoke: async (name, opts) => {
        calls.invokes.push({ name, body: opts.body });
        return cfg.invoke ?? { data: { ok: true, conversationId: 'conv-9' }, error: null };
      },
    },
    from(table: string) {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () => Promise.resolve(
          table === 'whatsapp_template_sends'
            ? { data: cfg.sendRow ?? null, error: null }
            : { data: cfg.orcamentoExistenteId ? { id: cfg.orcamentoExistenteId } : null, error: null },
        ),
        insert: (payload: Record<string, unknown>) => {
          calls.inserts.push({ table, payload });
          return chain;
        },
        single: () => Promise.resolve(
          cfg.insertError ? { data: null, error: cfg.insertError } : { data: { id: 'orc-1' }, error: null },
        ),
      };
      return chain;
    },
  };
  return { sb, calls };
}

const baseParams = (sb: SupabaseWhatsappProposta) => ({
  supabase: sb,
  customerUserId: 'cust-1',
  account: 'oben',
  phoneE164: '5537999990000',
  primeiroNome: 'João',
  prazo: { iso: '2026-07-14', label: 'amanhã (14/07)' },
  cotacao: cotacaoOk(),
  createdBy: 'staff-1',
  customerDocument: '00.000.000/0001-00',
});

describe('enviarProposta — envio SÓ pela edge + elo no orçamento (money-path)', () => {
  it('cotação travada → NÃO envia nem grava (guard na fronteira, além da UI)', async () => {
    const { sb, calls } = mkSb({});
    const travada = avaliarCotacaoProposta({
      cesta: mkCesta([mkItem(1, 2)]), crossSell: [], nomesPorSku: {},
      cotacao: [mkRow(1, { preco: null, fonte_preco: null })],
      prazoEntrega: { iso: '2026-07-14', label: 'amanhã (14/07)' },
      primeiroNome: 'João', telefone: '5537999990000',
      template: { corpoReferencia: CORPO_REF, ativo: true },
    });
    const r = await enviarProposta({ ...baseParams(sb), cotacao: travada });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toBe('travada');
    expect(calls.invokes).toHaveLength(0);
    expect(calls.inserts).toHaveLength(0);
  });

  it('defesa em profundidade: cotação adulterada (travada=false mas linha inválida) → NÃO envia', async () => {
    const { sb, calls } = mkSb({});
    const adulterada = cotacaoOk();
    // simula corrupção/adulteração pós-avaliador (Codex P0: não confiar só em travada)
    adulterada.linhas[0].qtd = 0;
    const r = await enviarProposta({ ...baseParams(sb), cotacao: adulterada });
    expect(r.ok).toBe(false);
    expect(calls.invokes).toHaveLength(0);
  });

  it('caminho feliz: edge com dedupe/origem certos → orçamento com ELO + CHAVE + preços RECOTADOS', async () => {
    const { sb, calls } = mkSb({});
    const r = await enviarProposta(baseParams(sb));
    expect(r.ok).toBe(true);

    expect(calls.invokes).toHaveLength(1);
    const { name, body } = calls.invokes[0];
    expect(name).toBe('whatsapp-send-template');
    expect(body.templateNome).toBe(TEMPLATE_PROPOSTA);
    expect(body.origem).toBe('proposta');
    expect(body.dedupeKey).toBe(dedupeKeyProposta('cust-1', '2026-07-14'));
    expect(body.phoneE164).toBe('5537999990000');
    expect(body.bodyParams).toEqual(['João', 'amanhã (14/07)', '2× LIXA A275']);

    expect(calls.inserts).toHaveLength(1);
    const payload = calls.inserts[0].payload;
    expect(calls.inserts[0].table).toBe('sales_orders');
    expect(payload.whatsapp_conversation_id).toBe('conv-9'); // O ELO
    expect(payload.whatsapp_proposta_dedupe).toBe(dedupeKeyProposta('cust-1', '2026-07-14')); // idempotência atômica
    expect(payload.status).toBe('orcamento');
    expect(payload.account).toBe('oben');
    expect(payload.customer_user_id).toBe('cust-1');
    expect(payload.created_by).toBe('staff-1');
    expect(payload.customer_document).toBe('00.000.000/0001-00');
    expect(payload.total).toBeCloseTo(21); // 2 × 10.50 RECOTADO (nunca o ultimoPrecoRef 999)
    const items = payload.items as Array<Record<string, unknown>>;
    expect(items[0].valor_unitario).toBe(10.5);
    expect(items[0].quantidade).toBe(2);
    expect(items[0].omie_codigo_produto).toBe(1);
    if (r.ok) {
      expect(r.conversationId).toBe('conv-9');
      expect(r.jaEnviada).toBe(false);
      expect(r.orcamentoId).toBe('orc-1');
      expect(r.orcamentoErro).toBeNull();
    }
  });

  it('INSERT do orçamento colide (23505 — outra aba ganhou) → reusa o existente, sem duplicar', async () => {
    const { sb, calls } = mkSb({
      insertError: { message: 'duplicate key value violates unique constraint', code: '23505' },
      orcamentoExistenteId: 'orc-da-outra-aba',
    });
    const r = await enviarProposta(baseParams(sb));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.orcamentoId).toBe('orc-da-outra-aba');
      expect(r.orcamentoErro).toBeNull();
    }
    expect(calls.inserts).toHaveLength(1); // tentou 1×; não re-insere
  });

  it('409 duplicate com send ENVIADO (sent) → não re-envia; grava orçamento pós-retry com nota explícita', async () => {
    const { sb, calls } = mkSb({
      invoke: { data: null, error: edgeErrorCtx(409, { error: 'duplicate', existing: { status: 'sent' } }) },
      sendRow: { conversation_id: 'conv-9' },
    });
    const r = await enviarProposta(baseParams(sb));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.jaEnviada).toBe(true);
      expect(r.conversationId).toBe('conv-9');
    }
    expect(calls.invokes).toHaveLength(1); // 1 tentativa só — nunca re-envia
    expect(calls.inserts).toHaveLength(1);
    expect(calls.inserts[0].payload.whatsapp_conversation_id).toBe('conv-9');
    expect(String(calls.inserts[0].payload.notes)).toContain('após reenvio');
  });

  it('409 duplicate com send QUEUED (outra aba em voo) → erro claro, nada gravado (Codex P1)', async () => {
    const { sb, calls } = mkSb({
      invoke: { data: null, error: edgeErrorCtx(409, { error: 'duplicate', existing: { status: 'queued' } }) },
    });
    const r = await enviarProposta(baseParams(sb));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toBe('envio_em_andamento');
    expect(calls.inserts).toHaveLength(0);
  });

  it('409 opt_out → erro claro, NADA gravado (LGPD enforced na edge)', async () => {
    const { sb, calls } = mkSb({
      invoke: { data: null, error: edgeErrorCtx(409, { error: 'opt_out', detail: 'cliente pediu PARAR' }) },
    });
    const r = await enviarProposta(baseParams(sb));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.motivo).toBe('edge');
      expect(r.detalhe).toContain('opt_out');
    }
    expect(calls.inserts).toHaveLength(0);
  });

  it('edge falha (502) → não grava orçamento (proposta NÃO saiu)', async () => {
    const { sb, calls } = mkSb({
      invoke: { data: null, error: edgeErrorCtx(502, { error: 'send_failed', status: 502 }) },
    });
    const r = await enviarProposta(baseParams(sb));
    expect(r.ok).toBe(false);
    expect(calls.inserts).toHaveLength(0);
  });

  it('mensagem enviada mas INSERT falha (não-23505) → ok com orcamentoErro (não mentir que o envio falhou)', async () => {
    const { sb } = mkSb({ insertError: { message: 'RLS: nope' } });
    const r = await enviarProposta(baseParams(sb));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.orcamentoId).toBeNull();
      expect(r.orcamentoErro).toContain('RLS');
    }
  });

  it('dedupeKeyProposta é determinística por cliente×prazo (1 proposta por rota)', () => {
    expect(dedupeKeyProposta('c1', '2026-07-14')).toBe('proposta:c1:2026-07-14');
    expect(dedupeKeyProposta('c1', '2026-07-14')).toBe(dedupeKeyProposta('c1', '2026-07-14'));
  });
});
