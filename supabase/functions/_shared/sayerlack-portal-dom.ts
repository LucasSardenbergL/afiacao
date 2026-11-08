/* eslint-disable @typescript-eslint/no-explicit-any -- DOM e jQuery da página do portal sem tipos (o Deno não tem lib DOM); o comportamento é provado contra HTML */
// Funções que RODAM NA PÁGINA do portal Sayerlack (dentro de `page.evaluate` / `page.waitForFunction` no Chrome do
// Browserless) e o laço de paginação da consulta. Vivem aqui, e não escritas dentro do template do script, para serem
// EXECUTADAS contra HTML de verdade nos testes (8.2: `scripts/sayerlack-portal-dom.test.ts`, vitest + jsdom). Antes, os
// testes só viam objetos já extraídos — um seletor quebrado passava verde.
//
// ⚠️ Cada função é INTERPOLADA no script via `${fn.toString()}` (mesmo molde de `classificarPosLogin`). Por isso:
//  - SELF-CONTAINED: não referencia nada do módulo (nem outra função daqui, nem import, nem constante);
//  - na página: `document`/`window` lidos de `globalThis` DENTRO da função; o laço recebe tudo por parâmetro;
//  - sem crase (template literal) e sem cifrão-chave no corpo — o texto entra num template.
// Contrato de saída IGUAL ao que o script tinha embutido (consumido em Deno por `leitura.ts` e `varredura.ts`).

/** Linha da tabela de consulta: nome da coluna → texto da célula. */
export type LinhaConsultaDom = Record<string, string>;

export interface PaginaConsultaDom {
  ok: boolean;
  headers: string[];
  linhas: LinhaConsultaDom[];
  processando: boolean;
  info: string | null;
  temProxima: boolean;
  dtTotal?: number | null;
}

/**
 * Lê a tabela de resultado da consulta de pedidos por NOME de coluna (os cabeçalhos são campos de filtro: o nome mora
 * no placeholder). Devolve também o estado da paginação (botão "próxima") e o total da instância DataTables.
 */
export function lerTabelaConsultaDom(): PaginaConsultaDom {
  // deno-lint-ignore no-explicit-any
  const g: any = globalThis;
  const document = g.document;
  const w = g;
  // deno-lint-ignore no-explicit-any
  const texto = (el: any): string => (typeof el.innerText === "string" ? el.innerText : (el.textContent || ""));
  // deno-lint-ignore no-explicit-any
  const nomeTh = (th: any): string => {
    const inp = th.querySelector("input");
    return (texto(th).trim() || (inp && inp.placeholder ? inp.placeholder.trim() : "") ||
      (th.getAttribute("aria-label") || "").split(":")[0].trim());
  };
  // deno-lint-ignore no-explicit-any
  // deno-lint-ignore no-explicit-any
  const t: any = Array.from(document.querySelectorAll("table")).find((tb: any) =>
    Array.from(tb.querySelectorAll("thead th")).some((th) => nomeTh(th).toLowerCase().indexOf("situa") !== -1)
  );
  if (!t) return { ok: false, headers: [], linhas: [], processando: false, info: null, temProxima: false };
  let headers: string[] = [];
  // deno-lint-ignore no-explicit-any
  Array.from(t.querySelectorAll("thead tr")).forEach((tr: any) => {
    const hs = Array.from(tr.children).map(nomeTh);
    if (hs.filter(Boolean).length > headers.filter(Boolean).length) headers = hs;
  });
  const linhas = Array.from(t.querySelectorAll("tbody tr"))
    // deno-lint-ignore no-explicit-any
    .filter((tr: any) => !tr.querySelector("td.dataTables_empty"))
    // deno-lint-ignore no-explicit-any
    .map((tr: any) => {
      const tds = Array.from(tr.children);
      const o: LinhaConsultaDom = {};
      headers.forEach((h, i) => {
        if (h && tds[i]) o[h] = texto(tds[i]).split(String.fromCharCode(10)).join(" ").trim();
      });
      return o;
    });
  const proc = document.querySelector(".dataTables_processing");
  const processando = !!proc && w.getComputedStyle(proc).display !== "none";
  // '.dataTables_info' nunca casou em 46 rodadas: o portal pode nomear o elemento pelo id da tabela ('<id>_info').
  const infoEl = document.querySelector(".dataTables_info") || document.querySelector('[id$="_info"]') ||
    document.querySelector(".dt-info");
  const prox = document.querySelector(".paginate_button.next");
  const temProxima = !!prox && !prox.classList.contains("disabled") &&
    !(prox.parentElement && prox.parentElement.classList.contains("disabled"));
  // Total pela API da instância DataTables DESTA tabela (page.info().recordsDisplay), sem depender do elemento visual.
  let dtTotal: number | null = null;
  try {
    const jq = w.jQuery;
    if (jq && jq.fn && jq.fn.dataTable && jq.fn.dataTable.isDataTable(t)) {
      const pi = jq(t).DataTable().page.info();
      if (pi && typeof pi.recordsDisplay === "number") dtTotal = pi.recordsDisplay;
    }
  } catch (_e) {
    dtTotal = null;
  }
  return { ok: true, headers, linhas, processando, info: infoEl ? texto(infoEl).trim() : null, temProxima, dtTotal };
}

