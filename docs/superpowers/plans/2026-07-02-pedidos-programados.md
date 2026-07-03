# Pedidos Programados (PDF Lider → envios agendados ao Omie) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upload do PDF de pedido de compra da Lider → extração LLM → conferência com de-para/preço memorizados → founder marca itens e agenda envios → cron envia ao Omie na data como pedido de venda com as mensagens fixas e o nº do PC na NF.

**Architecture:** 4 tabelas novas (pool de itens + envios + de-para + config) com RLS staff-only; 2 edge functions novas (`pedido-programado-extrair` com Anthropic forced tool-use; `pedido-programado-enviar` que reusa a action `criar_pedido` do `omie-vendas-sync` via service role); 1 mudança aditiva no `omie-vendas-sync` (campos `dados_adicionais_nf`/`numero_pedido_cliente`); 2 páginas React (`/sales/programados` lista+upload, detalhe pool+envios); cron diário canônico.

**Tech Stack:** React 18 + TS strict + react-query + shadcn/sonner; Supabase (Postgres + Storage + Edge/Deno); Anthropic SDK `npm:@anthropic-ai/sdk` (`claude-sonnet-4-6`); pg_cron + pg_net; vitest; harness PG17 (prove-sql).

**Spec:** `docs/superpowers/specs/2026-07-02-pedidos-programados-design.md`

**Fatos pinados do repo (não re-descobrir):**
- `omie-vendas-sync` body: `{ action, account: 'oben'|'colacor', ...params }`; auth `authorizeCronOrStaff` (aceita Bearer SERVICE_ROLE_KEY); action `criar_pedido` params: `sales_order_id, codigo_cliente, codigo_vendedor, items, observacao, codigo_parcela, quantidade_volumes, ordem_compra` (dispatcher em `supabase/functions/omie-vendas-sync/index.ts:2084`; `criarPedidoVenda` em `:1563`; `informacoes_adicionais` montado em `:1641`).
- `items` shape (= `OrderItem` de `src/components/salesOrderEdit/types.ts`): `{ omie_codigo_produto: number, codigo?: string, descricao: string, unidade?: string, quantidade: number, valor_unitario: number, valor_total: number }`.
- Idempotência: `codigo_pedido_integracao = PV_${sales_order_id}` + reconciliação `ConsultarPedido` — retry do MESMO sales_order não duplica.
- `data_previsao` do pedido = data do envio (a edge usa `new Date()` no momento da criação — cron roda NO dia do envio; nenhuma mudança necessária).
- Cliente Lider: CNPJ 64.422.892/0001-00; Omie Oben `codigo_cliente = 8689689628`; app user `customer_user_id = 2ff308c9-d125-4e32-9033-6f46e88ef0b2`; Colacor: SEM cadastro (config fica NULL → guard bloqueia com motivo).
- Cron canônico: vault (`project_url`, `service_role_key`) + `timeout_milliseconds := 150000` explícito; horário padrão do repo `0 9 * * 1-6` (06h BRT seg–sáb).
- Edge+Anthropic: padrão em `supabase/functions/extrair-sinais-ligacao/index.ts` e `kb-extract-specs/index.ts` (`import Anthropic from "npm:@anthropic-ai/sdk@^0.93.0"`).
- vitest só inclui `src/**/*.{test,spec}.{ts,tsx}` → helpers puros vivem em `src/lib/pedidosProgramados/` e a edge os **espelha** (padrão do repo, ver comentário em omie-vendas-sync:1488).
- PDF exemplar: `~/Downloads/LUCAS213294.10375.pdf` (PC 213294, VERSAO 2, 5 itens, datas de entrega 17/06–20/07, COD.FORN presente).
- ⚠️ `omie-vendas-sync/index.ts` é arquivo QUENTE: antes da Task 5, `git fetch origin main && git log origin/main --oneline -5 -- supabase/functions/omie-vendas-sync/` + `gh pr list --search "omie-vendas-sync"`.

---

### Task 1: Helpers puros + testes (vitest, TDD)

**Files:**
- Create: `src/lib/pedidosProgramados/helpers.ts`
- Create: `src/lib/pedidosProgramados/helpers.test.ts`

- [ ] **Step 1.1: Escrever os testes (falhando)**

`src/lib/pedidosProgramados/helpers.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  montarDadosAdicionaisNf,
  agruparItensPorAccount,
  validarEnvioResolvido,
  validarExtracao,
  type ItemResolvido,
  type ConfigConta,
} from './helpers';

const cfgOben: ConfigConta = {
  account: 'oben',
  codigo_cliente_omie: 8689689628,
  customer_user_id: '2ff308c9-d125-4e32-9033-6f46e88ef0b2',
  obs_venda: 'RECIBO DE ENTREGA...',
  dados_adicionais_nf: 'FORMA DE PGTO BOLETO',
  codigo_parcela: null,
};
const cfgColacorVazia: ConfigConta = {
  account: 'colacor',
  codigo_cliente_omie: null,
  customer_user_id: null,
  obs_venda: null,
  dados_adicionais_nf: null,
  codigo_parcela: null,
};

const itemOk: ItemResolvido = {
  id: 'i1', codigo_item_cliente: '3FLA0003M01', descricao_cliente: 'FLANELA',
  quantidade: 220, preco_final: 16.9, account: 'oben',
  omie_codigo_produto: 111, produto_codigo: 'FLA1', produto_descricao: 'FLANELA OBEN',
};

describe('montarDadosAdicionaisNf', () => {
  it('põe o nº do PC na primeira linha e a mensagem fixa depois', () => {
    expect(montarDadosAdicionaisNf('FORMA DE PGTO BOLETO', '213294'))
      .toBe('PEDIDO DE COMPRA Nº: 213294\n\nFORMA DE PGTO BOLETO');
  });
  it('sem mensagem fixa, só o nº do PC (não fabrica texto)', () => {
    expect(montarDadosAdicionaisNf(null, '213294')).toBe('PEDIDO DE COMPRA Nº: 213294');
  });
});

describe('agruparItensPorAccount', () => {
  it('separa itens por empresa', () => {
    const grupos = agruparItensPorAccount([
      itemOk,
      { ...itemOk, id: 'i2', account: 'colacor' },
      { ...itemOk, id: 'i3' },
    ]);
    expect(Object.keys(grupos).sort()).toEqual(['colacor', 'oben']);
    expect(grupos.oben).toHaveLength(2);
    expect(grupos.colacor).toHaveLength(1);
  });
});

describe('validarEnvioResolvido', () => {
  it('aprova envio 100% resolvido com config completa', () => {
    expect(validarEnvioResolvido([itemOk], { oben: cfgOben, colacor: cfgColacorVazia })).toEqual([]);
  });
  it('bloqueia item sem mapeamento', () => {
    const p = validarEnvioResolvido(
      [{ ...itemOk, omie_codigo_produto: null, account: null }],
      { oben: cfgOben, colacor: cfgColacorVazia },
    );
    expect(p.join(' ')).toMatch(/sem mapeamento/i);
  });
  it('bloqueia preço NULL e preço 0 (ausente ≠ zero)', () => {
    expect(validarEnvioResolvido([{ ...itemOk, preco_final: null }], { oben: cfgOben, colacor: cfgColacorVazia })).not.toEqual([]);
    expect(validarEnvioResolvido([{ ...itemOk, preco_final: 0 }], { oben: cfgOben, colacor: cfgColacorVazia })).not.toEqual([]);
  });
  it('bloqueia quantidade inválida', () => {
    expect(validarEnvioResolvido([{ ...itemOk, quantidade: 0 }], { oben: cfgOben, colacor: cfgColacorVazia })).not.toEqual([]);
  });
  it('bloqueia account sem config (cliente não cadastrado na Colacor)', () => {
    const p = validarEnvioResolvido(
      [{ ...itemOk, account: 'colacor' }],
      { oben: cfgOben, colacor: cfgColacorVazia },
    );
    expect(p.join(' ')).toMatch(/colacor/i);
  });
});

describe('validarExtracao', () => {
  it('aceita extração válida e normaliza itens', () => {
    const r = validarExtracao({
      numero_pedido_compra: '213294', data_emissao: '2026-05-20', versao: '2',
      itens: [{
        codigo_item_cliente: '3FLA0003M01', num_ordem_cliente: '50072329',
        descricao_cliente: 'FLANELA MICROFIBRA', quantidade: 220, unidade: 'UN',
        preco_unitario: 16.9, data_entrega: '2026-07-20', cod_forn: '644',
      }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.dados.itens[0].quantidade).toBe(220);
  });
  it('rejeita sem nº do PC ou sem itens', () => {
    expect(validarExtracao({ numero_pedido_compra: null, data_emissao: null, versao: null, itens: [] }).ok).toBe(false);
  });
  it('degrada campo ruim para null em vez de inventar (data inválida, preço não-numérico)', () => {
    const r = validarExtracao({
      numero_pedido_compra: '213294', data_emissao: 'banana', versao: null,
      itens: [{
        codigo_item_cliente: 'X', num_ordem_cliente: null, descricao_cliente: 'Y',
        quantidade: 1, unidade: null, preco_unitario: 'errado', data_entrega: '20/07/2026', cod_forn: null,
      }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.dados.data_emissao).toBeNull();
      expect(r.dados.itens[0].preco_unitario).toBeNull();
      expect(r.dados.itens[0].data_entrega).toBeNull(); // só aceita YYYY-MM-DD
    }
  });
  it('rejeita item sem codigo_item_cliente ou quantidade inválida', () => {
    const r = validarExtracao({
      numero_pedido_compra: '213294', data_emissao: null, versao: null,
      itens: [{ codigo_item_cliente: null, num_ordem_cliente: null, descricao_cliente: 'Y', quantidade: 0, unidade: null, preco_unitario: null, data_entrega: null, cod_forn: null }],
    });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 1.2: Rodar e ver falhar**

Run: `heavy bunx vitest run src/lib/pedidosProgramados/helpers.test.ts > /tmp/t1.log 2>&1; echo exit=$?; tail -20 /tmp/t1.log`
Expected: exit=1 (módulo `./helpers` não existe).

- [ ] **Step 1.3: Implementar `src/lib/pedidosProgramados/helpers.ts`**

```typescript
// Helpers PUROS dos pedidos programados (Lider). Sem imports de runtime — as edges
// pedido-programado-* ESPELHAM estas funções (Deno não importa de src/; padrão do repo,
// ver omie-vendas-sync/index.ts:1488). Qualquer mudança aqui → replicar no espelho.

export type AccountPP = 'oben' | 'colacor';

export interface ConfigConta {
  account: AccountPP;
  codigo_cliente_omie: number | null;
  customer_user_id: string | null;
  obs_venda: string | null;
  dados_adicionais_nf: string | null;
  codigo_parcela: string | null;
}

// Item do envio já resolvido via de-para (JOIN cliente_item_mapa → omie_products)
export interface ItemResolvido {
  id: string;
  codigo_item_cliente: string;
  descricao_cliente: string;
  quantidade: number;
  preco_final: number | null;
  account: AccountPP | null;          // null = sem mapeamento
  omie_codigo_produto: number | null; // null = sem mapeamento
  produto_codigo: string | null;
  produto_descricao: string | null;
}

// nº do PC primeiro (exigência da Lider: "FAVOR INFORMAR O NUMERO DO PEDIDO DA LIDER
// NA NOTA FISCAL"), mensagem fixa depois. Sem mensagem → só o nº (nunca fabricar texto).
export function montarDadosAdicionaisNf(mensagemFixa: string | null, numeroPc: string): string {
  const cabeca = `PEDIDO DE COMPRA Nº: ${numeroPc}`;
  const msg = (mensagemFixa ?? '').trim();
  return msg ? `${cabeca}\n\n${msg}` : cabeca;
}

export function agruparItensPorAccount(itens: ItemResolvido[]): Partial<Record<AccountPP, ItemResolvido[]>> {
  const grupos: Partial<Record<AccountPP, ItemResolvido[]>> = {};
  for (const item of itens) {
    if (!item.account) continue; // sem mapeamento — validarEnvioResolvido já barrou antes
    (grupos[item.account] ??= []).push(item);
  }
  return grupos;
}

