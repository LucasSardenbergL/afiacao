import { describe, it, expect } from "vitest";
import {
  EPOCA_IMPORTAR_TODOS,
  haJanelaAberta,
  isoDataLocal,
  janelaRecentes,
  janelaTodos,
  janelasRelevantes,
  rotuloSemeadura,
  statusJanelas,
  type JanelaCursorRow,
} from "../janelas";

const linha = (extra: Partial<JanelaCursorRow>): JanelaCursorRow => ({
  account: "oben",
  date_from: "2026-01-22",
  date_to: "2026-07-21",
  next_page: null,
  completed_at: null,
  last_error_kind: null,
  running_since: null,
  heartbeat_at: null,
  updated_at: "2026-07-21T12:00:00Z",
  pedidos_falhos: [],
  tentativas_falha: 0,
  falhou_em: null,
  motivo_falha: null,
  ...extra,
});

describe("isoDataLocal", () => {
  it("formata a data LOCAL como YYYY-MM-DD com padding", () => {
    expect(isoDataLocal(new Date(2026, 6, 21))).toBe("2026-07-21");
    expect(isoDataLocal(new Date(2026, 0, 5))).toBe("2026-01-05");
  });

  it("usa os componentes locais mesmo à noite (não o dia UTC seguinte)", () => {
    // 23:30 local: toISOString() viraria o dia seguinte em qualquer fuso a oeste de UTC.
    expect(isoDataLocal(new Date(2026, 6, 21, 23, 30))).toBe("2026-07-21");
  });
});

describe("janelaRecentes", () => {
  it("cobre exatamente os últimos 180 dias", () => {
    expect(janelaRecentes(new Date(2026, 6, 21))).toEqual({ de: "2026-01-22", ate: "2026-07-21" });
  });

  it("atravessa a virada de ano", () => {
    expect(janelaRecentes(new Date(2026, 1, 1))).toEqual({ de: "2025-08-05", ate: "2026-02-01" });
  });
});

describe("janelaTodos", () => {
  it("parte da época fixa (min real: colacor 2020-04-08, oben 2023-09-25) até hoje", () => {
    expect(janelaTodos(new Date(2026, 6, 21))).toEqual({ de: EPOCA_IMPORTAR_TODOS, ate: "2026-07-21" });
    expect(EPOCA_IMPORTAR_TODOS < "2020-04-08").toBe(true);
  });
});

describe("statusJanelas", () => {
  const agora = new Date("2026-07-21T12:00:00Z");

  it("janela com lease e heartbeat fresco (<3 min) está rodando, com a página em curso", () => {
    const [s] = statusJanelas(
      [linha({ running_since: "2026-07-21T11:50:00Z", heartbeat_at: "2026-07-21T11:59:00Z", next_page: 12 })],
      agora,
    );
    expect(s.estado).toBe("rodando");
    expect(s.descricao).toContain("página 12");
  });

  it("janela sem lease vivo aguarda o próximo ciclo do motor", () => {
    const [s] = statusJanelas(
      [linha({ running_since: "2026-07-21T11:00:00Z", heartbeat_at: "2026-07-21T11:05:00Z", next_page: 4 })],
      agora,
    );
    expect(s.estado).toBe("aguardando");
    expect(s.descricao).toContain("página 4");
  });

  it("janela recém-semeada (tudo nulo) aguarda na página 1", () => {
    const [s] = statusJanelas([linha({})], agora);
    expect(s.estado).toBe("aguardando");
    expect(s.descricao).toContain("página 1");
  });

  it("janela completa reporta concluída e a janela em pt-BR", () => {
    const [s] = statusJanelas([linha({ completed_at: "2026-07-21T11:30:00Z" })], agora);
    expect(s.estado).toBe("concluida");
    expect(s.janela).toBe("22/01/2026 → 21/07/2026");
  });

  it("janela aberta com last_error_kind expõe a falha (não finge 'aguardando')", () => {
    const [s] = statusJanelas(
      [linha({ last_error_kind: "http", next_page: 9, heartbeat_at: "2026-07-21T11:00:00Z" })],
      agora,
    );
    expect(s.estado).toBe("falhando");
    expect(s.descricao).toContain("falhou (http)");
    expect(s.descricao).toContain("página 9");
  });

  it("lease vivo tem precedência sobre falha anterior (está re-tentando agora)", () => {
    const [s] = statusJanelas(
      [linha({ last_error_kind: "rate_limit", running_since: "2026-07-21T11:58:00Z", heartbeat_at: "2026-07-21T11:59:30Z", next_page: 9 })],
      agora,
    );
    expect(s.estado).toBe("rodando");
  });
});

