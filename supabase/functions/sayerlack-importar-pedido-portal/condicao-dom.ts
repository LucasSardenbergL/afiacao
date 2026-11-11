// C16 (plano v8): retrato da tela de detalhe do portal Sayerlack quando a condição de pagamento NÃO veio. Função de
// PÁGINA: vai ao Chrome pelo `.toString()` (sem crase, sem helper do módulo) — provada em `condicao-dom_test.ts` (texto
// serializado) e em `scripts/sayerlack-portal-dom.test.ts` (jsdom). Fica na importadora, fora do `_shared`, para não
// mudar a fonte da varredura (que não a usa).

/** Retrato limitado da tela quando a condição NÃO veio (C16): o que a evidência precisa para dizer o porquê. */
export type DiagnosticoCondicaoDom = {
  /** Caminho da página aberta, sem query nem hash. */
  caminho: string;
  titulo: string;
  select_presente: boolean;
  select_n_opcoes: number | null;
  select_selecionada: string | null;
  select_desabilitado: boolean | null;
  /** Todos os `<select>` da página (≤30): id, name, nº de opções e texto selecionado. */
  selects: { id: string; name: string; n: number; sel: string }[];
  /** Campos cujo id/name/rótulo fala de condição/pagamento/prazo (≤20). */
  campos: { tag: string; id: string; name: string; tipo: string; valor: string; rotulo: string }[];
  /** Linhas de texto visível que falam de condição/pagamento (≤10 × 120 caracteres). */
  textos: string[];
};

/**
 * Retrato da página para a evidência quando `lerCondicaoSelecionadaDom` não achou condição (C16, 2026-11-11: 13 de 13
 * leituras do detalhe vieram sem condição e sem opções, e a evidência não dizia o que a tela tinha). Só leitura.
 */
export function diagnosticarCondicaoDom(): DiagnosticoCondicaoDom {
  // deno-lint-ignore no-explicit-any
  const g: any = globalThis;
  const document = g.document;
  const corta = (v: unknown, n: number) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().substring(0, n);
  const fala = /condi[cç]|pagamento|pagto|prazo/i;
  const loc = g.location;
  // deno-lint-ignore no-explicit-any
  const sel: any = document.querySelector("#condicoes_pagamento");
  // deno-lint-ignore no-explicit-any
  const textoSel = (s: any) => {
    const o = s && s.selectedOptions && s.selectedOptions[0];
    return o ? corta(o.text, 80) : "";
  };
  // deno-lint-ignore no-explicit-any
  const todosSelects: any[] = Array.from(document.querySelectorAll("select") || []);
  // deno-lint-ignore no-explicit-any
  const rotuloDe = (el: any) => {
    const id = el.id ? String(el.id) : "";
    // deno-lint-ignore no-explicit-any
    const lab: any = id ? document.querySelector('label[for="' + id.replace(/"/g, "") + '"]') : null;
    return corta(lab ? lab.innerText || lab.textContent : "", 60);
  };
  const campos = [];
  // deno-lint-ignore no-explicit-any
  const candidatos: any[] = Array.from(document.querySelectorAll("select, input, textarea, span[id], div[id]") || []);
  for (const el of candidatos) {
    if (campos.length >= 20) break;
    const rotulo = rotuloDe(el);
    if (!fala.test(String(el.id || "")) && !fala.test(String(el.name || "")) && !fala.test(rotulo)) continue;
    const tag = String(el.tagName || "").toLowerCase();
    campos.push({
      tag,
      id: corta(el.id, 60),
      name: corta(el.name, 60),
      tipo: corta(el.type, 20),
      valor: tag === "select" ? textoSel(el) : corta(el.value != null ? el.value : el.innerText || el.textContent, 80),
      rotulo,
    });
  }
  const textos = [];
  const linhas = String((document.body && (document.body.innerText || document.body.textContent)) || "").split("\n");
  for (const l of linhas) {
    if (textos.length >= 10) break;
    if (fala.test(l) && l.trim()) textos.push(corta(l, 120));
  }
  return {
    caminho: corta(loc ? loc.pathname : "", 200),
    titulo: corta(document.title, 120),
    select_presente: !!sel,
    select_n_opcoes: sel && sel.options ? sel.options.length : null,
    select_selecionada: sel ? textoSel(sel) : null,
    select_desabilitado: sel ? !!sel.disabled : null,
    selects: todosSelects.slice(0, 30).map((s) => ({
      id: corta(s.id, 60),
      name: corta(s.name, 60),
      n: s.options ? s.options.length : 0,
      sel: textoSel(s),
    })),
    campos,
    textos,
  };
}