// Precisão > recall: retorna a lista de PROBLEMAS (vazia = pode enviar).
// Ausente ≠ zero: preco_final NULL bloqueia, nunca vira 0.
export function validarEnvioResolvido(
  itens: ItemResolvido[],
  configs: Record<AccountPP, ConfigConta>,
): string[] {
  const problemas: string[] = [];
  if (itens.length === 0) problemas.push('Envio sem itens.');
  const accountsEnvolvidas = new Set<AccountPP>();
  for (const it of itens) {
    const rotulo = `${it.codigo_item_cliente} (${it.descricao_cliente})`;
    if (!it.account || !it.omie_codigo_produto) {
      problemas.push(`Item ${rotulo} sem mapeamento para produto interno.`);
      continue;
    }
    accountsEnvolvidas.add(it.account);
    if (typeof it.preco_final !== 'number' || !Number.isFinite(it.preco_final) || it.preco_final <= 0) {
      problemas.push(`Item ${rotulo} sem preço final válido (> 0).`);
    }
    if (typeof it.quantidade !== 'number' || !Number.isFinite(it.quantidade) || it.quantidade <= 0) {
      problemas.push(`Item ${rotulo} com quantidade inválida.`);
    }
  }
  for (const acc of accountsEnvolvidas) {
    const cfg = configs[acc];
    if (!cfg || !cfg.codigo_cliente_omie) {
      problemas.push(`Config da ${acc} incompleta: cliente não cadastrado/sem código Omie.`);
    } else {
      if (!cfg.customer_user_id) problemas.push(`Config da ${acc} incompleta: customer_user_id ausente.`);
      if (!(cfg.dados_adicionais_nf ?? '').trim()) problemas.push(`Config da ${acc} incompleta: mensagem de Dados Adicionais da NF vazia.`);
      if (!(cfg.obs_venda ?? '').trim()) problemas.push(`Config da ${acc} incompleta: mensagem de Observações vazia.`);
    }
  }
  return problemas;
}

// ── Validação da extração do LLM (espelhada na edge pedido-programado-extrair) ──
export interface ItemExtraido {
  codigo_item_cliente: string;
  num_ordem_cliente: string | null;
  descricao_cliente: string;
  quantidade: number;
  unidade: string | null;
  preco_unitario: number | null;  // referência; sempre "vem errado" (founder ajusta)
  data_entrega: string | null;    // YYYY-MM-DD
  cod_forn: string | null;        // NOSSO código impresso no PDF (semente de sugestão)
}
export interface ExtracaoValidada {
  numero_pedido_compra: string;
  data_emissao: string | null;    // YYYY-MM-DD
  versao: string | null;
  itens: ItemExtraido[];
}
export type ResultadoValidacao = { ok: true; dados: ExtracaoValidada } | { ok: false; erro: string };

const RE_ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function isoOuNull(v: unknown): string | null {
  return typeof v === 'string' && RE_ISO_DATE.test(v) ? v : null;
}
function numeroPositivoOuNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}
function textoOuNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export function validarExtracao(bruto: unknown): ResultadoValidacao {
  const b = bruto as Record<string, unknown> | null;
  const numeroPc = textoOuNull(b?.numero_pedido_compra);
  if (!numeroPc) return { ok: false, erro: 'Extração sem numero_pedido_compra — PDF ilegível ou fora do layout.' };
  const itensBrutos = Array.isArray(b?.itens) ? (b.itens as Array<Record<string, unknown>>) : [];
  if (itensBrutos.length === 0) return { ok: false, erro: 'Extração sem itens.' };
  const itens: ItemExtraido[] = [];
  for (const [i, it] of itensBrutos.entries()) {
    const codigo = textoOuNull(it?.codigo_item_cliente);
    const descricao = textoOuNull(it?.descricao_cliente);
    const quantidade = numeroPositivoOuNull(it?.quantidade);
    if (!codigo || !descricao || quantidade === null) {
      return { ok: false, erro: `Item ${i + 1} sem código/descrição/quantidade válidos — revisar PDF.` };
    }
    itens.push({
      codigo_item_cliente: codigo,
      num_ordem_cliente: textoOuNull(it?.num_ordem_cliente),
      descricao_cliente: descricao,
      quantidade,
      unidade: textoOuNull(it?.unidade),
      preco_unitario: numeroPositivoOuNull(it?.preco_unitario),
      data_entrega: isoOuNull(it?.data_entrega),
      cod_forn: textoOuNull(it?.cod_forn),
    });
  }
  return {
    ok: true,
    dados: {
      numero_pedido_compra: numeroPc,
      data_emissao: isoOuNull(b?.data_emissao),
      versao: textoOuNull(b?.versao),
      itens,
    },
  };
}
```

- [ ] **Step 1.4: Rodar e ver passar**

Run: `heavy bunx vitest run src/lib/pedidosProgramados/helpers.test.ts > /tmp/t1.log 2>&1; echo exit=$?; tail -5 /tmp/t1.log`
Expected: exit=0, todos os testes verdes.

- [ ] **Step 1.5: Commit**

```bash
git add src/lib/pedidosProgramados/
git commit -m "feat(pedidos-programados): helpers puros (validação de envio/extração, dados adicionais NF)"
```

> **NOTA (pós-revisão de qualidade):** o código acima evoluiu na execução — `validarEnvioResolvido(numeroPc: string | null, itens, configs)` valida também o nº do PC (header é nullable; nunca emitir "null" na NF) e `montarDadosAdicionaisNf` lança com numeroPc vazio (backstop). **Fonte da verdade para os espelhos das Tasks 4/6: o arquivo real `src/lib/pedidosProgramados/helpers.ts` no repo**, não os blocos deste plano.

---

### Task 2: Migration — tabelas, RLS, bucket, seed

**Files:**
- Create: `supabase/migrations/20260702120000_pedidos_programados.sql`

⚠️ Antes: `ls supabase/migrations/ | sort | tail -3` e conferir que não há timestamp colidindo com worktree paralela (`git fetch origin main && git log origin/main --oneline -5 -- supabase/migrations/`).

- [ ] **Step 2.1: Escrever a migration**

```sql
-- Pedidos programados (Lider): pool de itens extraídos do PDF do cliente → envios
-- agendados ao Omie. Spec: docs/superpowers/specs/2026-07-02-pedidos-programados-design.md
-- Todas as tabelas staff-only (money-path: gera pedido de venda no Omie).

-- ── 1. Header: 1 linha por PDF ──
CREATE TABLE public.pedidos_programados (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  cliente_ref text NOT NULL DEFAULT 'lider',
  arquivo_path text NOT NULL,
  numero_pedido_compra text,
  versao text,
  data_emissao_cliente date,
  status text NOT NULL DEFAULT 'extraindo'
    CHECK (status IN ('extraindo','erro_extracao','ativo','concluido','cancelado')),
  erro_motivo text,
  extracao_bruta jsonb,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── 2. Envios: grupo de itens marcado pelo founder para envio numa data ──
CREATE TABLE public.pedidos_programados_envios (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  pedido_programado_id uuid NOT NULL REFERENCES public.pedidos_programados(id) ON DELETE CASCADE,
  data_envio date NOT NULL,
  status text NOT NULL DEFAULT 'agendado'
    CHECK (status IN ('agendado','enviado','erro','cancelado')),
  erro_motivo text,
  -- Map account → sales_order_id (jsonb p/ retry idempotente: reusa o MESMO
  -- sales_order → mesma chave PV_${id} no Omie; nunca duplica pedido).
  sales_orders_map jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_pp_envios_pendentes ON public.pedidos_programados_envios (data_envio)
  WHERE status = 'agendado';

-- ── 3. Itens extraídos do PDF ──
CREATE TABLE public.pedidos_programados_itens (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  pedido_programado_id uuid NOT NULL REFERENCES public.pedidos_programados(id) ON DELETE CASCADE,
  envio_id uuid REFERENCES public.pedidos_programados_envios(id) ON DELETE SET NULL,
  codigo_item_cliente text NOT NULL,
  num_ordem_cliente text,
  descricao_cliente text NOT NULL,
  quantidade numeric NOT NULL CHECK (quantidade > 0),
  unidade text,
  data_entrega_cliente date,
  cod_forn text,
  preco_pdf numeric,
  -- Ausente ≠ zero: NULL bloqueia envio; nunca defaultar para 0.
  preco_final numeric CHECK (preco_final IS NULL OR preco_final > 0),
  mapa_id uuid REFERENCES public.cliente_item_mapa(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_pp_itens_pedido ON public.pedidos_programados_itens (pedido_programado_id);
CREATE INDEX idx_pp_itens_envio ON public.pedidos_programados_itens (envio_id);

-- ── 4. De-para memorizado + memória de preço ──
CREATE TABLE public.cliente_item_mapa (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  cliente_ref text NOT NULL DEFAULT 'lider',
  codigo_item_cliente text NOT NULL,
  omie_product_id uuid NOT NULL REFERENCES public.omie_products(id),
  ultimo_preco numeric CHECK (ultimo_preco IS NULL OR ultimo_preco > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cliente_ref, codigo_item_cliente)
);

-- ── 5. Config por empresa (founder edita na UI) ──
CREATE TABLE public.pedidos_programados_config (
  account text NOT NULL PRIMARY KEY CHECK (account IN ('oben','colacor')),
  codigo_cliente_omie bigint,
  customer_user_id uuid,
  obs_venda text,
  dados_adicionais_nf text,
  codigo_parcela text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- NOTA de ordem: cliente_item_mapa é referenciada por pedidos_programados_itens.
-- Se o SQL Editor reclamar, mover o bloco 4 para antes do 3 (mesma transação resolve).

-- ── RLS: staff-only em tudo ──
ALTER TABLE public.pedidos_programados        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pedidos_programados_envios ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pedidos_programados_itens  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cliente_item_mapa          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pedidos_programados_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY pp_staff_all ON public.pedidos_programados FOR ALL
  USING (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role))
  WITH CHECK (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role));
CREATE POLICY pp_envios_staff_all ON public.pedidos_programados_envios FOR ALL
  USING (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role))
  WITH CHECK (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role));
CREATE POLICY pp_itens_staff_all ON public.pedidos_programados_itens FOR ALL
  USING (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role))
  WITH CHECK (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role));
CREATE POLICY pp_mapa_staff_all ON public.cliente_item_mapa FOR ALL
  USING (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role))
  WITH CHECK (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role));
CREATE POLICY pp_config_staff_all ON public.pedidos_programados_config FOR ALL
  USING (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role))
  WITH CHECK (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role));

-- ── updated_at triggers (função já existe no banco) ──
CREATE TRIGGER upd_pp        BEFORE UPDATE ON public.pedidos_programados        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER upd_pp_envios BEFORE UPDATE ON public.pedidos_programados_envios FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER upd_pp_itens  BEFORE UPDATE ON public.pedidos_programados_itens  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER upd_pp_mapa   BEFORE UPDATE ON public.cliente_item_mapa          FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER upd_pp_config BEFORE UPDATE ON public.pedidos_programados_config FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── Storage: bucket privado para os PDFs ──
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('pedidos-programados', 'pedidos-programados', false, 10485760, ARRAY['application/pdf'])
ON CONFLICT (id) DO NOTHING;

CREATE POLICY pp_storage_staff_select ON storage.objects FOR SELECT
  USING (bucket_id = 'pedidos-programados'
    AND (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role)));
CREATE POLICY pp_storage_staff_insert ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'pedidos-programados'
    AND (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role)));
CREATE POLICY pp_storage_staff_delete ON storage.objects FOR DELETE
  USING (bucket_id = 'pedidos-programados'
    AND (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role)));

-- ── Seed da config (valores reais confirmados no banco em 2026-07-02) ──
INSERT INTO public.pedidos_programados_config
  (account, codigo_cliente_omie, customer_user_id, obs_venda, dados_adicionais_nf, codigo_parcela)
