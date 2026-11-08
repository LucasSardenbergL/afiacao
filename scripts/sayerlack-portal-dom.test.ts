// @vitest-environment jsdom
//
// 8.2 do plano Sayerlack (revisão 2): os SELETORES e a PAGINAÇÃO dos scripts do navegador, executados contra HTML.
// As funções testadas são as MESMAS que vão ao Browserless (interpoladas por `.toString()` em
// `sayerlack-importar-pedido-portal/index.ts` e `sayerlack-varrer-pedidos-portal/index.ts`; o `index_test.ts` de cada
// edge prova que o script enviado parseia e as carrega). A saída segue para os leitores REAIS de Deno (`leitura.ts`,
// `varredura.ts`): HTML → objeto → decisão, sem objeto já extraído no meio.
//
// O jsdom não implementa `innerText`; o polyfill abaixo reproduz só o que o leitor usa dele (`<br>` vira quebra de linha,
// que o leitor junta com espaço) — sem ele o leitor cairia no `textContent` e a quebra não seria exercitada.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  aplicarFiltrosConsultaDom,
  clicarProximaPaginaDom,
  lerCondicaoSelecionadaDom,
  lerCondicoesOpcoesDom,
  lerSituacoesDom,
  lerTabelaConsultaDom,
  lerTodasAsPaginas,
  type PaginaConsultaDom,
} from "../supabase/functions/_shared/sayerlack-portal-dom";
import { lerPedidoPortal } from "../supabase/functions/sayerlack-importar-pedido-portal/leitura";
import { lerListaConsulta, provarLeitura } from "../supabase/functions/sayerlack-varrer-pedidos-portal/varredura";

const DIR = join(__dirname, "__fixtures__", "sayerlack-portal");
const fixture = (nome: string) => readFileSync(join(DIR, nome), "utf8");

function innerTextPolyfill(this: Node): string {
  let s = "";
  this.childNodes.forEach((n) => {
    if (n.nodeType === 3) s += (n as Text).data;
    else if (n.nodeName === "BR") s += "\n";
    else if (n.nodeType === 1) s += innerTextPolyfill.call(n);
  });
  return s;
}
Object.defineProperty(HTMLElement.prototype, "innerText", { configurable: true, get: innerTextPolyfill });

function carregar(nome: string) {
  const html = fixture(nome);
  document.documentElement.innerHTML = html.replace(/^[\s\S]*?<html[^>]*>/i, "").replace(/<\/html>\s*$/i, "");
  delete (window as unknown as { jQuery?: unknown }).jQuery;
}

/**
 * DataTables falso: "Próximo" troca a tbody pela próxima página e, na última, desabilita o botão — o mesmo que o portal
 * faz depois do POST /order-viewer/form/list. `paginas[0]` é a tbody que já está no HTML.
 */
function paginacao(paginasSeguintes: string[]) {
  let atual = 0;
  const li = () => document.querySelector("#tabela_next") as HTMLElement;
  const marcar = () => li().classList.toggle("disabled", atual >= paginasSeguintes.length);
  marcar();
  li().querySelector("a")!.addEventListener("click", (e) => {
    e.preventDefault();
    if (atual >= paginasSeguintes.length) return;
    (document.querySelector("#tabela tbody") as HTMLElement).innerHTML = paginasSeguintes[atual];
    atual++;
    marcar();
  });
}

const lerEstavel = async (): Promise<PaginaConsultaDom | null> => {
  const p = lerTabelaConsultaDom();
  return p.ok && !p.processando ? p : null;
};
const avancar = async () => {
  clicarProximaPaginaDom();
  return { ok: true };
};

