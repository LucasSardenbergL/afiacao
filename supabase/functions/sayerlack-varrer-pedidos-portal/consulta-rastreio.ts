/* eslint-disable @typescript-eslint/no-explicit-any -- os pedidos são objetos do Puppeteer (HTTPRequest), sem tipos no Deno; só a IDENTIDADE deles é usada */
// Rastreio das consultas que a PÁGINA do portal faz (`POST /order-viewer/form/list`), visto pelo script do navegador.
//
// A página consulta por conta própria — ao abrir a tela, ao trocar um filtro — com o que estiver no formulário na hora.
// O script antigo tomava como resposta da NOSSA consulta a primeira que chegasse depois do clique em Filtrar; com uma
// consulta da página ainda em voo, o "0 de 0" dela virava a prova da leitura (6 das 20 rodadas das 22:30, out–nov/2026).
// Aqui cada resposta é presa ao PEDIDO que a gerou, e só vale a do 1º pedido feito DEPOIS do nosso clique.
//
// ⚠️ INTERPOLADA no script via `criarRastreioConsulta.toString()` (mesmo molde de `_shared/sayerlack-portal-dom.ts`):
// self-contained, sem crase e sem cifrão-chave no corpo. Testada em `consulta-rastreio_test.ts` e, dentro do script
// real, em `script-navegador_test.ts`.

/** O que a resposta de uma consulta disse (campos crus: quem valida é `provarLeitura`, em Deno). */
export interface DesfechoConsulta {
  /** HTTP < 400. */
  ok: boolean;
  status: number | null;
  /** `recordsFiltered` do corpo (o total FILTRADO que o portal anuncia). */
  total: unknown;
  chaves: string[] | null;
  /** Campo `success` do corpo, cru; `null` = o corpo não tem o campo. */
  sucesso: unknown;
  mensagem: string | null;
  /** Impressão do CONTEÚDO (lista + total): duas respostas com a mesma impressão desenham a mesma tabela. */
  assinatura: string | null;
  /** O texto do corpo, só carregado (quem chama mede se as linhas lidas da tabela aparecem nele). */
  corpo?: string | null;
}

/** Uma consulta da página: o pedido, o desfecho dele e os instantes (ms do relógio de quem chama). */
export interface ConsultaVista extends DesfechoConsulta {
  /** Nº de ordem do pedido (1 = a 1ª consulta que a página fez). */
  pedido: number;
  /** O pedido levava o NOSSO filtro? `false` = levava outro; `null` = não deu para ler o que ele levava. */
  filtro: boolean | null;
  pedidaEm: number;
  respondidaEm: number | null;
  /** O pedido morreu sem resposta (não desenha nada na tabela). */
  falhou: boolean;
}