VALUES
  ('oben', 8689689628, '2ff308c9-d125-4e32-9033-6f46e88ef0b2',
   E'RECIBO DE ENTREGA DE VENDA NÃO PRESENCIAL\nE-PTA-RE Nº: 45.000035717-51 / OBEN COMÉRCIO LTDA.\nTRANSPORTADORA: Transporte próprio: Oben Comercio\nDeclaro que recebi as mercadorias constantes dessa Nota Fiscal, e que as mercadorias se destinam a uso e consumo, e que estão em perfeito estado e conferem com pedido feito no âmbito do comércio de telemarketing ou eletrônico e que foram recebidas no local por mim no local indicado acima.\nCPF/CNPJ:___________________________________\nDATA DA ENTREGA:___/__/____\nNome/ASSINATURA:_________________________________________________',
   E'FORMA DE PGTO BOLETO\n\n-- --\nOperação contratada no âmbito do comércio eletrônico ou do telemarketing. As mercadorias comercializadas no âmbito do comércio eletrônico ou do telemarketing pelo E-Commerce não Vinculado deverão ser destinadas exclusivamente a consumidor final, ainda que contribuinte do imposto, não sendo aplicável às referidas operações o regime de substituição tributária. MERCADORIA DESTINADA A USO E CONSUMO, vedado o aproveitamento do crédito nos termos do inciso III do art. 70 do RICMS". E-PTA-RE Nº: 45.000035717-51.\nEntrega por ordem do destinatário descrita acima.',
   NULL),
  ('colacor', NULL, NULL, NULL, NULL, NULL)
ON CONFLICT (account) DO NOTHING;
```

Nota: o bloco 4 (`cliente_item_mapa`) precisa vir ANTES do 3 na versão final do arquivo (FK). Ao escrever o arquivo real, ordenar: 1, 2, 4, 3, 5.

- [ ] **Step 2.2: Commit**

```bash
git add supabase/migrations/20260702120000_pedidos_programados.sql
git commit -m "feat(pedidos-programados): migration — tabelas, RLS staff-only, bucket e seed da config Lider"
```

(⚠️ NÃO aplicar ainda — prova na Task 3, apply em produção só no deploy handoff da Task 12, via SQL Editor.)

---

### Task 3: Prova PG17 (prove-sql) — RLS + constraints + falsificação

**Files:**
- Create: `db/test-pedidos-programados.sh` (copiar estrutura de `db/test-regua-preco-customer360.sh`)

- [ ] **Step 3.1: Escrever o harness**

Estrutura (seguir o template existente: initdb PG17 em tmpdir, `db/stubs-supabase.sql`, `auth.uid()` via GUC `test.uid`, helpers `ok/bad/eq`, `trap cleanup EXIT`). Corpo dos testes:

```bash
# ... cabeçalho idêntico ao template (PGBIN/PORT/DATA/cleanup/stubs) com SLUG="pedidos-programados" ...

# Pré-requisitos do schema que a migration referencia:
P -q <<'SQL'
-- stubs mínimos: has_role/app_role vêm de db/stubs-supabase.sql; senão criar aqui.
CREATE TABLE IF NOT EXISTS public.omie_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  omie_codigo_produto bigint NOT NULL,
  codigo text NOT NULL, descricao text NOT NULL,
  ativo boolean DEFAULT true, account text NOT NULL DEFAULT 'oben'
);
CREATE OR REPLACE FUNCTION public.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS
$f$ BEGIN NEW.updated_at = now(); RETURN NEW; END $f$;
-- storage stub (bucket/policies do storage não são o alvo da prova local):
CREATE SCHEMA IF NOT EXISTS storage;
CREATE TABLE IF NOT EXISTS storage.buckets (id text PRIMARY KEY, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
CREATE TABLE IF NOT EXISTS storage.objects (id uuid DEFAULT gen_random_uuid(), bucket_id text, name text);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
SQL

P -q -f "$REPO_ROOT/supabase/migrations/20260702120000_pedidos_programados.sql"

# Seed: 1 staff (employee), 1 customer, 1 produto, 1 pedido+item
P -q <<'SQL'
SELECT set_config('test.uid','',false);
INSERT INTO public.user_roles (user_id, role) VALUES
  ('11111111-1111-1111-1111-111111111111','employee'),
  ('22222222-2222-2222-2222-222222222222','customer');
INSERT INTO public.omie_products (id, omie_codigo_produto, codigo, descricao, account)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 111, 'PRD01931', 'LIXA HOOKIT GOLD', 'oben');
INSERT INTO public.pedidos_programados (id, arquivo_path, numero_pedido_compra, status, created_by)
  VALUES ('bbbbbbbb-0000-0000-0000-000000000001','lider/x.pdf','213294','ativo','11111111-1111-1111-1111-111111111111');
SQL

echo "═══ RLS ═══"
# staff vê
eq "staff SELECT header" "$(Pq -c "SET ROLE authenticated; SELECT set_config('test.uid','11111111-1111-1111-1111-111111111111',true); SELECT count(*) FROM public.pedidos_programados;")" "1"
# customer NÃO vê (RLS staff-only → 0 linhas)
eq "customer SELECT header = 0" "$(Pq -c "SET ROLE authenticated; SELECT set_config('test.uid','22222222-2222-2222-2222-222222222222',true); SELECT count(*) FROM public.pedidos_programados;")" "0"
# customer NÃO insere (42501)
eq "customer INSERT negado (42501)" "$(Pq -c "SET ROLE authenticated; SELECT set_config('test.uid','22222222-2222-2222-2222-222222222222',true);
  DO \$\$ BEGIN
    INSERT INTO public.pedidos_programados (arquivo_path, created_by) VALUES ('x','22222222-2222-2222-2222-222222222222');
    RAISE EXCEPTION 'NAO_BARROU';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok';
  END \$\$; SELECT 'BARROU';")" "BARROU"
# anon (sem uid) não vê
eq "anon SELECT = 0" "$(Pq -c "SET ROLE authenticated; SELECT set_config('test.uid','',true); SELECT count(*) FROM public.pedidos_programados;")" "0"

echo "═══ Constraints (SQLSTATE exata, sem WHEN OTHERS) ═══"
# status inválido → 23514
eq "status inválido (23514)" "$(Pq -c "RESET ROLE;
  DO \$\$ BEGIN
    INSERT INTO public.pedidos_programados (arquivo_path, status, created_by) VALUES ('x','voando','11111111-1111-1111-1111-111111111111');
    RAISE EXCEPTION 'NAO_BARROU';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ok';
  END \$\$; SELECT 'BARROU';")" "BARROU"
# preco_final = 0 → 23514 (ausente ≠ zero é NULL permitido; ZERO é proibido)
eq "preco_final=0 barrado (23514)" "$(Pq -c "RESET ROLE;
  DO \$\$ BEGIN
    INSERT INTO public.pedidos_programados_itens (pedido_programado_id, codigo_item_cliente, descricao_cliente, quantidade, preco_final)
    VALUES ('bbbbbbbb-0000-0000-0000-000000000001','X','Y',1,0);
    RAISE EXCEPTION 'NAO_BARROU';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ok';
  END \$\$; SELECT 'BARROU';")" "BARROU"
# de-para duplicado → 23505
eq "mapa duplicado (23505)" "$(Pq -c "RESET ROLE;
  INSERT INTO public.cliente_item_mapa (cliente_ref, codigo_item_cliente, omie_product_id) VALUES ('lider','3FLA0003M01','aaaaaaaa-0000-0000-0000-000000000001');
  DO \$\$ BEGIN
    INSERT INTO public.cliente_item_mapa (cliente_ref, codigo_item_cliente, omie_product_id) VALUES ('lider','3FLA0003M01','aaaaaaaa-0000-0000-0000-000000000001');
    RAISE EXCEPTION 'NAO_BARROU';
  EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'ok';
  END \$\$; SELECT 'BARROU';")" "BARROU"
# seed da config presente
eq "config oben seedada" "$(Pq -c "RESET ROLE; SELECT codigo_cliente_omie FROM public.pedidos_programados_config WHERE account='oben';")" "8689689628"

echo; echo "PASS=$PASS FAIL=$FAIL"; [ "$FAIL" = "0" ]
```

- [ ] **Step 3.2: Rodar — exigir verde**

Run: `bash db/test-pedidos-programados.sh > /tmp/pp-sql.log 2>&1; echo exit=$?; tail -20 /tmp/pp-sql.log`
Expected: exit=0, `FAIL=0`.

- [ ] **Step 3.3: FALSIFICAR** — sabotar e exigir vermelho

Comentar temporariamente a linha `ALTER TABLE public.pedidos_programados ENABLE ROW LEVEL SECURITY;` na migration, rodar de novo:
Expected: exit=1 (o teste "customer SELECT header = 0" deve FALHAR — prova que o teste morde). Reverter a sabotagem (`git checkout -- supabase/migrations/20260702120000_pedidos_programados.sql`) e rodar mais uma vez: exit=0.

- [ ] **Step 3.4: Commit**

```bash
git add db/test-pedidos-programados.sh
git commit -m "test(pedidos-programados): prova PG17 — RLS staff-only, constraints e seed (com falsificação)"
```

---

### Task 4: Edge `pedido-programado-extrair` (Anthropic, PDF → itens)

**Files:**
- Create: `supabase/functions/pedido-programado-extrair/index.ts`

- [ ] **Step 4.1: Escrever a edge**

```typescript
// Extrai o pedido de compra da Lider (PDF no bucket pedidos-programados) via Anthropic
// forced tool-use e materializa itens em pedidos_programados_itens, aplicando o de-para
// memorizado (cliente_item_mapa) + memória de preço. Reprocessável: re-extrair apaga e
// recria os itens AINDA sem envio (não toca item já vinculado a envio).
// Auth: staff (UI) ou service_role. Espelha validarExtracao de src/lib/pedidosProgramados/helpers.ts.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk@^0.93.0";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";

const SYSTEM_PROMPT = `Você extrai dados de um PDF de PEDIDO DE COMPRA da LIDER INDUSTRIA E COMERCIO DE ESTOFADOS (layout tabular monoespaçado, "PEDIDO No..:" no topo, itens com QUANTIDADE|UN|COD.ITEM/NUM.ORDEM|DESCRICAO|PRECO UNITARIO, COD.FORN e DATA ENTREGA por item, possível "ANEXO AO PEDIDO" na última página).
Regras:
- Copie códigos EXATAMENTE como impressos (ex.: 3FLA0003M01, 50072329, PRD01931).
- Datas: converta DD/MM/YYYY → YYYY-MM-DD.
- Números: vírgula decimal brasileira → ponto (16,900000 → 16.9; 1700,000 → 1700).
- Campo ilegível/ausente → null. NUNCA invente valor.
- descricao_cliente: junte as linhas de continuação da descrição do item (sem o COD.FORN e sem a DATA ENTREGA).`;

const TOOL = {
  name: "registrar_pedido_compra",
  description: "Registra os dados extraídos do PDF do pedido de compra.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      numero_pedido_compra: { type: ["string", "null"], description: "PEDIDO No.. do topo, ex.: 213294" },
      data_emissao: { type: ["string", "null"], description: "DATA EMISSAO em YYYY-MM-DD" },
      versao: { type: ["string", "null"], description: "VERSAO., ex.: 2" },
      itens: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            codigo_item_cliente: { type: ["string", "null"], description: "COD.ITEM, ex.: 3FLA0003M01" },
            num_ordem_cliente: { type: ["string", "null"], description: "NUM.ORDEM, ex.: 50072329" },
            descricao_cliente: { type: ["string", "null"] },
            quantidade: { type: ["number", "null"] },
            unidade: { type: ["string", "null"], description: "UN, MT, ..." },
            preco_unitario: { type: ["number", "null"], description: "PRECO UNITARIO do PDF" },
            data_entrega: { type: ["string", "null"], description: "DATA ENTREGA em YYYY-MM-DD" },
            cod_forn: { type: ["string", "null"], description: "COD.FORN (código do fornecedor = nosso)" },
          },
          required: ["codigo_item_cliente","num_ordem_cliente","descricao_cliente","quantidade","unidade","preco_unitario","data_entrega","cod_forn"],
        },
      },
    },
    required: ["numero_pedido_compra", "data_emissao", "versao", "itens"],
  },
} as const;

