/* eslint-disable @typescript-eslint/no-explicit-any -- DOM da página do portal sem tipos (o Deno não tem lib DOM); o comportamento é provado contra HTML */
// C16 (plano v8): retrato da tela de detalhe do portal Sayerlack quando a condição de pagamento NÃO veio. Função de
// PÁGINA: vai ao Chrome pelo `.toString()` (sem crase, sem helper do módulo) — provada em `condicao-dom_test.ts` (texto
// serializado) e em `scripts/sayerlack-portal-dom.test.ts` (jsdom). Fica na importadora, fora do `_shared`, para não
// mudar a fonte da varredura (que não a usa).

/** Retrato limitado da tela quando a condição NÃO veio (C16): o que a evidência precisa para dizer o porquê. */
export type DiagnosticoCondicaoDom = {
  /** Caminho da página aberta, sem query nem hash; sequências longas de dígitos/hex mascaradas. */
  caminho: string;
  titulo: string;
  select_presente: boolean;
  select_n_opcoes: number | null;
  select_selecionada: string | null;
  select_desabilitado: boolean | null;
  /**
   * Todos os `<select>` da página (≤30): id, name e nº de opções. O texto selecionado só vem dos que falam de
   * condição/pagamento — select alheio (cliente, transportadora) pode carregar CPF/CNPJ (Codex C16, P1).
   */
  selects: { id: string; name: string; n: number; sel: string | null }[];
  /** Campos cujo id/name/rótulo fala de condição/pagamento/prazo (≤20). Oculto/senha: só metadado, valor nunca. */
  campos: { tag: string; id: string; name: string; tipo: string; valor: string | null; rotulo: string }[];
  /** Linhas de texto visível que falam de condição/pagamento + a linha seguinte (rótulo e valor em linhas separadas). */
  textos: string[];
  n_iframes: number;
  /** Quanto ficou de fora de cada lista (0 = nada cortado). */
  omitidos: { selects: number; campos: number; textos: number };
};

/**
 * Retrato da página para a evidência quando `lerCondicaoSelecionadaDom` não achou condição (C16, 2026-11-11: 13 de 13
 * leituras do detalhe vieram sem condição e sem opções, e a evidência não dizia o que a tela tinha). Só leitura.
 */
export function diagnosticarCondicaoDom(): DiagnosticoCondicaoDom {
  // deno-lint-ignore no-explicit-any
  const g: any = globalThis;
  const document = g.document;
  // Máscara de PII/segredo: CPF/CNPJ formatados, 8+ dígitos corridos e 24+ caracteres de token viram "#". Prazos como
  // "30/60/90 DD" ficam (são o dado que se busca).
  const mascara = (v: string) =>
    v.replace(/\d{2,3}\.\d{3}\.\d{3}[/-]\d{2,4}(-\d{2})?/g, "#").replace(/\d{8,}/g, "#").replace(/[A-Za-z0-9_-]{24,}/g, "#");
  const corta = (v: unknown, n: number) => mascara(String(v == null ? "" : v).replace(/\s+/g, " ").trim()).substring(0, n);
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
  // deno-lint-ignore no-explicit-any
  const falaDe = (el: any) => fala.test(String(el.id || "")) || fala.test(String(el.name || "")) || fala.test(rotuloDe(el));
  const campos = [];
  let camposOmitidos = 0;
  // deno-lint-ignore no-explicit-any
  const candidatos: any[] = Array.from(document.querySelectorAll("select, input, textarea, span[id], div[id]") || []);
  for (const el of candidatos) {
    if (!falaDe(el)) continue;
    if (campos.length >= 20) {
      camposOmitidos++;
      continue;
    }
    const tag = String(el.tagName || "").toLowerCase();
    const tipo = corta(el.type, 20).toLowerCase();
    const sigiloso = tipo === "hidden" || tipo === "password";
    campos.push({
      tag,
      id: corta(el.id, 60),
      name: corta(el.name, 60),
      tipo,
      valor: sigiloso ? null : tag === "select" ? textoSel(el) : corta(el.value != null ? el.value : el.innerText || el.textContent, 80),
      rotulo: rotuloDe(el),
    });
  }
  const textos = [];
  let textosOmitidos = 0;
  const linhas = String((document.body && (document.body.innerText || document.body.textContent)) || "")
    .split("\n").map((l) => l.trim()).filter((l) => l);
  for (let i = 0; i < linhas.length; i++) {
    if (!fala.test(linhas[i])) continue;
    if (textos.length >= 10) {
      textosOmitidos++;
      continue;
    }
    textos.push(corta(linhas[i] + (i + 1 < linhas.length ? " | " + linhas[i + 1] : ""), 160));
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
      sel: falaDe(s) ? textoSel(s) : null,
    })),
    campos,
    textos,
    n_iframes: (document.querySelectorAll("iframe") || []).length,
    omitidos: { selects: Math.max(0, todosSelects.length - 30), campos: camposOmitidos, textos: textosOmitidos },
  };
}