describe("janelasRelevantes + haJanelaAberta", () => {
  const agora = new Date("2026-07-21T12:00:00Z");

  it("mantém abertas e concluídas há pouco; descarta concluídas antigas", () => {
    const aberta = linha({});
    const recemConcluida = linha({ account: "colacor", completed_at: "2026-07-21T11:50:00Z" });
    const antiga = linha({ account: "colacor", date_from: "2020-01-01", completed_at: "2026-06-24T08:00:00Z" });
    expect(janelasRelevantes([aberta, recemConcluida, antiga], agora)).toEqual([aberta, recemConcluida]);
  });

  it("haJanelaAberta detecta pendência (e vazio = false)", () => {
    expect(haJanelaAberta([linha({})])).toBe(true);
    expect(haJanelaAberta([linha({ completed_at: "2026-07-21T11:50:00Z" })])).toBe(false);
    expect(haJanelaAberta([])).toBe(false);
  });
});

describe("rotuloSemeadura", () => {
  it("traduz o desfecho da RPC pra toast", () => {
    expect(rotuloSemeadura("semeada")).toBe("armada");
    expect(rotuloSemeadura("ja_pendente")).toBe("já estava armada");
    expect(rotuloSemeadura("ja_concluida")).toBe("já concluída nesta janela");
    expect(rotuloSemeadura("ja_pendente_outra")).toBe("outra importação em andamento");
    expect(rotuloSemeadura(undefined)).toBe("—");
  });
});

describe("falha honesta (janela que não completa com pedido perdido)", () => {
  const agora = new Date("2026-07-21T12:00:00Z");

  it("terminal por pedidos falhos: INCOMPLETA, conta os pedidos e mostra um exemplo; pode re-armar", () => {
    const [s] = statusJanelas(
      [linha({ falhou_em: "2026-07-21T11:00:00Z", motivo_falha: "pedidos_falhos",
               pedidos_falhos: [{ codigo_pedido: 98765, sqlstate: "23505" }, { codigo_pedido: 2, sqlstate: "23505" }] })],
      agora,
    );
    expect(s.estado).toBe("falhou");
    expect(s.descricao).toContain("INCOMPLETA");
    expect(s.descricao).toContain("2 pedidos sem prova no banco");
    expect(s.descricao).toContain("pedido 98765 (23505)");
    expect(s.podeRearmar).toBe(true);
    expect([s.dateFrom, s.dateTo]).toEqual(["2026-01-22", "2026-07-21"]);
  });

  it("terminal por erro persistente: diz a página e o tipo do erro", () => {
    const [s] = statusJanelas(
      [linha({ falhou_em: "2026-07-21T11:00:00Z", motivo_falha: "erro_persistente", next_page: 14, last_error_kind: "http" })],
      agora,
    );
    expect(s.estado).toBe("falhou");
    expect(s.descricao).toContain("erro persistente na página 14 (http)");
  });

  it("terminal NÃO conta como em andamento (não prende botões nem polling)", () => {
    expect(haJanelaAberta([linha({ falhou_em: "2026-07-21T11:00:00Z", motivo_falha: "pedidos_falhos" })])).toBe(false);
    expect(haJanelaAberta([linha({ falhou_em: "2026-07-21T11:00:00Z" }), linha({ account: "colacor" })])).toBe(true);
  });

  it("terminal NUNCA expira do card (é a única via de Re-tentar) — Codex 2º, P5", () => {
    const recente = linha({ falhou_em: "2026-07-01T12:00:00Z" });
    const antiga = linha({ account: "colacor", falhou_em: "2025-01-01T12:00:00Z" });
    expect(janelasRelevantes([recente, antiga], agora)).toEqual([recente, antiga]);
  });

  it("varredura em curso com falhos acumulados avisa, sem esconder (e marca a 2ª varredura)", () => {
    const [s] = statusJanelas(
      [linha({ next_page: 5, tentativas_falha: 1, pedidos_falhos: [{ codigo_pedido: 1, sqlstate: "23505" }] })],
      agora,
    );
    expect(s.estado).toBe("aguardando");
    expect(s.descricao).toContain("1 pedido falhou até aqui");
    expect(s.descricao).toContain("2ª varredura");
  });

  it("pré-registro em trânsito (sem SQLSTATE) NÃO aparece como falha (3º challenge Codex, P6)", () => {
    const [s] = statusJanelas([linha({ next_page: 5, pedidos_falhos: [{ codigo_pedido: 1, hash: "omie_oben_1" }] })], agora);
    expect(s.descricao).not.toContain("falhou");
  });

  it("pedidos_falhos fora do formato não quebra (ausente ≠ zero: só o que dá para ler)", () => {
    const [s] = statusJanelas([linha({ pedidos_falhos: "lixo" as unknown })], agora);
    expect(s.estado).toBe("aguardando");
    expect(s.descricao).not.toContain("falhou");
  });

  it("rótulo do semear para janela terminal aponta o Re-tentar", () => {
    expect(rotuloSemeadura("ja_falhou")).toBe("esta janela falhou — use Re-tentar");
  });
});