describe("consulta de pedidos — tabela por nome de coluna", () => {
  beforeEach(() => carregar("consulta-pedidos.html"));

  it("acha a tabela pela coluna de situação, lê o nome no placeholder e junta a quebra de linha", () => {
    const p = lerTabelaConsultaDom();
    expect(p.ok).toBe(true);
    expect(p.headers).toEqual([
      "Estab", "Pedido", "Pedido Clien", "Cliente", "Situação", "Data Emissão", "Data Entrega", "Vlr Mercadori", "Vlr Total",
    ]);
    expect(p.linhas).toHaveLength(2);
    expect(p.linhas[0]).toMatchObject({ Pedido: "2140603", Cliente: "OBEN COMERCIO LTDA", "Situação": "5 - Suspenso" });
    expect(p.processando).toBe(false);
    expect(p.info).toBe("Mostrando 1 até 2 de 3 registros");
    expect(p.temProxima).toBe(true);
    expect(p.dtTotal).toBeNull();
  });

  it("a linha lida do HTML passa pelo leitor real da importadora (cabeçalho do pedido real 2140603)", () => {
    const p = lerTabelaConsultaDom();
    const itens = {
      success: true,
      itens: [[10, "DFA.4080LT", "", "L", 18, 288, 16, 19.8637, 357.5466, 357.5466, 5, "14,9488", 4865.5584,
        "DILUENTE PU 4080A LT", "PROREAL", 30, "0.0000", "1.0000", "", 5]],
    };
    const r = lerPedidoPortal(p.linhas, itens, "2140603");
    if (!r.ok) throw new Error(`esperava ok, veio ${r.motivo}: ${r.detalhe}`);
    expect(r.cabecalho).toEqual({
      protocolo: "2140603", cliente: "OBEN COMERCIO LTDA", situacao: "5 - Suspenso",
      data_entrega: "2026-10-26", valor_mercadoria: 4865.56, valor_total: 5181.82,
    });
  });

  it("'Processando' visível: a página não está estável", () => {
    (document.querySelector(".dataTables_processing") as HTMLElement).style.display = "block";
    expect(lerTabelaConsultaDom().processando).toBe(true);
  });

  it("tabela vazia do DataTables (td.dataTables_empty) = zero linhas, não uma linha-fantasma", () => {
    (document.querySelector("#tabela tbody") as HTMLElement).innerHTML = fixture("consulta-vazia.tbody.html");
    const p = lerTabelaConsultaDom();
    expect(p.ok).toBe(true);
    expect(p.linhas).toEqual([]);
  });

  it("sem tabela com coluna de situação: ok=false (o leitor não escolhe a tabela de menu)", () => {
    document.querySelector("#tabela")!.remove();
    expect(lerTabelaConsultaDom()).toMatchObject({ ok: false, headers: [], linhas: [] });
  });

  it("info pelo id da tabela quando a classe .dataTables_info não existe", () => {
    document.querySelector("#tabela_info")!.classList.remove("dataTables_info");
    expect(lerTabelaConsultaDom().info).toBe("Mostrando 1 até 2 de 3 registros");
  });

  it("total pela API da instância DataTables (recordsDisplay) quando há jQuery", () => {
    const tabela = document.querySelector("#tabela");
    const jq = Object.assign((el: unknown) => ({ DataTable: () => ({ page: { info: () => ({ recordsDisplay: el === tabela ? 3 : -1 }) } }) }), {
      fn: { dataTable: { isDataTable: (el: unknown) => el === tabela } },
    });
    (window as unknown as { jQuery: unknown }).jQuery = jq;
    expect(lerTabelaConsultaDom().dtTotal).toBe(3);
  });
});