export function criarRastreioConsulta() {
  // deno-lint-ignore no-explicit-any
  const ordem = new Map<any, number>();
  // deno-lint-ignore no-explicit-any
  const emVoo = new Set<any>();
  /** Nº de ordem do pedido → a consulta. */
  const vistas = new Map<number, ConsultaVista>();
  /** Nº de ordem dos pedidos na ordem em que o desfecho CHEGOU. */
  const chegadas: number[] = [];
  /** No nosso último clique: quantas consultas a página já tinha pedido e quantos desfechos já tinham chegado. */
  let corte = 0;
  let corteChegadas = 0;
  /** Todos os nossos cliques, em ordem: o corte de cada um e quando foi. */
  const cliques: { corte: number; em: number }[] = [];
  // deno-lint-ignore no-explicit-any
  const fechar = (pedido: any, d: DesfechoConsulta, agora: number, falhou: boolean): void => {
    const n = ordem.get(pedido);
    const vista = n === undefined ? undefined : vistas.get(n);
    // Pedido que não foi visto sair, ou que já teve desfecho, não conta.
    if (n === undefined || !vista || !emVoo.has(pedido)) return;
    emVoo.delete(pedido);
    vista.ok = d.ok;
    vista.status = d.status;
    vista.total = d.total;
    vista.chaves = d.chaves;
    vista.sucesso = d.sucesso;
    vista.mensagem = d.mensagem;
    vista.assinatura = d.assinatura;
    vista.corpo = d.corpo === undefined ? null : d.corpo;
    vista.respondidaEm = agora;
    vista.falhou = falhou;
    chegadas.push(n);
  };
  const doClique = (): ConsultaVista | null => {
    const v = vistas.get(corte + 1);
    return v && v.respondidaEm !== null ? v : null;
  };
  return {
    /** A página pediu uma consulta (evento request). filtro = o pedido levava o nosso filtro (false = outro; null = ilegível). */
    // deno-lint-ignore no-explicit-any
    pedida(pedido: any, filtro: boolean | null, agora: number): void {
      if (ordem.has(pedido)) return;
      const n = ordem.size + 1;
      ordem.set(pedido, n);
      emVoo.add(pedido);
      vistas.set(n, {
        pedido: n, filtro, pedidaEm: agora, respondidaEm: null, falhou: false,
        ok: false, status: null, total: null, chaves: null, sucesso: null, mensagem: null, assinatura: null, corpo: null,
      });
    },
    /** A resposta chegou e o corpo foi lido (evento response). */
    // deno-lint-ignore no-explicit-any
    respondida(pedido: any, d: DesfechoConsulta, agora: number): void {
      fechar(pedido, d, agora, false);
    },
    /** O pedido morreu sem resposta (evento requestfailed): é um desfecho, e não é resposta boa. */
    // deno-lint-ignore no-explicit-any
    falhou(pedido: any, agora: number): void {
      fechar(pedido, { ok: false, status: null, total: null, chaves: null, sucesso: null, mensagem: "pedido sem resposta", assinatura: null }, agora, true);
    },
    /** Consultas ainda sem desfecho: enquanto houver, a tabela ainda pode mudar. */
    emVoo(): number {
      return emVoo.size;
    },
    /** Marca o NOSSO clique: nada do que a página pediu até aqui é resposta dele. Devolve quantas eram. */
    clicar(agora: number): number {
      corte = ordem.size;
      corteChegadas = chegadas.length;
      cliques.push({ corte, em: agora });
      return corte;
    },
    /** Consultas que a página pediu depois do nosso último clique (1 = só a que o clique gerou). */
    depoisDoClique(): number {
      return ordem.size - corte;
    },
    /**
     * A consulta que o clique gerou: o PRIMEIRO pedido feito depois dele, já com desfecho. Resposta de pedido anterior
     * ao clique nunca vale por ele, chegue quando chegar; a de um pedido posterior ao primeiro também não (é outra
     * consulta da página). null = o clique ainda não tem desfecho.
     */
    respostaDoClique(): ConsultaVista | null {
      return doClique();
    },
    /** O pedido de nº n levava o NOSSO filtro? true = levava; false = levava outro; null = não deu para saber. */
    filtroDo(n: number): boolean | null {
      const v = vistas.get(n);
      return v ? v.filtro : null;
    },
    /**
     * Respostas que chegaram depois do nosso clique — de qualquer pedido, anterior ou posterior a ele — com conteúdo
     * DIFERENTE do da resposta do clique: a tabela pode estar mostrando uma delas. Pedido que morreu não desenha nada
     * e não conta. Só faz sentido com a resposta do clique já em mãos.
     */
    divergentes(): number {
      const nossa = doClique();
      if (!nossa) return 0;
      let n = 0;
      for (let i = corteChegadas; i < chegadas.length; i++) {
        const v = vistas.get(chegadas[i]);
        if (!v || v.falhou || v.pedido === nossa.pedido) continue;
        if (v.assinatura === null || v.assinatura !== nossa.assinatura) n++;
      }
      return n;
    },
    /**
     * As últimas consultas — vai ao registro da rodada (diagnóstico). Uma referência só para tudo: os instantes são
     * relativos ao nosso PRIMEIRO clique; clique = depois de qual clique nosso a consulta saiu (0 = antes de todos);
     * do_clique = é a consulta que aquele clique gerou (a 1ª depois dele).
     */
    linhaDoTempo(): Record<string, unknown>[] {
      const referencia = cliques.length > 0 ? cliques[0].em : 0;
      const todas: Record<string, unknown>[] = [];
      vistas.forEach((v) => {
        let clique = 0;
        for (let i = 0; i < cliques.length; i++) {
          if (v.pedido > cliques[i].corte) clique = i + 1;
        }
        todas.push({
          n: v.pedido, clique, do_clique: clique > 0 && v.pedido === cliques[clique - 1].corte + 1, filtro: v.filtro,
          pedida_ms: v.pedidaEm - referencia, respondida_ms: v.respondidaEm === null ? null : v.respondidaEm - referencia,
          status: v.status, total: v.total, sucesso: v.sucesso, falhou: v.falhou,
        });
      });
      return todas.slice(-8);
    },
  };
}