/** Clica em "próxima página" da tabela (o `.paginate_button.next` pode ser o `<a>` ou o `<li>` que o contém). */
export function clicarProximaPaginaDom(): void {
  // deno-lint-ignore no-explicit-any
  const g: any = globalThis;
  const document = g.document;
  // deno-lint-ignore no-explicit-any
  const b: any = document.querySelector(".paginate_button.next");
  const a = b && (b.tagName === "A" ? b : (b.querySelector("a") || b));
  if (a) a.click();
}

/** Clica em "Filtrar" da consulta. */
export function clicarFiltrarDom(): void {
  // deno-lint-ignore no-explicit-any
  const g: any = globalThis;
  const document = g.document;
  // deno-lint-ignore no-explicit-any
  const b: any = document.querySelector("#getFilterData");
  if (b) b.click();
}

/** As situações que o portal oferece no filtro (valor + texto). */
export function lerSituacoesDom(): Array<{ valor: string; texto: string }> {
  // deno-lint-ignore no-explicit-any
  const g: any = globalThis;
  const document = g.document;
  // deno-lint-ignore no-explicit-any
  return Array.from(document.querySelectorAll("#situacao option")).map((o: any) => ({
    valor: String(o.value),
    texto: (o.textContent || "").trim(),
  }));
}

export interface FiltroConsultaDom {
  set: Record<string, boolean>;
  cliente: string | null;
  exibir: string | null;
  situacao: string | null;
  emissao: string | null;
  emissaoFim: string | null;
  ini: string | null;
  fim: string | null;
}

/**
 * Aplica os filtros da consulta e devolve o que FICOU em cada campo (o chamador confere: cliente disponível, Exibir =
 * Pedido, número/emissão no filtro). Exibir = '1' (Pedido): proposta não é pedido efetivado e não pode virar PO.
 * Situação sempre 'todos' (o cancelado é LIDO e decidido em Deno). Entrega desde 2020 (o default é só o último mês).
 */
export function aplicarFiltrosConsultaDom(
  cod: string,
  nrIni: string,
  nrFim: string,
  emissaoDesde: string,
): FiltroConsultaDom {
  // deno-lint-ignore no-explicit-any
  const g: any = globalThis;
  const document = g.document;
  const w = g;
  const jq = w.jQuery;
  const set = (sel: string, v: string): boolean => {
    // deno-lint-ignore no-explicit-any
    const el: any = document.querySelector(sel);
    if (!el) return false;
    if (jq) jq(el).val(v).trigger("change");
    else {
      el.value = v;
      el.dispatchEvent(new w.Event("change", { bubbles: true }));
    }
    return true;
  };
  const r = {
    cliente: set("#cliente", String(cod)),
    situacao: set("#situacao", "todos"),
    exibir: set("#exibir", "1"),
    ini: set("#num_ped_ini", String(nrIni)),
    fim: set("#num_ped_fim", String(nrFim)),
    emissao: set("#data_emissao_ini", String(emissaoDesde)),
    entrega: set("#data_entrega_ini", "2020-01-01"),
  };
  const val = (sel: string): string | null => {
    // deno-lint-ignore no-explicit-any
    const el: any = document.querySelector(sel);
    return el ? String(el.value) : null;
  };
  return {
    set: r,
    cliente: val("#cliente"),
    exibir: val("#exibir"),
    situacao: val("#situacao"),
    emissao: val("#data_emissao_ini"),
    emissaoFim: val("#data_emissao_fim"),
    ini: val("#num_ped_ini"),
    fim: val("#num_ped_fim"),
  };
}