// ── espelho de src/lib/pedidosProgramados/helpers.ts (validarExtracao + tipos) ──
// [colar aqui, verbatim, as funções validarExtracao/isoOuNull/numeroPositivoOuNull/
//  textoOuNull e os tipos ItemExtraido/ExtracaoValidada/ResultadoValidacao da Task 1]

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json(500, { error: "ANTHROPIC_API_KEY não configurada" });

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { pedido_programado_id } = await req.json().catch(() => ({}));
  if (!pedido_programado_id) return json(400, { error: "pedido_programado_id é obrigatório" });

  const { data: pedido, error: pedErr } = await supabase
    .from("pedidos_programados").select("*").eq("id", pedido_programado_id).single();
  if (pedErr || !pedido) return json(404, { error: `Pedido programado não encontrado: ${pedErr?.message}` });

  try {
    // 1. Baixar o PDF do Storage
    const { data: blob, error: dlErr } = await supabase.storage
      .from("pedidos-programados").download(pedido.arquivo_path);
    if (dlErr || !blob) throw new Error(`Download do PDF falhou: ${dlErr?.message}`);
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < buf.length; i += CHUNK) bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
    const pdfBase64 = btoa(bin);

    // 2. Anthropic forced tool-use com o PDF como documento
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      tools: [TOOL],
      tool_choice: { type: "tool", name: "registrar_pedido_compra" },
      messages: [{
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } },
          { type: "text", text: "Extraia este pedido de compra e registre via tool." },
        ],
      }],
    });
    const toolUse = response.content.find((b) => b.type === "tool_use");
    if (toolUse?.type !== "tool_use") throw new Error("LLM não retornou tool_use.");

    // 3. Validar (nunca aceitar dado inventado/malformado)
    const validacao = validarExtracao(toolUse.input);
    if (!validacao.ok) throw new Error(validacao.erro);
    const dados = validacao.dados;

    // 4. Guard de duplicata/revisão: outro pedido ativo com o mesmo nº de PC?
    const { data: dup } = await supabase
      .from("pedidos_programados").select("id")
      .eq("numero_pedido_compra", dados.numero_pedido_compra)
      .in("status", ["ativo", "extraindo"])
      .neq("id", pedido_programado_id).limit(1);
    const duplicado_de = dup && dup.length > 0 ? dup[0].id : null;

    // 5. Recriar itens ainda não vinculados a envio (reprocesso seguro)
    const { error: delErr } = await supabase
      .from("pedidos_programados_itens").delete()
      .eq("pedido_programado_id", pedido_programado_id).is("envio_id", null);
    if (delErr) throw new Error(`Limpeza de itens falhou: ${delErr.message}`);

    // 6. Aplicar de-para memorizado + memória de preço
    const codigos = dados.itens.map((i) => i.codigo_item_cliente);
    const { data: mapas, error: mapaErr } = await supabase
      .from("cliente_item_mapa").select("id, codigo_item_cliente, ultimo_preco")
      .eq("cliente_ref", pedido.cliente_ref).in("codigo_item_cliente", codigos);
    if (mapaErr) throw new Error(`Consulta do de-para falhou: ${mapaErr.message}`);
    const mapaPorCodigo = new Map((mapas ?? []).map((m) => [m.codigo_item_cliente, m]));

    const linhas = dados.itens.map((it) => {
      const m = mapaPorCodigo.get(it.codigo_item_cliente);
      return {
        pedido_programado_id,
        codigo_item_cliente: it.codigo_item_cliente,
        num_ordem_cliente: it.num_ordem_cliente,
        descricao_cliente: it.descricao_cliente,
        quantidade: it.quantidade,
        unidade: it.unidade,
        data_entrega_cliente: it.data_entrega,
        cod_forn: it.cod_forn,
        preco_pdf: it.preco_unitario,
        preco_final: m?.ultimo_preco ?? null, // memória de preço; NULL se nunca ajustado
        mapa_id: m?.id ?? null,
      };
    });
    const { error: insErr } = await supabase.from("pedidos_programados_itens").insert(linhas);
    if (insErr) throw new Error(`Insert de itens falhou: ${insErr.message}`);

    // 7. Atualizar header
    const { error: updErr } = await supabase.from("pedidos_programados").update({
      numero_pedido_compra: dados.numero_pedido_compra,
      versao: dados.versao,
      data_emissao_cliente: dados.data_emissao,
      status: "ativo",
      erro_motivo: null,
      extracao_bruta: toolUse.input,
    }).eq("id", pedido_programado_id);
    if (updErr) throw new Error(`Update do header falhou: ${updErr.message}`);

    return json(200, { success: true, itens: linhas.length, numero_pedido_compra: dados.numero_pedido_compra, duplicado_de });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await supabase.from("pedidos_programados")
      .update({ status: "erro_extracao", erro_motivo: msg })
      .eq("id", pedido_programado_id);
    return json(500, { error: msg });
  }
});
```

(No arquivo real, o bloco "espelho" do Step 4.1 é colado verbatim da Task 1 — sem import de `src/`.)

- [ ] **Step 4.2: Typecheck do repo continua verde** (a edge é Deno, o tsc do app não a inclui — verificar que nada de `src/` quebrou)

Run: `heavy bun run typecheck > /tmp/tc.log 2>&1; echo exit=$?`
Expected: exit=0

- [ ] **Step 4.3: Commit**

```bash
git add supabase/functions/pedido-programado-extrair/
git commit -m "feat(pedidos-programados): edge de extração do PDF (Anthropic forced tool-use + de-para/preço memorizados)"
```

---

### Task 5: `omie-vendas-sync` — params `dados_adicionais_nf` e `numero_pedido_cliente`

**Files:**
- Modify: `supabase/functions/omie-vendas-sync/index.ts:1563-1581` (assinatura), `:1641-1648` (informacoes_adicionais), `:2084-2106` (case criar_pedido)

⚠️ **Arquivo QUENTE.** Antes: `git fetch origin main && git log origin/main --oneline -5 -- supabase/functions/omie-vendas-sync/index.ts && gh pr list --state open --search "omie-vendas-sync"`. Se houver PR aberto tocando o arquivo, coordenar antes.

- [ ] **Step 5.1: Assinatura de `criarPedidoVenda`** — acrescentar 2 params opcionais ao FIM:

```typescript
  account: Account = "oben",
  quantidadeVolumes?: number,
  ordemCompra?: string,
  dadosAdicionaisNf?: string,
  numeroPedidoCliente?: string
) {
```

- [ ] **Step 5.2: `informacoes_adicionais`** — logo após o bloco `if (codigoVendedor && codigoVendedor > 0) {...}` (linha ~1648):

```typescript
  // Pedidos programados (Lider): mensagem fixa + nº do PC nas informações complementares
  // da NF (dados_adicionais_nf) e no campo dedicado "Nº do Pedido do Cliente".
  if (dadosAdicionaisNf) {
    informacoes_adicionais.dados_adicionais_nf = dadosAdicionaisNf;
  }
  if (numeroPedidoCliente) {
    informacoes_adicionais.numero_pedido_cliente = numeroPedidoCliente;
  }
```

- [ ] **Step 5.3: `case "criar_pedido"`** — destructure + repasse:

```typescript
      case "criar_pedido": {
        const { sales_order_id, codigo_cliente, codigo_vendedor, items, observacao, codigo_parcela, quantidade_volumes, ordem_compra, dados_adicionais_nf, numero_pedido_cliente } = params;
        if (!sales_order_id || !codigo_cliente || !items?.length) {
          throw new Error("Dados insuficientes para criar pedido de venda");
        }
        // Guard money-path: rejeita ANTES de montar o payload Omie (ver assertOmieItemPricesValid).
        assertOmieItemPricesValid(items);
        await assertOmieItemsAtivos(supabaseAdmin, items, account);
        const pedido = await criarPedidoVenda(
          supabaseAdmin,
          sales_order_id,
          codigo_cliente,
          codigo_vendedor,
          items,
          observacao,
          codigo_parcela,
          account,
          quantidade_volumes,
          ordem_compra,
          dados_adicionais_nf,
          numero_pedido_cliente
        );
        result = { success: true, ...pedido };
        break;
      }
```

- [ ] **Step 5.4: Diff mínimo conferido**

Run: `git diff --stat supabase/functions/omie-vendas-sync/index.ts`
Expected: 1 arquivo, ~15 linhas adicionadas, 0 removidas (além das linhas re-indentadas do case).

- [ ] **Step 5.5: Commit**

```bash
git add supabase/functions/omie-vendas-sync/index.ts
git commit -m "feat(omie-vendas-sync): criar_pedido aceita dados_adicionais_nf e numero_pedido_cliente (aditivo, opcional)"
```

---

### Task 6: Edge `pedido-programado-enviar` (cron + manual)

**Files:**
- Create: `supabase/functions/pedido-programado-enviar/index.ts`

- [ ] **Step 6.1: Escrever a edge**

```typescript
// Processa envios agendados de pedidos programados: valida 100% resolvido (precisão >
// recall), separa por empresa, cria sales_orders e dispara criar_pedido do omie-vendas-sync
// (idempotência PV_${sales_order_id} + guards de preço/ativo na fronteira comum).
// Chamadas: cron diário (body {}) processa data_envio <= hoje BRT; UI staff (body
// {envio_id}) processa um envio imediatamente ("Enviar agora").
// Espelha helpers de src/lib/pedidosProgramados/helpers.ts (Deno não importa de src/).
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";

// ── espelho de src/lib/pedidosProgramados/helpers.ts ──
// [colar verbatim: tipos AccountPP/ConfigConta/ItemResolvido + montarDadosAdicionaisNf +
//  agruparItensPorAccount + validarEnvioResolvido da Task 1]

function hojeBrt(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date()); // YYYY-MM-DD
}
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

interface LinhaItem {
  id: string;
  codigo_item_cliente: string;
  descricao_cliente: string;
  quantidade: number;
  preco_final: number | null;
  mapa: {
    omie_products: { omie_codigo_produto: number; codigo: string; descricao: string; unidade: string | null; account: string } | null;
  } | null;
}