/** O filtro que o script deixa no formulário antes de clicar em Filtrar (os campos que distinguem a nossa consulta). */
export interface FiltroPedido {
  /** `data_emissao_ini`, em ISO. */
  emissao: string;
  /** `data_entrega_ini`, em ISO (o script põe 2020-01-01 — o formulário do portal nunca traz isso sozinho). */
  entrega: string;
  cliente: string;
  /** Valor de `exibir` ("1" = Pedido). */
  exibir: string;
}

/**
 * O pedido levava o NOSSO filtro? Decide pelos CAMPOS que o pedido mandou (corpo urlencoded ou JSON, e a query), nunca
 * por achar a data em qualquer lugar do texto, e nunca por um campo VIZINHO (Codex: a emissão pedida igual à ENTREGA
 * de outra consulta, ou ao FIM do intervalo dela, virava "sim"; `pedido_cliente` valia por `cliente`).
 *
 * Campos reconhecidos pelo nome: emissão INICIAL (nome com "emiss" e marca de início), entrega INICIAL (idem com
 * "entreg"), `cliente` e `exibir` (nome exato). Lê também as duas formas em que o nome não é a chave: a coluna do
 * DataTables (`columns[i][data]` + `columns[i][search][value]`) e o par `{ name, value }`.
 *
 *  - false: a emissão inicial (ou a entrega inicial) do pedido é outra DATA; ou o pedido não nomeia a emissão inicial,
 *           mostra datas e a nossa não está em lugar nenhum. É outra consulta. Só data decide o "não": cliente e
 *           exibir são valores soltos, e um campo de nome parecido derrubaria rodada boa.
 *  - true:  os QUATRO campos estão nomeados e todos batem.
 *  - null:  o resto — não dá para saber. O formato do POST do portal nunca foi observado; "não achei" não é "não levava".
 *
 * ⚠️ INTERPOLADA no script via toString(), como o rastreio: self-contained, sem crase e sem cifrão-chave no corpo.
 */
