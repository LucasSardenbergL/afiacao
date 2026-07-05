import { describe, expect, it } from "vitest";
import {
  codigosInativosOmie,
  deveBloquearPorMinimoFaturamento,
  itensDoPedidoInativos,
  itensInativosMessage,
  overridePermitidoNoModo,
  type GateConfig,
} from "../disparo-gate-helpers";

const cfg: GateConfig = { valorMinimo: 3000, fornecedorPattern: "%SAYERLACK%" };

const base = {
  fornecedor_nome: "SAYERLACK DO BRASIL LTDA",
  valor_total: 2000,
  split_parent_id: null,
  portal_protocolo: null,
  status_envio_portal: null,
};

describe("deveBloquearPorMinimoFaturamento", () => {
  it("barra pedido Sayerlack abaixo da régua, com motivo legível", () => {
    const r = deveBloquearPorMinimoFaturamento(base, cfg);
    expect(r.bloquear).toBe(true);
    expect(r.motivo).toContain("mínimo de faturamento");
    expect(r.motivo).toContain("3000");
  });

  it("passa pedido exatamente NA régua (>= passa)", () => {
    expect(
      deveBloquearPorMinimoFaturamento({ ...base, valor_total: 3000 }, cfg)
        .bloquear,
    ).toBe(false);
  });

  it("passa pedido acima da régua", () => {
    expect(
      deveBloquearPorMinimoFaturamento({ ...base, valor_total: 3500.5 }, cfg)
        .bloquear,
    ).toBe(false);
  });

  it("isenta filho de split (herda a aprovação do pai)", () => {
    expect(
      deveBloquearPorMinimoFaturamento({ ...base, split_parent_id: 99 }, cfg)
        .bloquear,
    ).toBe(false);
  });

  it("isenta fornecedor fora do pattern", () => {
    expect(
      deveBloquearPorMinimoFaturamento(
        { ...base, fornecedor_nome: "ACRE CAXIAS" },
        cfg,
      ).bloquear,
    ).toBe(false);
  });

  it("casa o pattern sem case-sensitivity", () => {
    expect(
      deveBloquearPorMinimoFaturamento(
        { ...base, fornecedor_nome: "Sayerlack do Brasil" },
        cfg,
      ).bloquear,
    ).toBe(true);
  });

  it("isenta pedido que já tocou o portal (protocolo)", () => {
    expect(
      deveBloquearPorMinimoFaturamento(
        { ...base, portal_protocolo: "2100743" },
        cfg,
      ).bloquear,
    ).toBe(false);
  });

  it.each([
    "sucesso_portal",
    "enviado_portal",
    "aceito_portal_sem_protocolo",
    "indeterminado_requer_conciliacao",
  ])("isenta status_envio_portal pós-envio: %s", (s) => {
    expect(
      deveBloquearPorMinimoFaturamento(
        { ...base, status_envio_portal: s },
        cfg,
      ).bloquear,
    ).toBe(false);
  });

  it.each(["pendente_envio_portal", "erro_retentavel", "falha_envio_portal"])(
    "NÃO isenta portal que não chegou ao fornecedor: %s",
    (s) => {
      expect(
        deveBloquearPorMinimoFaturamento(
          { ...base, status_envio_portal: s },
          cfg,
        ).bloquear,
      ).toBe(true);
    },
  );

  it("barra valor_total nulo/NaN (pedido Sayerlack sem valor não fatura)", () => {
    expect(
      deveBloquearPorMinimoFaturamento({ ...base, valor_total: null }, cfg)
        .bloquear,
    ).toBe(true);
  });

  it("gate desligado quando a régua está ausente/inválida", () => {
    expect(
      deveBloquearPorMinimoFaturamento(base, {
        valorMinimo: null,
        fornecedorPattern: "%SAYERLACK%",
      }).bloquear,
    ).toBe(false);
    expect(
      deveBloquearPorMinimoFaturamento(base, {
        valorMinimo: 0,
        fornecedorPattern: "%SAYERLACK%",
      }).bloquear,
    ).toBe(false);
    expect(
      deveBloquearPorMinimoFaturamento(base, {
        valorMinimo: Number.NaN,
        fornecedorPattern: "%SAYERLACK%",
      }).bloquear,
    ).toBe(false);
  });

  it("gate desligado quando o pattern está ausente/vazio (incl. só %)", () => {
    expect(
      deveBloquearPorMinimoFaturamento(base, {
        valorMinimo: 3000,
        fornecedorPattern: null,
      }).bloquear,
    ).toBe(false);
    expect(
      deveBloquearPorMinimoFaturamento(base, {
        valorMinimo: 3000,
        fornecedorPattern: "  ",
      }).bloquear,
    ).toBe(false);
    expect(
      deveBloquearPorMinimoFaturamento(base, {
        valorMinimo: 3000,
        fornecedorPattern: "%%",
      }).bloquear,
    ).toBe(false);
  });
});