async function processarEnvio(
  supabase: SupabaseClient,
  envio: { id: string; pedido_programado_id: string; sales_orders_map: Record<string, string> },
): Promise<{ ok: boolean; motivo?: string }> {
  const { data: pedido, error: pErr } = await supabase
    .from("pedidos_programados").select("*").eq("id", envio.pedido_programado_id).single();
  if (pErr || !pedido) return { ok: false, motivo: `Header não encontrado: ${pErr?.message}` };

  const { data: itensRaw, error: iErr } = await supabase
    .from("pedidos_programados_itens")
    .select("id, codigo_item_cliente, descricao_cliente, quantidade, preco_final, mapa:cliente_item_mapa(omie_products(omie_codigo_produto, codigo, descricao, unidade, account))")
    .eq("envio_id", envio.id);
  if (iErr) return { ok: false, motivo: `Itens não carregaram: ${iErr.message}` };

  const { data: cfgRows, error: cErr } = await supabase.from("pedidos_programados_config").select("*");
  if (cErr) return { ok: false, motivo: `Config não carregou: ${cErr.message}` };
  const configs = Object.fromEntries((cfgRows ?? []).map((c) => [c.account, c])) as Record<AccountPP, ConfigConta>;

  const itens: ItemResolvido[] = ((itensRaw ?? []) as unknown as LinhaItem[]).map((r) => {
    const prod = r.mapa?.omie_products ?? null;
    return {
      id: r.id,
      codigo_item_cliente: r.codigo_item_cliente,
      descricao_cliente: r.descricao_cliente,
      quantidade: Number(r.quantidade),
      preco_final: r.preco_final === null ? null : Number(r.preco_final),
      account: (prod?.account === "oben" || prod?.account === "colacor") ? prod.account as AccountPP : null,
      omie_codigo_produto: prod ? Number(prod.omie_codigo_produto) : null,
      produto_codigo: prod?.codigo ?? null,
      produto_descricao: prod?.descricao ?? null,
    };
  });

  // Precisão > recall: qualquer pendência segura o envio inteiro, com motivo visível.
  // numeroPc validado no gate (header é nullable — nunca deixar "null" virar texto de NF).
  const numeroPc = typeof pedido.numero_pedido_compra === "string" ? pedido.numero_pedido_compra.trim() : "";
  const problemas = validarEnvioResolvido(numeroPc || null, itens, configs);
  if (problemas.length > 0) return { ok: false, motivo: problemas.join(" | ") };

  const grupos = agruparItensPorAccount(itens);
  const salesOrdersMap: Record<string, string> = { ...(envio.sales_orders_map ?? {}) };
  const erros: string[] = [];

  for (const [account, itensGrupo] of Object.entries(grupos) as Array<[AccountPP, ItemResolvido[]]>) {
    const cfg = configs[account];
    const orderItems = itensGrupo.map((it) => ({
      omie_codigo_produto: it.omie_codigo_produto as number,
      codigo: it.produto_codigo ?? undefined,
      descricao: it.produto_descricao ?? it.descricao_cliente,
      quantidade: it.quantidade,
      valor_unitario: it.preco_final as number,
      valor_total: Number((it.quantidade * (it.preco_final as number)).toFixed(2)),
    }));
    const total = Number(orderItems.reduce((s, i) => s + i.valor_total, 0).toFixed(2));

    try {
      // 1. sales_order idempotente por (envio, account): persistir o id ANTES do Omie.
      let salesOrderId = salesOrdersMap[account];
      if (!salesOrderId) {
        const { data: so, error: soErr } = await supabase.from("sales_orders").insert({
          customer_user_id: cfg.customer_user_id,
          created_by: pedido.created_by,
          items: orderItems,
          subtotal: total,
          discount: 0,
          total,
          status: "rascunho",
          notes: `Pedido programado Lider — PC ${numeroPc} (envio ${envio.id})`,
          account,
        }).select("id").single();
        if (soErr || !so) throw new Error(`sales_order não criado (${account}): ${soErr?.message}`);
        salesOrderId = so.id as string;
        salesOrdersMap[account] = salesOrderId;
        const { error: mapErr } = await supabase.from("pedidos_programados_envios")
          .update({ sales_orders_map: salesOrdersMap }).eq("id", envio.id);
        if (mapErr) throw new Error(`Persistência do sales_orders_map falhou: ${mapErr.message}`);
      } else {
        // Retry: se este sales_order já foi ao Omie, pular (não re-enviar).
        const { data: soExist } = await supabase.from("sales_orders")
          .select("status, omie_pedido_id").eq("id", salesOrderId).single();
        if (soExist?.omie_pedido_id) continue;
      }

      // 2. criar_pedido via omie-vendas-sync (service role) — guards de preço/ativo lá.
      const resp = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/omie-vendas-sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        },
        body: JSON.stringify({
          action: "criar_pedido",
          account,
          sales_order_id: salesOrderId,
          codigo_cliente: cfg.codigo_cliente_omie,
          codigo_vendedor: null,
          items: orderItems,
          observacao: cfg.obs_venda,
          ...(cfg.codigo_parcela ? { codigo_parcela: cfg.codigo_parcela } : {}),
          ordem_compra: numeroPc,
          dados_adicionais_nf: montarDadosAdicionaisNf(cfg.dados_adicionais_nf, numeroPc),
          numero_pedido_cliente: numeroPc,
        }),
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok || body?.error) throw new Error(`criar_pedido ${account} falhou: ${body?.error ?? resp.status}`);
    } catch (e) {
      erros.push(e instanceof Error ? e.message : String(e));
    }
  }

  if (erros.length > 0) return { ok: false, motivo: erros.join(" | ") };
  return { ok: true };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { envio_id } = await req.json().catch(() => ({}));

  let query = supabase.from("pedidos_programados_envios")
    .select("id, pedido_programado_id, sales_orders_map, status, data_envio");
  if (envio_id) {
    query = query.eq("id", envio_id).in("status", ["agendado", "erro"]);
  } else {
    query = query.eq("status", "agendado").lte("data_envio", hojeBrt());
  }
  const { data: envios, error } = await query;
  if (error) return json(500, { error: error.message });

  const resultados: Array<{ envio_id: string; ok: boolean; motivo?: string }> = [];
  for (const envio of envios ?? []) {
    const r = await processarEnvio(supabase, envio as never);
    if (r.ok) {
      await supabase.from("pedidos_programados_envios")
        .update({ status: "enviado", erro_motivo: null }).eq("id", envio.id);
      // Pai concluído quando TODOS os itens estão em envios 'enviado'
      const { data: pendentes } = await supabase
        .from("pedidos_programados_itens")
        .select("id, envio:pedidos_programados_envios(status)")
        .eq("pedido_programado_id", envio.pedido_programado_id);
      const aberto = (pendentes ?? []).some((p) => {
        const st = (p as { envio: { status: string } | null }).envio?.status;
        return st !== "enviado";
      });
      if (!aberto) {
        await supabase.from("pedidos_programados")
          .update({ status: "concluido" }).eq("id", envio.pedido_programado_id);
      }
    } else {
      await supabase.from("pedidos_programados_envios")
        .update({ status: "erro", erro_motivo: r.motivo ?? "erro desconhecido" }).eq("id", envio.id);
    }
    resultados.push({ envio_id: envio.id, ...r });
  }
  return json(200, { success: true, processados: resultados.length, resultados });
});
```

Nota (retry de envio com status 'erro'): o cron só pega `agendado`; envio em `erro` fica visível na tela e o founder decide — "Enviar agora" (body `{envio_id}`) reprocessa com segurança (sales_orders_map + PV_ idempotente).

- [ ] **Step 6.2: Typecheck do app segue verde**

Run: `heavy bun run typecheck > /tmp/tc.log 2>&1; echo exit=$?`
Expected: exit=0

- [ ] **Step 6.3: Commit**

```bash
git add supabase/functions/pedido-programado-enviar/
git commit -m "feat(pedidos-programados): edge de envio (cron+manual) — valida, separa por empresa e reusa criar_pedido idempotente"
```

---

### Task 7: Cron diário

**Files:**
- Create: `supabase/migrations/20260702121000_pedidos_programados_cron.sql`

- [ ] **Step 7.1: Escrever a migration do cron**

```sql
-- Cron diário dos pedidos programados: 09:00 UTC = 06:00 BRT, seg–sáb (padrão do repo).
-- timeout_milliseconds EXPLÍCITO (default 5s mata silencioso — CLAUDE.md/sync.md).
-- Verdade HTTP em net._http_response; cron.job_run_details só prova o enqueue.
SELECT cron.schedule(
  'pedidos-programados-diario',
  '0 9 * * 1-6',
  $$
  SELECT net.http_post(
    url := (SELECT value FROM vault.decrypted_secrets WHERE name = 'project_url')
           || '/functions/v1/pedido-programado-enviar',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT value FROM vault.decrypted_secrets WHERE name = 'service_role_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);
```

- [ ] **Step 7.2: Commit**

```bash
git add supabase/migrations/20260702121000_pedidos_programados_cron.sql
git commit -m "feat(pedidos-programados): cron diário 06h BRT (timeout explícito, vault)"
```

---

### Task 8: Hook `usePedidosProgramados`

**Files:**
- Create: `src/hooks/usePedidosProgramados.ts`

- [ ] **Step 8.1: Escrever o hook** (queries + mutations; `sonner` para toasts; tipos locais — as tabelas novas ainda não estão nos tipos gerados do Supabase, usar cast `from(... as never)` como o repo já faz em `useSalesOrders` com `order_feed`)

```typescript
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { track } from '@/lib/analytics';

export interface PedidoProgramado {
  id: string;
  cliente_ref: string;
  arquivo_path: string;
  numero_pedido_compra: string | null;
  versao: string | null;
  data_emissao_cliente: string | null;
  status: 'extraindo' | 'erro_extracao' | 'ativo' | 'concluido' | 'cancelado';
  erro_motivo: string | null;
  created_at: string;
}

export interface PedidoProgramadoItem {
  id: string;
  pedido_programado_id: string;
  envio_id: string | null;
  codigo_item_cliente: string;
  num_ordem_cliente: string | null;
  descricao_cliente: string;
  quantidade: number;
  unidade: string | null;
  data_entrega_cliente: string | null;
  cod_forn: string | null;
  preco_pdf: number | null;
  preco_final: number | null;
  mapa_id: string | null;
  mapa: {
    id: string;
    ultimo_preco: number | null;
    omie_products: {
      id: string; omie_codigo_produto: number; codigo: string; descricao: string;
      unidade: string | null; account: string; ativo: boolean | null;
    } | null;
  } | null;
}

export interface PedidoProgramadoEnvio {
  id: string;
  pedido_programado_id: string;
  data_envio: string;
  status: 'agendado' | 'enviado' | 'erro' | 'cancelado';
  erro_motivo: string | null;
  sales_orders_map: Record<string, string>;
  created_at: string;
}

export interface PedidoProgramadoConfig {
  account: 'oben' | 'colacor';
  codigo_cliente_omie: number | null;
  customer_user_id: string | null;
  obs_venda: string | null;
  dados_adicionais_nf: string | null;
  codigo_parcela: string | null;
}

const t = (name: string) => supabase.from(name as never);

export function usePedidosProgramadosLista() {
  return useQuery({
    queryKey: ['pedidos-programados'],
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await t('pedidos_programados')
        .select('*').order('created_at', { ascending: false }).limit(200);
      if (error) throw error;
      return (data ?? []) as unknown as PedidoProgramado[];
    },
  });
}

export function usePedidoProgramadoDetalhe(id: string | undefined) {
  return useQuery({
    queryKey: ['pedido-programado', id],
    enabled: !!id,
    staleTime: 30_000,
    queryFn: async () => {
      const [header, itens, envios] = await Promise.all([
        t('pedidos_programados').select('*').eq('id', id!).single(),
        t('pedidos_programados_itens')
          .select('*, mapa:cliente_item_mapa(id, ultimo_preco, omie_products(id, omie_codigo_produto, codigo, descricao, unidade, account, ativo))')
          .eq('pedido_programado_id', id!)
          .order('data_entrega_cliente', { ascending: true, nullsFirst: false }),
        t('pedidos_programados_envios').select('*').eq('pedido_programado_id', id!)
          .order('data_envio', { ascending: true }),
      ]);
      if (header.error) throw header.error;
      if (itens.error) throw itens.error;
      if (envios.error) throw envios.error;
      return {
        pedido: header.data as unknown as PedidoProgramado,
        itens: (itens.data ?? []) as unknown as PedidoProgramadoItem[],
        envios: (envios.data ?? []) as unknown as PedidoProgramadoEnvio[],
      };
    },
  });
}

export function usePedidosProgramadosConfig() {
  return useQuery({
    queryKey: ['pedidos-programados-config'],
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await t('pedidos_programados_config').select('*');
      if (error) throw error;
      return (data ?? []) as unknown as PedidoProgramadoConfig[];
    },
  });
}