/**
 * Texto da condição de pagamento SELECIONADA na tela de detalhe (`#condicoes_pagamento`, ex. "70 - 7 DIAS").
 * `false` enquanto não há seleção legível (vazio ou "Selecione"): é o predicado do `waitForFunction`.
 */
export function lerCondicaoSelecionadaDom(): string | false {
  // deno-lint-ignore no-explicit-any
  const g: any = globalThis;
  const document = g.document;
  // deno-lint-ignore no-explicit-any
  const sel: any = document.querySelector("#condicoes_pagamento");
  const opt = sel && sel.selectedOptions && sel.selectedOptions[0];
  const txt = opt ? String(opt.text || "").trim() : "";
  return txt && txt.toLowerCase().indexOf("selecione") === -1 ? txt : false;
}

/** Todas as opções do `#condicoes_pagamento` (só leitura; insumo do de-para condição do portal → Omie). */
export function lerCondicoesOpcoesDom(): string[] {
  // deno-lint-ignore no-explicit-any
  const g: any = globalThis;
  const document = g.document;
  // deno-lint-ignore no-explicit-any
  const sel: any = document.querySelector("#condicoes_pagamento");
  // deno-lint-ignore no-explicit-any
  return sel ? Array.from(sel.options).map((o: any) => String(o.text || "").trim()).slice(0, 80) : [];
}

export type DesfechoPaginacao =
  | { ok: true; primeira: PaginaConsultaDom; linhas: LinhaConsultaDom[]; paginas: number }
  | {
    ok: false;
    erroTipo: "CONSULTA_ILEGIVEL" | "PAGINACAO_SEM_RESPOSTA" | "PAGINACAO_ILEGIVEL" | "PAGINACAO_INCOMPLETA";
    primeira: PaginaConsultaDom | null;
    linhas: LinhaConsultaDom[];
    paginas: number;
  };

/**
 * Lê a consulta INTEIRA, página por página. `ler()` devolve a página estável (ou `null` = não estabilizou: a página NÃO
 * foi lida e nunca vira "lista completa"); `avancar(n)` clica na próxima e espera a resposta do portal. Mais páginas
 * que o `teto` = lista incompleta (falha, nunca sucesso parcial).
 */
export async function lerTodasAsPaginas(
  ler: () => Promise<PaginaConsultaDom | null>,
  avancar: (numeroPagina: number) => Promise<{ ok: boolean }>,
  teto: number,
): Promise<DesfechoPaginacao> {
  const linhas: LinhaConsultaDom[] = [];
  let pagina = await ler();
  if (!pagina) return { ok: false, erroTipo: "CONSULTA_ILEGIVEL", primeira: null, linhas, paginas: 0 };
  const primeira = pagina;
  for (const l of pagina.linhas) linhas.push(l);
  let paginas = 1;
  while (pagina.temProxima && paginas < teto) {
    const r = await avancar(paginas + 1);
    if (!r || !r.ok) return { ok: false, erroTipo: "PAGINACAO_SEM_RESPOSTA", primeira, linhas, paginas };
    pagina = await ler();
    if (!pagina) return { ok: false, erroTipo: "PAGINACAO_ILEGIVEL", primeira, linhas, paginas };
    for (const l of pagina.linhas) linhas.push(l);
    paginas++;
  }
  if (pagina.temProxima) return { ok: false, erroTipo: "PAGINACAO_INCOMPLETA", primeira, linhas, paginas };
  return { ok: true, primeira, linhas, paginas };
}