// Override por pedido (ignorar_minimo) — a "exceção consciente" do gestor/master no
// re-disparo individual. O helper só DECIDE; quem garante "só modo individual + gestor"
// é o caller (edge/UI). `overridden:true` = o gate IA barrar e a flag liberou (audit);
// quando não havia bloqueio, a flag é no-op (overridden ausente/falsy).
describe("deveBloquearPorMinimoFaturamento — override ignorarMinimo", () => {
  it("ignorarMinimo libera pedido que SERIA barrado, marcando overridden", () => {
    const r = deveBloquearPorMinimoFaturamento(base, cfg, { ignorarMinimo: true });
    expect(r.bloquear).toBe(false);
    expect(r.overridden).toBe(true);
  });

  it("sem a flag, o pedido abaixo da régua segue barrado (override é opt-in)", () => {
    const semFlag = deveBloquearPorMinimoFaturamento(base, cfg);
    expect(semFlag.bloquear).toBe(true);
    expect(semFlag.overridden).toBeFalsy();
    const flagFalsa = deveBloquearPorMinimoFaturamento(base, cfg, { ignorarMinimo: false });
    expect(flagFalsa.bloquear).toBe(true);
    expect(flagFalsa.overridden).toBeFalsy();
  });

  it("ignorarMinimo em pedido que NÃO seria barrado é no-op (overridden falsy)", () => {
    // Acima da régua: nada a overridar.
    const acima = deveBloquearPorMinimoFaturamento(
      { ...base, valor_total: 5000 },
      cfg,
      { ignorarMinimo: true },
    );
    expect(acima.bloquear).toBe(false);
    expect(acima.overridden).toBeFalsy();

    // Fornecedor fora do pattern: o gate nem se aplica.
    const outroForn = deveBloquearPorMinimoFaturamento(
      { ...base, fornecedor_nome: "ACRE CAXIAS" },
      cfg,
      { ignorarMinimo: true },
    );
    expect(outroForn.bloquear).toBe(false);
    expect(outroForn.overridden).toBeFalsy();

    // Filho de split: já isento.
    const filho = deveBloquearPorMinimoFaturamento(
      { ...base, split_parent_id: 99 },
      cfg,
      { ignorarMinimo: true },
    );
    expect(filho.bloquear).toBe(false);
    expect(filho.overridden).toBeFalsy();
  });

  it("ignorarMinimo com gate DESLIGADO (régua ausente) não inventa override", () => {
    const r = deveBloquearPorMinimoFaturamento(
      base,
      { valorMinimo: null, fornecedorPattern: "%SAYERLACK%" },
      { ignorarMinimo: true },
    );
    expect(r.bloquear).toBe(false);
    expect(r.overridden).toBeFalsy();
  });
});

// O override só pode valer no disparo INDIVIDUAL (pedido_id de um pedido REAL = positivo). O
// ternário da query na edge (pedidoId ? individual : lote) trata pedido_id=0 como LOTE; sem
// este predicado, {pedido_id:0, ignorar_minimo:true} de um gestor caía no LOTE COM override
// = bypass do gate em todos os aprovados do dia (achado P1 do Codex). pedido_id ausente/0/
// negativo/NaN → modo lote/cron → override NUNCA.
describe("overridePermitidoNoModo", () => {
  it("true só para pedido_id POSITIVO (disparo individual real)", () => {
    expect(overridePermitidoNoModo(5)).toBe(true);
    expect(overridePermitidoNoModo(409)).toBe(true);
  });

  it("false para pedido_id=0 (o bypass de lote do Codex)", () => {
    expect(overridePermitidoNoModo(0)).toBe(false);
  });

  it("false para ausente/negativo/NaN (modo lote/cron ou inválido)", () => {
    expect(overridePermitidoNoModo(null)).toBe(false);
    expect(overridePermitidoNoModo(undefined)).toBe(false);
    expect(overridePermitidoNoModo(-1)).toBe(false);
    expect(overridePermitidoNoModo(Number.NaN)).toBe(false);
  });
});