export function usePedidosProgramadosMutations(pedidoId?: string) {
  const qc = useQueryClient();
  const invalidar = () => {
    qc.invalidateQueries({ queryKey: ['pedidos-programados'] });
    if (pedidoId) qc.invalidateQueries({ queryKey: ['pedido-programado', pedidoId] });
  };

  const uploadPdf = useMutation({
    mutationFn: async (file: File) => {
      const { data: userData } = await supabase.auth.getUser();
      const uid = userData.user?.id;
      if (!uid) throw new Error('Sessão expirada.');
      const path = `lider/${crypto.randomUUID()}.pdf`;
      const { error: upErr } = await supabase.storage
        .from('pedidos-programados').upload(path, file, { contentType: 'application/pdf', upsert: false });
      if (upErr) throw upErr;
      const { data: header, error: insErr } = await t('pedidos_programados')
        .insert({ arquivo_path: path, created_by: uid, status: 'extraindo' } as never)
        .select('id').single();
      if (insErr || !header) throw insErr ?? new Error('Header não criado');
      const headerId = (header as { id: string }).id;
      const { data: fnData, error: fnErr } = await supabase.functions.invoke('pedido-programado-extrair', {
        body: { pedido_programado_id: headerId },
      });
      if (fnErr) throw new Error(`Extração falhou: ${fnErr.message}`);
      if (fnData?.error) throw new Error(`Extração falhou: ${fnData.error}`);
      track('pedidos_programados.upload');
      return { headerId, duplicadoDe: fnData?.duplicado_de as string | null };
    },
    onSuccess: ({ duplicadoDe }) => {
      invalidar();
      if (duplicadoDe) {
        toast.warning('Já existe um pedido ativo com esse nº de PC — confira se é revisão (VERSAO) e cancele o antigo se for.');
      } else {
        toast.success('PDF extraído.');
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const atualizarItem = useMutation({
    mutationFn: async (p: { id: string; quantidade?: number; preco_final?: number | null }) => {
      const patch: Record<string, unknown> = {};
      if (p.quantidade !== undefined) patch.quantidade = p.quantidade;
      if (p.preco_final !== undefined) patch.preco_final = p.preco_final;
      const { error } = await t('pedidos_programados_itens').update(patch as never).eq('id', p.id);
      if (error) throw error;
    },
    onSuccess: invalidar,
    onError: (e: Error) => toast.error(e.message),
  });

  const mapearItem = useMutation({
    mutationFn: async (p: { clienteRef: string; codigoItemCliente: string; omieProductId: string }) => {
      const { data: mapa, error: mapaErr } = await t('cliente_item_mapa')
        .upsert(
          { cliente_ref: p.clienteRef, codigo_item_cliente: p.codigoItemCliente, omie_product_id: p.omieProductId } as never,
          { onConflict: 'cliente_ref,codigo_item_cliente' },
        )
        .select('id, ultimo_preco').single();
      if (mapaErr || !mapa) throw mapaErr ?? new Error('De-para não salvo');
      const m = mapa as { id: string; ultimo_preco: number | null };
      // Aplica a TODOS os itens pendentes deste pedido com o mesmo código do cliente
      const { error: updErr } = await t('pedidos_programados_itens')
        .update({ mapa_id: m.id } as never)
        .eq('pedido_programado_id', pedidoId!)
        .eq('codigo_item_cliente', p.codigoItemCliente)
        .is('envio_id', null);
      if (updErr) throw updErr;
      track('pedidos_programados.mapear_item');
    },
    onSuccess: () => { invalidar(); toast.success('Item mapeado.'); },
    onError: (e: Error) => toast.error(e.message),
  });

  const criarEnvio = useMutation({
    mutationFn: async (p: { itens: PedidoProgramadoItem[]; dataEnvio: string }) => {
      const { data: envio, error: envErr } = await t('pedidos_programados_envios')
        .insert({ pedido_programado_id: pedidoId!, data_envio: p.dataEnvio } as never)
        .select('id').single();
      if (envErr || !envio) throw envErr ?? new Error('Envio não criado');
      const envioId = (envio as { id: string }).id;
      const { error: updErr } = await t('pedidos_programados_itens')
        .update({ envio_id: envioId } as never)
        .in('id', p.itens.map((i) => i.id));
      if (updErr) throw updErr;
      // Memória de preço: o preço final vira o ultimo_preco do de-para
      for (const it of p.itens) {
        if (it.mapa_id && typeof it.preco_final === 'number' && it.preco_final > 0) {
          await t('cliente_item_mapa').update({ ultimo_preco: it.preco_final } as never).eq('id', it.mapa_id);
        }
      }
      track('pedidos_programados.criar_envio', { itens: p.itens.length });
      return envioId;
    },
    onSuccess: () => { invalidar(); toast.success('Envio agendado.'); },
    onError: (e: Error) => toast.error(e.message),
  });

  const cancelarEnvio = useMutation({
    mutationFn: async (envioId: string) => {
      const { error: e1 } = await t('pedidos_programados_itens')
        .update({ envio_id: null } as never).eq('envio_id', envioId);
      if (e1) throw e1;
      const { error: e2 } = await t('pedidos_programados_envios')
        .update({ status: 'cancelado' } as never).eq('id', envioId)
        .in('status', ['agendado', 'erro']);
      if (e2) throw e2;
    },
    onSuccess: () => { invalidar(); toast.success('Envio cancelado — itens voltaram ao pool.'); },
    onError: (e: Error) => toast.error(e.message),
  });

  const enviarAgora = useMutation({
    mutationFn: async (envioId: string) => {
      const { data, error } = await supabase.functions.invoke('pedido-programado-enviar', {
        body: { envio_id: envioId },
      });
      if (error) throw error;
      const r = data?.resultados?.[0];
      if (r && !r.ok) throw new Error(r.motivo ?? 'Envio falhou');
      track('pedidos_programados.enviar_agora');
    },
    onSuccess: () => { invalidar(); toast.success('Enviado ao Omie.'); },
    onError: (e: Error) => { invalidar(); toast.error(e.message); },
  });

  const salvarConfig = useMutation({
    mutationFn: async (cfg: PedidoProgramadoConfig) => {
      const { error } = await t('pedidos_programados_config').upsert(cfg as never, { onConflict: 'account' });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pedidos-programados-config'] });
      toast.success('Config salva.');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return { uploadPdf, atualizarItem, mapearItem, criarEnvio, cancelarEnvio, enviarAgora, salvarConfig };
}

// Busca de produto p/ mapeamento (sugestão por cod_forn primeiro)
export function useBuscaProdutoMapeamento(termo: string, codForn: string | null) {
  return useQuery({
    queryKey: ['pp-busca-produto', termo, codForn],
    enabled: termo.length >= 2 || !!codForn,
    staleTime: 60_000,
    queryFn: async () => {
      const sel = 'id, omie_codigo_produto, codigo, descricao, unidade, account, ativo';
      const sugestoes = codForn
        ? (await supabase.from('omie_products').select(sel).eq('codigo', codForn).limit(4)).data ?? []
        : [];
      const busca = termo.length >= 2
        ? (await supabase.from('omie_products').select(sel)
            .or(`codigo.ilike.%${termo.replaceAll(',', ' ')}%,descricao.ilike.%${termo.replaceAll(',', ' ')}%`)
            .limit(20)).data ?? []
        : [];
      return { sugestoes, busca };
    },
  });
}
```

⚠️ ESLint barra `.or()` com interpolação crua — usar os helpers de `@/lib/postgrest` no arquivo real (ver `docs/agent/database.md`); o snippet acima marca a INTENÇÃO da busca (codigo OU descricao ilike), a chamada real deve ser `orIlike(query, ['codigo','descricao'], termo)` ou equivalente existente no repo.

- [ ] **Step 8.2: Typecheck**

Run: `heavy bun run typecheck > /tmp/tc.log 2>&1; echo exit=$?`
Expected: exit=0

- [ ] **Step 8.3: Commit**

```bash
git add src/hooks/usePedidosProgramados.ts
git commit -m "feat(pedidos-programados): hook de queries/mutations (upload, de-para, envios, config)"
```

---

### Task 9: Página lista + rota

**Files:**
- Create: `src/pages/PedidosProgramados.tsx`
- Modify: `src/App.tsx` (lazy import + rota staff)

- [ ] **Step 9.1: Página de lista com upload**

```tsx
import { useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/EmptyState';
import { CalendarClock, ChevronLeft, FileUp, Loader2, Settings2 } from 'lucide-react';
import { usePedidosProgramadosLista, usePedidosProgramadosMutations } from '@/hooks/usePedidosProgramados';
import { PedidosProgramadosConfigDialog } from '@/components/pedidosProgramados/ConfigDialog';

const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  extraindo: { label: 'Extraindo…', cls: 'text-status-info' },
  erro_extracao: { label: 'Erro na extração', cls: 'text-status-error' },
  ativo: { label: 'Ativo', cls: 'text-status-success' },
  concluido: { label: 'Concluído', cls: 'text-muted-foreground' },
  cancelado: { label: 'Cancelado', cls: 'text-muted-foreground' },
};

const PedidosProgramados = () => {
  const navigate = useNavigate();
  const { data: pedidos, isPending } = usePedidosProgramadosLista();
  const { uploadPdf } = usePedidosProgramadosMutations();
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <div className="max-w-4xl mx-auto space-y-4 pb-6">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/sales')} className="text-muted-foreground hover:text-foreground">
          <ChevronLeft className="w-4 h-4" />
        </button>
        <div className="flex-1">
          <h1 className="text-lg font-semibold">Pedidos programados</h1>
          <p className="text-xs text-muted-foreground">PDF da Lider → envios agendados ao Omie</p>
        </div>
        <PedidosProgramadosConfigDialog>
          <Button variant="outline" size="sm"><Settings2 className="w-4 h-4 mr-1" />Config</Button>
        </PedidosProgramadosConfigDialog>
        <input
          ref={fileRef} type="file" accept="application/pdf" className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) uploadPdf.mutate(f, { onSuccess: ({ headerId }) => navigate(`/sales/programados/${headerId}`) });
            e.target.value = '';
          }}
        />
        <Button size="sm" onClick={() => fileRef.current?.click()} disabled={uploadPdf.isPending}>
          {uploadPdf.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <FileUp className="w-4 h-4 mr-1" />}
          Subir PDF
        </Button>
      </div>

      {isPending ? (
        <div className="flex items-center justify-center pt-24"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>
      ) : !pedidos || pedidos.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title="Nenhum pedido programado"
          description="Suba o PDF do pedido de compra da Lider pra começar."
          actionLabel="Subir PDF"
          onAction={() => fileRef.current?.click()}
        />
      ) : (
        <div className="space-y-2">
          {pedidos.map((p) => {
            const st = STATUS_LABEL[p.status] ?? STATUS_LABEL.ativo;
            return (
              <button
                key={p.id}
                onClick={() => navigate(`/sales/programados/${p.id}`)}
                className="w-full text-left border rounded-md px-4 py-3 hover:bg-accent/50 transition-colors flex items-center gap-4"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">
                    PC {p.numero_pedido_compra ?? '—'}{p.versao ? ` · v${p.versao}` : ''}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Emissão {p.data_emissao_cliente ? new Date(`${p.data_emissao_cliente}T12:00:00`).toLocaleDateString('pt-BR') : '—'}
                    {' · '}upload {new Date(p.created_at).toLocaleDateString('pt-BR')}
                  </div>
                  {p.erro_motivo && <div className="text-xs text-status-error mt-1 truncate">{p.erro_motivo}</div>}
                </div>
                <Badge variant="outline" className={st.cls}>{st.label}</Badge>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default PedidosProgramados;
```

- [ ] **Step 9.2: Rotas no `src/App.tsx`** — junto às demais rotas `/sales` (dentro do grupo `<RequireStaff />`):

```tsx
const PedidosProgramados = lazy(() => import("./pages/PedidosProgramados"));
const PedidoProgramadoDetalhe = lazy(() => import("./pages/PedidoProgramadoDetalhe"));
// ...
<Route path="/sales/programados" element={<Suspense fallback={<PageSkeleton />}><PedidosProgramados /></Suspense>} />
<Route path="/sales/programados/:id" element={<Suspense fallback={<PageSkeleton />}><PedidoProgramadoDetalhe /></Suspense>} />
```

⚠️ Declarar ANTES da rota `/sales/:id` no arquivo (react-router v6 rankeia por especificidade, mas manter a ordem legível). Conferir como as rotas `/sales/*` existentes estão agrupadas e seguir o padrão local.

- [ ] **Step 9.3: Typecheck + lint (a página detalhe ainda não existe — criar um stub mínimo `src/pages/PedidoProgramadoDetalhe.tsx` que a Task 10 substitui):**

```tsx
const PedidoProgramadoDetalhe = () => null;
export default PedidoProgramadoDetalhe;
```

Run: `heavy bun run typecheck > /tmp/tc.log 2>&1; echo exit=$?; heavy bun run lint > /tmp/lint.log 2>&1; echo exit=$?`
Expected: exit=0 nos dois. (O ConfigDialog vem na Task 10 — se preferir, criar stub também, ou mover o botão Config para a Task 10; decisão do executor, manter compilando.)

- [ ] **Step 9.4: Commit**

```bash
git add src/pages/PedidosProgramados.tsx src/pages/PedidoProgramadoDetalhe.tsx src/App.tsx
git commit -m "feat(pedidos-programados): página de lista com upload de PDF + rotas staff"
```

---

### Task 10: Página detalhe (pool de itens + envios + mapeamento + config)

**Files:**
- Create: `src/pages/PedidoProgramadoDetalhe.tsx` (substitui o stub)
- Create: `src/components/pedidosProgramados/MapearItemDialog.tsx`
- Create: `src/components/pedidosProgramados/ConfigDialog.tsx`

- [ ] **Step 10.1: `MapearItemDialog.tsx`** — busca account-aware com sugestão por `cod_forn`:

```tsx
import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useBuscaProdutoMapeamento } from '@/hooks/usePedidosProgramados';

interface Produto {
  id: string; omie_codigo_produto: number; codigo: string; descricao: string;
  unidade: string | null; account: string; ativo: boolean | null;
}

export function MapearItemDialog(props: {
  children: React.ReactNode;
  codigoItemCliente: string;
  descricaoCliente: string;
  codForn: string | null;
  onEscolher: (p: Produto) => void;
}) {
  const [open, setOpen] = useState(false);
  const [termo, setTermo] = useState('');
  const { data } = useBuscaProdutoMapeamento(termo, open ? props.codForn : null);

  const Linha = ({ p, sugestao }: { p: Produto; sugestao?: boolean }) => (
    <button
      className="w-full text-left px-3 py-2 rounded-md hover:bg-accent/60 flex items-center gap-3"
      onClick={() => { props.onEscolher(p); setOpen(false); }}
    >
      <div className="flex-1 min-w-0">
        <div className="text-sm truncate">{p.descricao}</div>
        <div className="text-xs text-muted-foreground">{p.codigo} · {p.unidade ?? 'UN'}</div>
      </div>
      {sugestao && <Badge variant="outline" className="text-status-info">COD.FORN bate</Badge>}
      <Badge variant="outline">{p.account === 'oben' ? 'Oben' : 'Colacor'}</Badge>
      {p.ativo === false && <Badge variant="outline" className="text-status-error">inativo</Badge>}
    </button>
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{props.children}</DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-base">Mapear item da Lider</DialogTitle>
          <p className="text-xs text-muted-foreground">
            {props.codigoItemCliente} — {props.descricaoCliente}
            {props.codForn ? ` · COD.FORN ${props.codForn}` : ''}
          </p>
        </DialogHeader>
        <Input autoFocus placeholder="Buscar por código ou descrição…" value={termo} onChange={(e) => setTermo(e.target.value)} />
        <div className="max-h-72 overflow-y-auto space-y-1">
          {(data?.sugestoes ?? []).map((p) => <Linha key={`s-${p.id}`} p={p as Produto} sugestao />)}
          {(data?.busca ?? [])
            .filter((p) => !(data?.sugestoes ?? []).some((s) => s.id === p.id))
            .map((p) => <Linha key={p.id} p={p as Produto} />)}
          {termo.length >= 2 && (data?.busca ?? []).length === 0 && (data?.sugestoes ?? []).length === 0 && (
            <p className="text-xs text-muted-foreground px-3 py-4">Nada encontrado.</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 10.2: `ConfigDialog.tsx`** — edita as 2 linhas de config (tabs oben/colacor):

```tsx
import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  usePedidosProgramadosConfig, usePedidosProgramadosMutations, type PedidoProgramadoConfig,
} from '@/hooks/usePedidosProgramados';

function FormConta({ cfg, onSave, saving }: {
  cfg: PedidoProgramadoConfig;
  onSave: (c: PedidoProgramadoConfig) => void;
  saving: boolean;
}) {
  const [draft, setDraft] = useState(cfg);
  useEffect(() => setDraft(cfg), [cfg]);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-xs">Código do cliente no Omie</Label>
          <Input
            value={draft.codigo_cliente_omie ?? ''}
            onChange={(e) => setDraft({ ...draft, codigo_cliente_omie: e.target.value ? Number(e.target.value) : null })}
            inputMode="numeric"
          />
        </div>
        <div>
          <Label className="text-xs">Código da parcela (Omie, opcional)</Label>
          <Input
            value={draft.codigo_parcela ?? ''}
            onChange={(e) => setDraft({ ...draft, codigo_parcela: e.target.value || null })}
          />
        </div>
      </div>
      <div>
        <Label className="text-xs">Observações do pedido (NÃO sai na NF)</Label>
        <Textarea rows={6} value={draft.obs_venda ?? ''} onChange={(e) => setDraft({ ...draft, obs_venda: e.target.value || null })} />
      </div>
      <div>
        <Label className="text-xs">Dados Adicionais da NF (sai nas informações complementares; o nº do PC é acrescentado automaticamente)</Label>
        <Textarea rows={6} value={draft.dados_adicionais_nf ?? ''} onChange={(e) => setDraft({ ...draft, dados_adicionais_nf: e.target.value || null })} />
      </div>
      <Button size="sm" onClick={() => onSave(draft)} disabled={saving}>Salvar</Button>
    </div>
  );
}

export function PedidosProgramadosConfigDialog({ children }: { children: React.ReactNode }) {
  const { data: configs } = usePedidosProgramadosConfig();
  const { salvarConfig } = usePedidosProgramadosMutations();
  const porConta = (acc: 'oben' | 'colacor'): PedidoProgramadoConfig =>
    configs?.find((c) => c.account === acc) ?? {
      account: acc, codigo_cliente_omie: null, customer_user_id: null,
      obs_venda: null, dados_adicionais_nf: null, codigo_parcela: null,
    };
  return (
    <Dialog>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader><DialogTitle className="text-base">Config — pedidos programados (Lider)</DialogTitle></DialogHeader>
        <Tabs defaultValue="oben">
          <TabsList><TabsTrigger value="oben">Oben</TabsTrigger><TabsTrigger value="colacor">Colacor</TabsTrigger></TabsList>
          <TabsContent value="oben"><FormConta cfg={porConta('oben')} onSave={(c) => salvarConfig.mutate(c)} saving={salvarConfig.isPending} /></TabsContent>
          <TabsContent value="colacor"><FormConta cfg={porConta('colacor')} onSave={(c) => salvarConfig.mutate(c)} saving={salvarConfig.isPending} /></TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 10.3: `PedidoProgramadoDetalhe.tsx`** — pool com seleção + envios:

```tsx
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { ChevronLeft, Loader2, Send, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import {
  usePedidoProgramadoDetalhe, usePedidosProgramadosMutations, type PedidoProgramadoItem,
} from '@/hooks/usePedidosProgramados';
import { MapearItemDialog } from '@/components/pedidosProgramados/MapearItemDialog';

const fmtData = (d: string | null) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString('pt-BR') : '—');
const fmtMoeda = (v: number | null) =>
  v === null ? '—' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const ENVIO_STATUS: Record<string, string> = {
  agendado: 'text-status-info', enviado: 'text-status-success',
  erro: 'text-status-error', cancelado: 'text-muted-foreground',
};

const PedidoProgramadoDetalhe = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, isPending } = usePedidoProgramadoDetalhe(id);
  const { atualizarItem, mapearItem, criarEnvio, cancelarEnvio, enviarAgora } = usePedidosProgramadosMutations(id);
  const [selecionados, setSelecionados] = useState<Set<string>>(new Set());
  const [dataEnvio, setDataEnvio] = useState('');

  const pendentes = useMemo(() => (data?.itens ?? []).filter((i) => !i.envio_id), [data?.itens]);
  const itensSelecionados = pendentes.filter((i) => selecionados.has(i.id));
  const selecaoResolvida = itensSelecionados.length > 0 && itensSelecionados.every(
    (i) => i.mapa?.omie_products && typeof i.preco_final === 'number' && i.preco_final > 0,
  );

  if (isPending || !data) {
    return <div className="flex items-center justify-center pt-32"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>;
  }
  const { pedido, itens, envios } = data;

  const toggler = (itemId: string) => (checked: boolean | string) => {
    setSelecionados((prev) => {
      const s = new Set(prev);
      if (checked) s.add(itemId); else s.delete(itemId);
      return s;
    });
  };

  const agendar = () => {
    if (!dataEnvio) { toast.error('Escolha a data de envio.'); return; }
    criarEnvio.mutate(
      { itens: itensSelecionados, dataEnvio },
      { onSuccess: () => { setSelecionados(new Set()); setDataEnvio(''); } },
    );
  };

  const LinhaItem = ({ it, selecionavel }: { it: PedidoProgramadoItem; selecionavel: boolean }) => {
    const prod = it.mapa?.omie_products ?? null;
    return (
      <div className="grid grid-cols-[auto_90px_1fr_1fr_90px_120px] gap-3 items-center border rounded-md px-3 py-2">
        <Checkbox
          checked={selecionados.has(it.id)}
          onCheckedChange={toggler(it.id)}
          disabled={!selecionavel}
          aria-label={`Selecionar ${it.codigo_item_cliente}`}
        />
        <div className="text-xs">
          <div className="text-muted-foreground">entrega</div>
          <div>{fmtData(it.data_entrega_cliente)}</div>
        </div>
        <div className="min-w-0">
          <div className="text-sm truncate">{it.descricao_cliente}</div>
          <div className="text-xs text-muted-foreground">
            {it.codigo_item_cliente}{it.num_ordem_cliente ? ` · ord ${it.num_ordem_cliente}` : ''}
            {it.cod_forn ? ` · COD.FORN ${it.cod_forn}` : ''}
          </div>
        </div>
        <div className="min-w-0">
          {prod ? (
            <>
              <div className="text-sm truncate">{prod.descricao}</div>
              <div className="text-xs text-muted-foreground">
                {prod.codigo} · <Badge variant="outline" className="text-[10px] py-0">{prod.account === 'oben' ? 'Oben' : 'Colacor'}</Badge>
              </div>
            </>
          ) : (
            <MapearItemDialog
              codigoItemCliente={it.codigo_item_cliente}
              descricaoCliente={it.descricao_cliente}
              codForn={it.cod_forn}
              onEscolher={(p) => mapearItem.mutate({ clienteRef: pedido.cliente_ref, codigoItemCliente: it.codigo_item_cliente, omieProductId: p.id })}
            >
              <Button variant="outline" size="sm" className="text-status-warning">Mapear</Button>
            </MapearItemDialog>
          )}
        </div>
        <Input
          type="number" step="0.001" min="0" className="h-8 text-sm"
          defaultValue={it.quantidade}
          disabled={!selecionavel}
          onBlur={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v) && v > 0 && v !== it.quantidade) atualizarItem.mutate({ id: it.id, quantidade: v });
          }}
          aria-label="Quantidade"
        />
        <Input
          type="number" step="0.01" min="0" className="h-8 text-sm"
          placeholder="preço"
          defaultValue={it.preco_final ?? ''}
          disabled={!selecionavel}
          onBlur={(e) => {
            const raw = e.target.value;
            const v = raw === '' ? null : Number(raw);
            if (v === null || (Number.isFinite(v) && v > 0)) {
              if (v !== it.preco_final) atualizarItem.mutate({ id: it.id, preco_final: v });
            }
          }}
          aria-label={`Preço final (PDF: ${fmtMoeda(it.preco_pdf)})`}
          title={`Preço do PDF (referência): ${fmtMoeda(it.preco_pdf)}`}
        />
      </div>
    );
  };

  return (
    <div className="max-w-5xl mx-auto space-y-5 pb-24">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/sales/programados')} className="text-muted-foreground hover:text-foreground">
          <ChevronLeft className="w-4 h-4" />
        </button>
        <div className="flex-1">
          <h1 className="text-lg font-semibold">PC {pedido.numero_pedido_compra ?? '—'}{pedido.versao ? ` · v${pedido.versao}` : ''}</h1>
          <p className="text-xs text-muted-foreground">
            Emissão {fmtData(pedido.data_emissao_cliente)} · {itens.length} itens · {pendentes.length} pendentes
          </p>
        </div>
        <Badge variant="outline">{pedido.status}</Badge>
      </div>

      {/* Pool de itens pendentes */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium">Itens pendentes</h2>
        {pendentes.length === 0
          ? <p className="text-xs text-muted-foreground">Todos os itens já estão em envios.</p>
          : pendentes.map((it) => <LinhaItem key={it.id} it={it} selecionavel />)}
      </section>

      {/* Envios */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium">Envios</h2>
        {envios.length === 0 && <p className="text-xs text-muted-foreground">Nenhum envio criado ainda.</p>}
        {envios.map((e) => {
          const itensDoEnvio = itens.filter((i) => i.envio_id === e.id);
          return (
            <div key={e.id} className="border rounded-md px-4 py-3 space-y-2">
              <div className="flex items-center gap-3">
                <div className="flex-1 text-sm">
                  Envio em <strong>{fmtData(e.data_envio)}</strong> · {itensDoEnvio.length} itens
                </div>
                <Badge variant="outline" className={ENVIO_STATUS[e.status]}>{e.status}</Badge>
                {(e.status === 'agendado' || e.status === 'erro') && (
                  <>
                    <Button variant="outline" size="sm" onClick={() => enviarAgora.mutate(e.id)} disabled={enviarAgora.isPending}>
                      <Send className="w-3.5 h-3.5 mr-1" />Enviar agora
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => cancelarEnvio.mutate(e.id)}>
                      <XCircle className="w-3.5 h-3.5 mr-1" />Cancelar
                    </Button>
                  </>
                )}
              </div>
              {e.erro_motivo && <p className="text-xs text-status-error">{e.erro_motivo}</p>}
              <div className="text-xs text-muted-foreground">
                {itensDoEnvio.map((i) => i.mapa?.omie_products?.descricao ?? i.descricao_cliente).join(' · ')}
              </div>
            </div>
          );
        })}
      </section>

      {/* Barra de agendamento */}
      {itensSelecionados.length > 0 && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-background border rounded-lg shadow-lg px-4 py-3 flex items-center gap-3 z-40">
          <span className="text-sm">{itensSelecionados.length} selecionado(s)</span>
          <Input type="date" className="h-9 w-40" value={dataEnvio} onChange={(e) => setDataEnvio(e.target.value)} aria-label="Data de envio ao Omie" />
          <Button size="sm" onClick={agendar} disabled={!selecaoResolvida || !dataEnvio || criarEnvio.isPending}>
            Criar envio
          </Button>
          {!selecaoResolvida && <span className="text-xs text-status-warning">há item sem mapeamento/preço</span>}
        </div>
      )}
    </div>
  );
};

export default PedidoProgramadoDetalhe;
```

- [ ] **Step 10.4: Typecheck + lint + test**

Run: `heavy bun run typecheck > /tmp/tc.log 2>&1; echo exit=$?; heavy bun run lint > /tmp/lint.log 2>&1; echo exit=$?; heavy bun run test > /tmp/test.log 2>&1; echo exit=$?`
Expected: exit=0 nos três.

- [ ] **Step 10.5: Commit**

```bash
git add src/pages/PedidoProgramadoDetalhe.tsx src/components/pedidosProgramados/
git commit -m "feat(pedidos-programados): tela de detalhe — pool com seleção, mapeamento com sugestão COD.FORN, envios e config"
```

---

### Task 11: Fixture do PDF + golden esperado

**Files:**
- Create: `src/lib/pedidosProgramados/__fixtures__/lider-213294.expected.json`
- Copy: `~/Downloads/LUCAS213294.10375.pdf` → `src/lib/pedidosProgramados/__fixtures__/lider-213294.pdf`
- Modify: `src/lib/pedidosProgramados/helpers.test.ts` (teste com a fixture)

- [ ] **Step 11.1: Copiar o PDF e escrever o esperado**

```bash
cp ~/Downloads/LUCAS213294.10375.pdf src/lib/pedidosProgramados/__fixtures__/lider-213294.pdf
```

`lider-213294.expected.json` (transcrito do PDF a olho — é o gabarito do golden test manual da extração):

```json
{
  "numero_pedido_compra": "213294",
  "data_emissao": "2026-05-20",
  "versao": "2",
  "itens": [
    { "codigo_item_cliente": "3FLA0003M01", "num_ordem_cliente": "50072329", "descricao_cliente": "FLANELA MICROFIBRA AUTOMOTIVA 40 X 40CM - COR AZUL/LARANJA - C/ COSTURAS", "quantidade": 220, "unidade": "UN", "preco_unitario": 16.9, "data_entrega": "2026-07-20", "cod_forn": "644" },
    { "codigo_item_cliente": "3LHO0080012S", "num_ordem_cliente": "50072309", "descricao_cliente": "LIXA HOOKIT GOLD 255Z MR2L S/F #80 125MM", "quantidade": 1700, "unidade": "UN", "preco_unitario": 2.45, "data_entrega": "2026-07-20", "cod_forn": "PRD01931" },
    { "codigo_item_cliente": "3LRO0036000", "num_ordem_cliente": "50072272", "descricao_cliente": "LIXA ROLO GRAO # 36 - MARRON/ GOLDEN- ATX170", "quantidade": 1, "unidade": "MT", "preco_unitario": 25, "data_entrega": "2026-06-17", "cod_forn": "426" },
    { "codigo_item_cliente": "3LSI0050720", "num_ordem_cliente": "50072299", "descricao_cliente": "LIXA SINTA 3M 341DL #50 0120 X 7200", "quantidade": 20, "unidade": "UN", "preco_unitario": 111.4, "data_entrega": "2026-06-24", "cod_forn": "1087" },
    { "codigo_item_cliente": "3SUPHOOKIT", "num_ordem_cliente": "50072326", "descricao_cliente": "SUPORTE HOOKIT EDA 127MM C/ FURO - AA", "quantidade": 34, "unidade": "UN", "preco_unitario": 103, "data_entrega": "2026-07-20", "cod_forn": "609" }
  ]
}
```

- [ ] **Step 11.2: Teste — o gabarito passa na validação**

Acrescentar em `helpers.test.ts`:

```typescript
import esperado213294 from './__fixtures__/lider-213294.expected.json';

describe('fixture Lider 213294', () => {
  it('o gabarito real passa na validarExtracao com 5 itens', () => {
    const r = validarExtracao(esperado213294);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.dados.itens).toHaveLength(5);
      expect(r.dados.numero_pedido_compra).toBe('213294');
      expect(r.dados.itens.map((i) => i.data_entrega)).toContain('2026-06-17');
    }
  });
});
```

(Se o tsconfig não tiver `resolveJsonModule`, importar via `new URL`/`readFileSync` no teste — conferir padrão do repo; ajustar sem mudar o tsconfig global.)

- [ ] **Step 11.3: Rodar testes**

Run: `heavy bunx vitest run src/lib/pedidosProgramados > /tmp/t11.log 2>&1; echo exit=$?`
Expected: exit=0

- [ ] **Step 11.4: Commit**

```bash
git add src/lib/pedidosProgramados/__fixtures__/ src/lib/pedidosProgramados/helpers.test.ts
git commit -m "test(pedidos-programados): fixture do PDF real 213294 + gabarito de extração"
```

---

### Task 12: Verificação final, PR e handoff de deploy (Lovable)

- [ ] **Step 12.1: Health local completo**

Run: `heavy bun run typecheck > /tmp/f1.log 2>&1; echo tc=$?; heavy bun run lint > /tmp/f2.log 2>&1; echo lint=$?; heavy bun run test > /tmp/f3.log 2>&1; echo test=$?; bash db/test-pedidos-programados.sh > /tmp/f4.log 2>&1; echo sql=$?`
Expected: `tc=0 lint=0 test=0 sql=0`. Qualquer vermelho: parar e consertar antes de seguir.

- [ ] **Step 12.2: Espelhos síncronos** — diff manual: as funções espelhadas nas 2 edges são IDÊNTICAS às de `src/lib/pedidosProgramados/helpers.ts` (exceto imports). Conferir com:

```bash
grep -A5 "montarDadosAdicionaisNf" src/lib/pedidosProgramados/helpers.ts supabase/functions/pedido-programado-enviar/index.ts
```

- [ ] **Step 12.3: PR**

```bash
git push -u origin HEAD
gh pr create --title "feat(vendas): pedidos programados — PDF da Lider → envios agendados ao Omie" --body "$(cat <<'EOF'
Spec: docs/superpowers/specs/2026-07-02-pedidos-programados-design.md
Plano: docs/superpowers/plans/2026-07-02-pedidos-programados.md

- 4 tabelas novas (RLS staff-only, provadas em PG17 com falsificação: db/test-pedidos-programados.sh)
- Edge pedido-programado-extrair (Anthropic claude-sonnet-4-6, forced tool-use, PDF→itens, de-para/preço memorizados)
- Edge pedido-programado-enviar (cron+manual; valida 100% resolvido; reusa criar_pedido idempotente)
- omie-vendas-sync: params opcionais dados_adicionais_nf/numero_pedido_cliente (aditivo)
- UI /sales/programados (lista+upload) e /sales/programados/:id (pool, seleção→envio, mapeamento com sugestão COD.FORN, config)
- Cron diário 06h BRT (timeout explícito)

⚠️ Deploy Lovable é MANUAL (3 camadas) — checklist no plano, Task 12.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

(PR não-draft auto-mergeia com CI verde — segurar como draft se quiser revisar antes.)

- [ ] **Step 12.4: Handoff de deploy — usar as skills `lovable-db-operator` e `lovable-deploy-verify`**

Checklist do founder (pós-merge):
1. **Migrations no SQL Editor** (ordem): `20260702120000_pedidos_programados.sql` → validar (`select * from pedidos_programados_config;` deve mostrar oben com 8689689628) → `20260702121000_pedidos_programados_cron.sql` → validar (`select jobname from cron.job where jobname='pedidos-programados-diario';`).
2. **Edges via chat do Lovable** (verbatim do repo): `pedido-programado-extrair` (nova), `pedido-programado-enviar` (nova), `omie-vendas-sync` (atualizada). Conferir `ANTHROPIC_API_KEY` setada nos secrets do projeto.
3. **Publish do frontend** + verificação por bytes (skill `lovable-deploy-verify`, string-alvo: `"Pedidos programados"`).

- [ ] **Step 12.5: Teste ponta a ponta acompanhado (money-path — primeiro envio é ENSAIADO)**

1. Upload do PDF real 213294 em `/sales/programados` → conferir extração contra `lider-213294.expected.json` (5 itens, datas, COD.FORN).
2. Mapear os 5 itens (sugestão COD.FORN deve acertar pelo menos `PRD01931`); preencher preços.
3. Criar envio de TESTE com 1 item barato, data = hoje → **Enviar agora**.
4. No Omie (Oben): pedido criado, etapa 10 (aberto), cliente ESTOFADOS LIDER, item/qtde/preço certos; aba Informações Adicionais → "Nº do Pedido do Cliente" = 213294 e "Dados Adicionais para a NF" = `PEDIDO DE COMPRA Nº: 213294` + mensagem FORMA DE PGTO; aba Observações = RECIBO DE ENTREGA.
5. Validar com o founder o FORMATO da linha do nº do PC (pendência 4 da spec); ajustar `montarDadosAdicionaisNf` se ele quiser outro texto.
6. **Excluir/cancelar o pedido de teste no Omie** (ou faturar se for real) e registrar o resultado.
7. Cancelar o envio de teste no app se não for real; criar os envios reais.
8. D+1: conferir que o cron rodou (`net._http_response` + status dos envios) — assinatura de sucesso: envios `enviado`, pedidos no Omie.

- [ ] **Step 12.6: Registrar no diário**

Adicionar entrada em `docs/historico/programas-vendas.md` (1 parágrafo: o que entrou, PR, migrations, edges, pendências Colacor).

---

## Self-review (rodado na escrita do plano)

- **Spec coverage:** upload+extração (T4), datas por item + pool com seleção manual (T10), de-para memorizado + sugestão COD.FORN (T4/T8/T10), preço memorizado (T4 lê, T8 grava no criarEnvio), envio automático na data (T6/T7), duas mensagens + nº PC na NF (T2 seed, T5 params, T6 montagem), split por empresa (T6), guards precisão>recall (T1/T6), duplicata/versão (T4 → aviso T8), RLS+prova (T2/T3), config UI (T10), deploy manual (T12). Colacor sem cadastro → bloqueio com motivo (validarEnvioResolvido, coberto em teste T1).
- **Placeholders:** nenhum "TBD"; os dois blocos "colar verbatim da Task 1" são instrução de ESPELHO deliberada (padrão do repo) com fonte exata.
- **Type consistency:** `ItemResolvido`/`ConfigConta` idênticos entre T1, T6 (espelho) e uso no T8/T10; `sales_orders_map` jsonb consistente entre migration (T2), edge (T6) e hook (T8); params novos do criar_pedido idênticos entre T5 e o fetch do T6.