describe("paginação da varredura", () => {
  beforeEach(() => carregar("consulta-pedidos.html"));

  it("lê as 2 páginas pelo botão 'Próximo' e a lista inteira PROVA a leitura no leitor real da varredura", async () => {
    paginacao([fixture("consulta-pagina-2.tbody.html")]);
    const r = await lerTodasAsPaginas(lerEstavel, avancar, 30);
    if (!r.ok) throw new Error(`esperava ok, veio ${r.erroTipo}`);
    expect(r.paginas).toBe(2);
    expect(r.linhas.map((l) => l.Pedido)).toEqual(["2140603", "2141200", "2141300"]);
    const lista = lerListaConsulta(r.linhas);
    expect([lista.pedidos.length, lista.ilegiveis, lista.repetidos]).toEqual([3, 0, []]);
    const prova = provarLeitura({
      headers: r.primeira.headers, linhasLidas: r.linhas.length, info: r.primeira.info, dtTotal: r.primeira.dtTotal,
      ilegiveis: lista.ilegiveis, repetidos: lista.repetidos,
    });
    expect(prova).toEqual({ ok: true, total: 3 });
  });

  it("botão 'Próximo' desabilitado no <li>: uma página só", async () => {
    paginacao([]);
    const r = await lerTodasAsPaginas(lerEstavel, avancar, 30);
    expect(r).toMatchObject({ ok: true, paginas: 1 });
    // a leitura de 2 com o portal anunciando 3 NÃO prova a lista (página perdida)
    const prova = provarLeitura({
      headers: r.primeira!.headers, linhasLidas: r.linhas.length, info: r.primeira!.info, ilegiveis: 0, repetidos: [],
    });
    expect(prova).toMatchObject({ ok: false, motivo: "lidos_diferente_do_total" });
  });

  it("marcação sem bootstrap: <a class='paginate_button next'> com o disabled no <li> pai = sem próxima", async () => {
    document.querySelector("#tabela_paginate ul")!.innerHTML =
      '<li class="page-item next disabled"><a href="#" class="paginate_button next">Próximo</a></li>';
    expect(lerTabelaConsultaDom().temProxima).toBe(false);
    (document.querySelector("#tabela_paginate li") as HTMLElement).classList.remove("disabled");
    expect(lerTabelaConsultaDom().temProxima).toBe(true);
  });

  it("mais páginas que o teto: PAGINACAO_INCOMPLETA, nunca sucesso parcial", async () => {
    paginacao([fixture("consulta-pagina-2.tbody.html"), fixture("consulta-pagina-2.tbody.html")]);
    const r = await lerTodasAsPaginas(lerEstavel, avancar, 2);
    expect(r).toMatchObject({ ok: false, erroTipo: "PAGINACAO_INCOMPLETA", paginas: 2 });
  });

  it("a página seguinte não estabiliza (Processando): PAGINACAO_ILEGIVEL", async () => {
    paginacao([fixture("consulta-pagina-2.tbody.html")]);
    const r = await lerTodasAsPaginas(lerEstavel, async (n) => {
      await avancar();
      (document.querySelector(".dataTables_processing") as HTMLElement).style.display = "block";
      return { ok: n > 0 };
    }, 30);
    expect(r).toMatchObject({ ok: false, erroTipo: "PAGINACAO_ILEGIVEL", paginas: 1 });
  });

  it("o portal não responde à próxima página: PAGINACAO_SEM_RESPOSTA", async () => {
    paginacao([fixture("consulta-pagina-2.tbody.html")]);
    const r = await lerTodasAsPaginas(lerEstavel, async () => ({ ok: false }), 30);
    expect(r).toMatchObject({ ok: false, erroTipo: "PAGINACAO_SEM_RESPOSTA", paginas: 1 });
  });

  it("tabela ausente na 1ª leitura: CONSULTA_ILEGIVEL", async () => {
    document.querySelector("#tabela")!.remove();
    const r = await lerTodasAsPaginas(lerEstavel, avancar, 30);
    expect(r).toMatchObject({ ok: false, erroTipo: "CONSULTA_ILEGIVEL", paginas: 0 });
  });
});

describe("filtros e situações", () => {
  beforeEach(() => carregar("consulta-pedidos.html"));

  it("aplica os filtros da importadora (nº início = fim) e devolve o que ficou em cada campo", () => {
    const f = aplicarFiltrosConsultaDom("2059", "2140603", "2140603", "2020-01-01");
    expect(f).toMatchObject({ cliente: "2059", exibir: "1", situacao: "todos", ini: "2140603", fim: "2140603", emissao: "2020-01-01" });
    expect(Object.values(f.set).every(Boolean)).toBe(true);
    expect((document.querySelector("#data_entrega_ini") as HTMLInputElement).value).toBe("2020-01-01");
  });

  it("cliente que o portal não oferece fica fora do select: o chamador vê e recusa (CLIENTE_INDISPONIVEL)", () => {
    const f = aplicarFiltrosConsultaDom("9999", "", "", "2026-11-01");
    expect(f.cliente).not.toBe("9999");
  });

  it("campo de filtro ausente no HTML aparece como não aplicado", () => {
    document.querySelector("#num_ped_fim")!.remove();
    const f = aplicarFiltrosConsultaDom("2059", "", "", "2026-11-01");
    expect([f.set.fim, f.fim]).toEqual([false, null]);
  });

  it("lê as situações oferecidas pelo portal (valor + texto)", () => {
    expect(lerSituacoesDom()).toContainEqual({ valor: "6", texto: "6 - Cancelado" });
    expect(lerSituacoesDom()).toHaveLength(5);
  });
});

describe("tela de detalhe — condição de pagamento", () => {
  beforeEach(() => carregar("detalhe-pedido.html"));

  it("lê a condição SELECIONADA e todas as opções", () => {
    expect(lerCondicaoSelecionadaDom()).toBe("70 - 7 DIAS");
    expect(lerCondicoesOpcoesDom()).toEqual(["Selecione", "54 - 30 DIAS", "70 - 7 DIAS", "71 - 7 DIAS (C)"]);
  });

  it("'Selecione' selecionado = ainda sem condição (false, o waitForFunction segue esperando)", () => {
    (document.querySelector("#condicoes_pagamento") as HTMLSelectElement).value = "";
    expect(lerCondicaoSelecionadaDom()).toBe(false);
  });

  it("sem o select: sem condição e sem opções", () => {
    document.querySelector("#condicoes_pagamento")!.remove();
    expect([lerCondicaoSelecionadaDom(), lerCondicoesOpcoesDom()]).toEqual([false, []]);
  });
});