// ── Gate de produto ATIVO no disparo (money-path) ──
// Espelha a semântica do gate de ativo de vendas (assertOmieItemsAtivos): produto desativado no
// Omie NUNCA vai num pedido de compra ao fornecedor. DUAS fontes (Codex 2026-07-04): o espelho
// omie_products.ativo é best-effort e pode ficar stale se o UPDATE falhar sem falhar a edge;
// sku_status_omie.ativo_no_omie é a saída direta da sync de status. SÓ false explícito bloqueia
// (null/ausente/true libera — o espelho é ~50-75% inativo; travar por ausência barraria pedido
// legítimo). Espelhado VERBATIM no edge disparar-pedidos-aprovados (Deno não importa de src/).
describe("codigosInativosOmie — união das 2 fontes de status", () => {
  it("marca inativo por omie_products.ativo === false", () => {
    const s = codigosInativosOmie([{ omie_codigo_produto: 111, ativo: false }], []);
    expect(s.has(111)).toBe(true);
  });

  it("marca inativo por sku_status_omie=false MESMO com omie_products ausente (espelho stale)", () => {
    // O ponto do Codex: se o UPDATE espelho falhou, sku_status_omie=false fresco tem que pegar.
    const s = codigosInativosOmie([], [{ sku_codigo_omie: 222, ativo_no_omie: false }]);
    expect(s.has(222)).toBe(true);
  });

  it("marca inativo por sku_status_omie=false mesmo com omie_products.ativo=true (fontes divergem)", () => {
    const s = codigosInativosOmie(
      [{ omie_codigo_produto: 333, ativo: true }],
      [{ sku_codigo_omie: 333, ativo_no_omie: false }],
    );
    expect(s.has(333)).toBe(true);
  });

  it("SÓ false bloqueia: true/null liberam (espelho desatualizado ≠ desativação)", () => {
    const s = codigosInativosOmie(
      [
        { omie_codigo_produto: 1, ativo: true },
        { omie_codigo_produto: 2, ativo: null },
      ],
      [
        { sku_codigo_omie: 3, ativo_no_omie: true },
        { sku_codigo_omie: 4, ativo_no_omie: null },
      ],
    );
    expect(s.size).toBe(0);
  });

  it("ignora código não-finito (NaN/'' não é 'desativado')", () => {
    const s = codigosInativosOmie(
      [{ omie_codigo_produto: "abc", ativo: false }],
      [{ sku_codigo_omie: "", ativo_no_omie: false }],
    );
    expect(s.size).toBe(0);
  });

  it("dedupe: mesmo código inativo nas 2 fontes entra uma vez", () => {
    const s = codigosInativosOmie(
      [{ omie_codigo_produto: 555, ativo: false }],
      [{ sku_codigo_omie: 555, ativo_no_omie: false }],
    );
    expect([...s]).toEqual([555]);
  });

  it("aceita código como string numérica (coerção, como vem do banco)", () => {
    const s = codigosInativosOmie([{ omie_codigo_produto: "777", ativo: false }], []);
    expect(s.has(777)).toBe(true);
  });

  it("listas vazias → set vazio", () => {
    expect(codigosInativosOmie([], []).size).toBe(0);
  });
});

describe("itensDoPedidoInativos — itens do pedido barrados", () => {
  const inativos = new Set<number>([111, 222]);

  it("retorna só os itens cujo sku está inativo", () => {
    const out = itensDoPedidoInativos(
      [
        { sku_codigo_omie: 111, sku_descricao: "CATALISADOR X" },
        { sku_codigo_omie: 999, sku_descricao: "ATIVO Y" },
      ],
      inativos,
    );
    expect(out.map((i) => Number(i.sku_codigo_omie))).toEqual([111]);
  });

  it("dedupe por código preservando a ordem da 1ª ocorrência", () => {
    const out = itensDoPedidoInativos(
      [
        { sku_codigo_omie: 222, sku_descricao: "A" },
        { sku_codigo_omie: 111, sku_descricao: "B" },
        { sku_codigo_omie: 222, sku_descricao: "A dup" },
      ],
      inativos,
    );
    expect(out.map((i) => Number(i.sku_codigo_omie))).toEqual([222, 111]);
  });

  it("ignora sku não-finito", () => {
    const out = itensDoPedidoInativos([{ sku_codigo_omie: "x", sku_descricao: "Z" }], inativos);
    expect(out).toEqual([]);
  });

  it("pedido todo ativo → nenhum barrado", () => {
    const out = itensDoPedidoInativos([{ sku_codigo_omie: 999 }], inativos);
    expect(out).toEqual([]);
  });
});

describe("itensInativosMessage", () => {
  it("lista descrições dos itens barrados, com instrução de ação", () => {
    const msg = itensInativosMessage([
      { sku_codigo_omie: 111, sku_descricao: "CATALISADOR FC.5202" },
    ]);
    expect(msg).toContain("CATALISADOR FC.5202");
    expect(msg).toContain("Reative");
  });

  it("cai pro código quando não há descrição", () => {
    const msg = itensInativosMessage([{ sku_codigo_omie: 111 }]);
    expect(msg).toContain("111");
  });
});
