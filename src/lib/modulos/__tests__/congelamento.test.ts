import { describe, expect, it } from "vitest";
import { formatarDataCongelamento, moduloDaRota, rotaCongelada } from "../congelamento";
import type { ModuloApp } from "../tipos";

const PRAZO = { desde: "2026-10-12", ate: "2027-01-10", motivo: "sem uso medido em 90 dias" };
const mod = (id: string, rotaPrefixos: string[], extra: Partial<ModuloApp> = {}): ModuloApp => ({
  id,
  nome: id.toUpperCase(),
  kind: "negocio",
  rotaPrefixos,
  gates: [],
  codigo: [],
  testes: [],
  risco: { moneyPath: false, offlineFirst: false, authSensitive: false },
  status: "ativo",
  ...extra,
});

const MODS = [
  mod("loja", ["/", "/orders"], { status: "congelado", congelamento: PRAZO }),
  mod("crm", ["/admin"], { status: "congelado", congelamento: PRAZO }),
  mod("repo", ["/admin/reposicao"]),
  mod("estoque", ["/admin/estoque"], { rotasCongeladas: { ...PRAZO, prefixos: ["/admin/estoque/picking"] } }),
];

describe("rotaCongelada", () => {
  it('"/" nunca congela, mesmo com o dono congelado', () => {
    expect(rotaCongelada("/", MODS)).toBeNull();
  });

  it("congela a rota e as filhas do prefixo do módulo congelado", () => {
    expect(rotaCongelada("/orders", MODS)?.moduloId).toBe("loja");
    expect(rotaCongelada("/orders/123", MODS)?.ate).toBe("2027-01-10");
    expect(rotaCongelada("/orders/", MODS)?.moduloId).toBe("loja");
  });

  it('prefixo é por SEGMENTO: "/orders-x" não é filha de "/orders", e "/" não casa tudo', () => {
    expect(rotaCongelada("/orders-x", MODS)).toBeNull();
    expect(rotaCongelada("/qualquer", MODS)).toBeNull();
  });

  it("o prefixo mais longo vence: módulo ativo dentro de /admin congelado segue visível", () => {
    expect(moduloDaRota("/admin/reposicao/pedidos", MODS)?.id).toBe("repo");
    expect(rotaCongelada("/admin/reposicao/pedidos", MODS)).toBeNull();
    expect(rotaCongelada("/admin/customers", MODS)?.moduloId).toBe("crm");
  });

  it("congelamento parcial esconde só a sub-rota do módulo ativo", () => {
    expect(rotaCongelada("/admin/estoque/picking/mobile", MODS)?.moduloId).toBe("estoque");
    expect(rotaCongelada("/admin/estoque/recebimento", MODS)).toBeNull();
  });

  it("status não-ativo SEM prazo não congela (o gate do manifesto é quem reprova esse estado)", () => {
    expect(rotaCongelada("/x", [mod("x", ["/x"], { status: "congelado" })])).toBeNull();
  });
});

describe("formatarDataCongelamento", () => {
  it("formata ISO em dd/mm/aaaa sem passar por Date (fuso não muda o dia)", () => {
    expect(formatarDataCongelamento("2027-01-10")).toBe("10/01/2027");
  });
});