export function classificarFiltroDoPedido(url: string, corpo: unknown, nosso: FiltroPedido): boolean | null {
  const pares: { caminho: string; valor: string }[] = [];
  const guardar = (caminho: string, v: unknown): void => {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") pares.push({ caminho: caminho.toLowerCase(), valor: String(v).trim() });
  };
  const decodificar = (t: string): string => {
    try {
      return decodeURIComponent(t.split("+").join(" "));
    } catch (_e) {
      return t;
    }
  };
  const deQuery = (q: string): void => {
    q.split("&").forEach((par) => {
      const i = par.indexOf("=");
      if (i > 0) guardar(decodificar(par.substring(0, i)), decodificar(par.substring(i + 1)));
    });
  };
  // deno-lint-ignore no-explicit-any
  const deJson = (caminho: string, o: any, nivel: number): void => {
    if (nivel > 8) return;
    if (Array.isArray(o)) o.forEach((x, i) => deJson(caminho + "[" + i + "]", x, nivel + 1));
    else if (o && typeof o === "object") {
      // { name: CAMPO, value: V } (o serializeArray do jQuery): o campo é o name.
      if (typeof o.name === "string" && Object.prototype.hasOwnProperty.call(o, "value")) guardar(o.name, o.value);
      Object.keys(o).forEach((k) => deJson(caminho === "" ? k : caminho + "." + k, o[k], nivel + 1));
    } else guardar(caminho, o);
  };
  const interrogacao = url.indexOf("?");
  if (interrogacao >= 0) deQuery(url.substring(interrogacao + 1).split("#")[0]);
  if (typeof corpo === "string" && corpo.length > 0) {
    const t = corpo.trim();
    let json: unknown = undefined;
    if (t.charAt(0) === "{" || t.charAt(0) === "[") {
      try {
        json = JSON.parse(t);
      } catch (_e) {
        json = undefined;
      }
    }
    if (json !== undefined) deJson("", json, 0);
    else deQuery(t);
  }
  // Os trechos de um caminho: columns[0][search][value] e columns[0].search.value ⇒ columns · 0 · search · value.
  // (Sem expressão regular: em JS a classe "[]" é vazia, e o colchete de fechar exigiria barra invertida.)
  const trechosDe = (c: string): string[] => c.split("[").join(".").split("]").join(".").split(".").filter((x) => x !== "");
  // Coluna do DataTables: columns[i][data]=CAMPO + columns[i][search][value]=V ⇒ (CAMPO, V).
  const nomeDaColuna: Record<string, string> = {};
  pares.forEach((p) => {
    const t = trechosDe(p.caminho);
    if (t.length === 3 && t[0] === "columns" && (t[2] === "data" || t[2] === "name") && p.valor !== "" && nomeDaColuna[t[1]] === undefined) {
      nomeDaColuna[t[1]] = p.valor;
    }
  });
  pares.slice().forEach((p) => {
    const t = trechosDe(p.caminho);
    if (t.length === 4 && t[0] === "columns" && t[2] === "search" && t[3] === "value" && nomeDaColuna[t[1]] !== undefined) {
      guardar(nomeDaColuna[t[1]], p.valor);
    }
  });

  // A data de um valor, em ISO: 2026-11-05 · 2026-11-05T00:00:00 · 05/11/2026 · 05-11-2026 00:00. Outro ⇒ null.
  const iso = new RegExp("^([0-9]{4})-([0-9]{2})-([0-9]{2})([T ].*)?$");
  const br = new RegExp("^([0-9]{2})[/-]([0-9]{2})[/-]([0-9]{4})( .*)?$");
  const dataDe = (v: string): string | null => {
    const a = iso.exec(v);
    if (a) return a[1] + "-" + a[2] + "-" + a[3];
    const b = br.exec(v);
    return b ? b[3] + "-" + b[2] + "-" + b[1] : null;
  };
  // Campo vazio não filtra nada: não conta.
  const preenchidos = pares.filter((p) => p.valor !== "");
  const tem = (caminho: string, trecho: string): boolean => caminho.indexOf(trecho) !== -1;
  const ehInicio = (c: string): boolean => tem(c, "ini") || tem(c, "desde") || tem(c, "from") || tem(c, "start");
  // O nome do campo: o último trecho do caminho que não é só "value"/"valor" (filtro[cliente], cliente.value ⇒ cliente).
  const nomeDoCampo = (c: string): string => {
    const trechos = trechosDe(c).filter((x) => x !== "value" && x !== "valor");
    return trechos.length > 0 ? trechos[trechos.length - 1] : "";
  };
  const datasDe = (escolhe: (c: string) => boolean): string[] =>
    preenchidos.filter((p) => escolhe(p.caminho)).map((p) => dataDe(p.valor)).filter((d): d is string => d !== null);
  const valoresDe = (nome: string): string[] => preenchidos.filter((p) => nomeDoCampo(p.caminho) === nome).map((p) => p.valor);

  const emissaoInicial = datasDe((c) => tem(c, "emiss") && ehInicio(c));
  const entregaInicial = datasDe((c) => tem(c, "entreg") && ehInicio(c));
  if (emissaoInicial.length > 0) {
    if (emissaoInicial.indexOf(nosso.emissao) === -1) return false;
  } else {
    // O pedido não nomeia a emissão inicial. Só é "outra consulta" se mostra datas e a nossa não está em lugar nenhum.
    const todas = datasDe(() => true);
    if (todas.length > 0 && todas.indexOf(nosso.emissao) === -1) return false;
  }
  if (entregaInicial.length > 0 && entregaInicial.indexOf(nosso.entrega) === -1) return false;

  const todos = (lista: string[], esperado: string): boolean => lista.length > 0 && lista.every((v) => v === esperado);
  return todos(emissaoInicial, nosso.emissao) && todos(entregaInicial, nosso.entrega) &&
      todos(valoresDe("cliente"), nosso.cliente) && todos(valoresDe("exibir"), nosso.exibir)
    ? true
    : null;
}

/**
 * Medida (sem veto): quantas das linhas lidas na tabela têm o seu nº de pedido no texto das respostas do clique. Só a
 * coluna "Pedido" (nome exato — "Pedido Cliente" é outro número), e o número INTEIRO: achá-lo dentro de outro maior
 * não conta. Se o portal manda o nº do pedido no JSON (nunca observado), isto prova que a tabela lida É a da resposta.
 *
 * ⚠️ INTERPOLADA no script via toString(): self-contained, sem crase e sem cifrão-chave no corpo.
 */
export function contarLinhasNaResposta(linhas: Record<string, string>[], texto: string): number {
  const ehNumero = new RegExp("^[0-9]{3,12}$");
  const digito = new RegExp("[0-9]");
  let n = 0;
  linhas.forEach((l) => {
    const coluna = Object.keys(l).filter((c) => c.trim().toLowerCase() === "pedido")[0];
    const numero = coluna === undefined ? "" : String(l[coluna]).trim();
    if (!ehNumero.test(numero)) return;
    let de = 0;
    let achou = false;
    while (!achou) {
      const i = texto.indexOf(numero, de);
      if (i === -1) break;
      achou = !digito.test(i === 0 ? "" : texto.charAt(i - 1)) && !digito.test(texto.charAt(i + numero.length));
      de = i + 1;
    }
    if (achou) n++;
  });
  return n;
}
