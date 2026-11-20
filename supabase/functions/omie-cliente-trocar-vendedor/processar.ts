// Fluxo de UM bloco da troca de vendedor, com rede e banco INJETADOS (o index.ts liga os reais; o teste, os falsos).
//
// Por cliente, no modo aplicar:
//   1. ConsultarCliente → vendedor ATUAL no Omie (o espelho só escolhe os candidatos, nunca decide).
//   2. decidir(): já certo → pula; vendedor inesperado → não toca.
//   3. recibo 'indeterminado' ANTES de escrever (se a edge morrer no meio, o recibo diz "não sei", nunca some).
//   4. AlterarCliente com o `recomendacoes` inteiro, só o vendedor trocado.
//   5. Releitura por ListarClientes (OUTRA chamada: o Omie recusa repetir o ConsultarCliente em <60s) → 'alterado'
//      e o espelho `omie_customer_account_map` recebe o vendedor novo (sem isso o carteira-rebuild só veria a troca
//      quando o import semanal revisitasse o cliente, >7 dias depois).
//   6. Depois de ≥61s do ConsultarCliente, um 2º ConsultarCliente → hash do cadastro sem vendedor/info igual ao de
//      antes → 'verificado'. Hash diferente ou releitura sem o alvo → 'divergente' e o bloco PARA.
// O que não couber no tempo fica 'alterado' e o modo verificar termina depois.

import {
  type Conta,
  conferirAlvo,
  decidir,
  type Dono,
  ESPERA_REDUNDANCIA_MS,
  hashCadastro,
  type Lote,
  NOME_ESPERADO,
  type Parametros,
  payloadAlterar,
  VENDEDOR,
  vendedorDoCadastro,
} from "./decisao.ts";

export type StatusRecibo =
  | "planejado" | "ja_certo" | "precondicao_falhou" | "alterado" | "verificado" | "divergente" | "indeterminado" | "erro_omie";

export interface Candidato {
  omie_codigo_cliente: number;
  customer_user_id: string | null;
  dono: Dono;
}

export interface Recibo {
  execucao_id: string;
  lote: Lote;
  modo: "dry_run" | "aplicar";
  account: Conta;
  omie_codigo_cliente: number;
  customer_user_id: string | null;
  vendedor_antes: number | null;
  vendedor_alvo: number;
  vendedor_depois?: number | null;
  status: StatusRecibo;
  hash_antes?: string | null;
  hash_depois?: string | null;
  espelho_ok?: boolean | null;
  erro?: string | null;
  executado_por: string;
}

/** Resposta de uma chamada Omie já interpretada pelo adaptador. `indeterminada` = escrita sem desfecho conhecido. */
export interface RespostaOmieSimples {
  corpo: Record<string, unknown> | null;
  fault: string | null;
}

export interface Dependencias {
  consultarCliente(codigo: number): Promise<RespostaOmieSimples>;
  /** ListarClientes filtrado pelo código: a releitura que não colide com o REDUNDANT do ConsultarCliente. */
  relerCliente(codigo: number): Promise<RespostaOmieSimples>;
  /** Lança `OmieEscritaIndeterminada` (ver `ehIndeterminada`) quando o desfecho é desconhecido. */
  alterarCliente(payload: Record<string, unknown>): Promise<RespostaOmieSimples>;
  listarVendedores(): Promise<{ vendedores: { codigo?: unknown; nome?: unknown; inativo?: unknown }[] } | { erro: string }>;
  ehIndeterminada(e: unknown): boolean;
  candidatos(p: Parametros): Promise<Candidato[]>;
  /** Grava o recibo e devolve o id. */
  registrar(r: Recibo): Promise<number>;
  atualizar(id: number, patch: Partial<Recibo>): Promise<void>;
  /** UPDATE estreito do vendedor no espelho; true = 1 linha atualizada. */
  atualizarEspelho(conta: Conta, codigo: number, userId: string | null, alvo: number): Promise<boolean>;
  pendentesVerificacao(execucaoId: string, conta: Conta): Promise<{ id: number; omie_codigo_cliente: number; hash_antes: string | null; vendedor_alvo: number }[]>;
  agora(): number;
  dormir(ms: number): Promise<void>;
  novoId(): string;
}

export interface ItemResultado {
  omie_codigo_cliente: number;
  customer_user_id: string | null;
  nome_fantasia: string | null;
  vendedor_antes: number | null;
  vendedor_alvo: number;
  vendedor_depois: number | null;
  status: StatusRecibo;
  erro: string | null;
}

export interface ResultadoBloco {
  execucao_id: string;
  modo: Parametros["modo"];
  lote: Lote;
  conta: Conta;
  itens: ItemResultado[];
  contagem: Partial<Record<StatusRecibo, number>>;
  /** Passe como `apos` na próxima chamada. null = nenhum candidato processado. */
  proximo_apos: number | null;
  /** true = não sobrou candidato depois deste bloco (para o laço do driver). */
  fim: boolean;
  /** Motivo de o bloco ter parado ANTES do fim dos candidatos (divergência, indeterminação, tempo). */
  parou: string | null;
}

export interface OpcoesBloco {
  executadoPor: string;
  /** A partir daqui não começa cliente novo (ms desde o início). */
  orcamentoEscritaMs: number;
  /** A partir daqui não começa verificação nova; o resto fica para o modo verificar. */
  orcamentoTotalMs: number;
}

const texto = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function cadastroDe(r: RespostaOmieSimples): Record<string, unknown> | null {
  return r.fault === null && r.corpo && typeof r.corpo.codigo_cliente_omie === "number" ? r.corpo : null;
}

function cadastroRelido(r: RespostaOmieSimples, codigo: number): Record<string, unknown> | null {
  if (r.fault !== null || !r.corpo) return null;
  const lista = r.corpo.clientes_cadastro;
  if (!Array.isArray(lista)) return null;
  const achados = lista.filter((c) => c && typeof c === "object" && (c as Record<string, unknown>).codigo_cliente_omie === codigo);
  return achados.length === 1 ? achados[0] as Record<string, unknown> : null;
}

export async function processarBloco(p: Parametros, d: Dependencias, o: OpcoesBloco): Promise<ResultadoBloco> {
  const inicio = d.agora();
  const decorrido = () => d.agora() - inicio;
  const execucao_id = d.novoId();
  const itens: ItemResultado[] = [];
  const res: ResultadoBloco = {
    execucao_id, modo: p.modo, lote: p.lote, conta: p.conta, itens, contagem: {}, proximo_apos: null, fim: false, parou: null,
  };
  const contar = (s: StatusRecibo, delta = 1) => { res.contagem[s] = (res.contagem[s] ?? 0) + delta; };

  if (p.modo === "verificar") return await verificar(p, d, o, res);

  // O alvo tem de existir, estar ativo e ter o nome esperado NA CONTA — antes de tocar qualquer cliente.
  const donos = new Set<Dono>(p.lote === "saida_vendedora" ? ["REGINA"] : (p.escolhas ?? []).map((e) => e.dono));
  const vend = await d.listarVendedores();
  if ("erro" in vend) { res.parou = `ListarVendedores falhou: ${vend.erro}`; return res; }
  for (const dono of donos) {
    const c = conferirAlvo(vend.vendedores, VENDEDOR[dono][p.conta], NOME_ESPERADO[dono]);
    if (!c.ok) { res.parou = `alvo ${dono}/${p.conta}: ${c.erro}`; return res; }
  }

  const candidatos = await d.candidatos(p);
  const aVerificar: { id: number; item: ItemResultado; hashAntes: string; lidoEm: number }[] = [];
  let processados = 0;

  for (const cand of candidatos) {
    if (decorrido() > o.orcamentoEscritaMs) { res.parou = "orçamento de tempo do bloco"; break; }
    const alvo = VENDEDOR[cand.dono][p.conta];
    const item: ItemResultado = {
      omie_codigo_cliente: cand.omie_codigo_cliente, customer_user_id: cand.customer_user_id, nome_fantasia: null,
      vendedor_antes: null, vendedor_alvo: alvo, vendedor_depois: null, status: "erro_omie", erro: null,
    };
    const base: Omit<Recibo, "status"> = {
      execucao_id, lote: p.lote, modo: p.modo === "aplicar" ? "aplicar" : "dry_run", account: p.conta,
      omie_codigo_cliente: cand.omie_codigo_cliente, customer_user_id: cand.customer_user_id,
      vendedor_antes: null, vendedor_alvo: alvo, executado_por: o.executadoPor,
    };
    itens.push(item);
    processados++;
    res.proximo_apos = cand.omie_codigo_cliente;

    const lidoEm = d.agora();
    const r1 = await d.consultarCliente(cand.omie_codigo_cliente);
    const cad = cadastroDe(r1);
    if (!cad) {
      item.erro = r1.fault ?? "ConsultarCliente sem cadastro legível";
      await d.registrar({ ...base, status: "erro_omie", erro: item.erro });
      contar("erro_omie");
      continue;
    }
    item.nome_fantasia = texto(cad.nome_fantasia);
    const atual = vendedorDoCadastro(cad);
    item.vendedor_antes = atual;
    base.vendedor_antes = atual;
    const hashAntes = await hashCadastro(cad);
    const v = decidir(p.lote, p.conta, atual, alvo);

    if (v.tipo === "ja_certo") {
      item.status = "ja_certo";
      item.vendedor_depois = atual;
      const espelho = p.modo === "aplicar" ? await d.atualizarEspelho(p.conta, cand.omie_codigo_cliente, cand.customer_user_id, alvo) : null;
      await d.registrar({ ...base, status: "ja_certo", hash_antes: hashAntes, espelho_ok: espelho });
      contar("ja_certo");
      continue;
    }
    if (v.tipo === "precondicao_falhou") {
      item.status = "precondicao_falhou";
      item.erro = v.motivo;
      await d.registrar({ ...base, status: "precondicao_falhou", hash_antes: hashAntes, erro: v.motivo });
      contar("precondicao_falhou");
      continue;
    }
    if (p.modo === "dry_run") {
      item.status = "planejado";
      await d.registrar({ ...base, status: "planejado", hash_antes: hashAntes });
      contar("planejado");
      continue;
    }

    // aplicar — o recibo nasce 'indeterminado' e só sai disso com prova.
    const id = await d.registrar({ ...base, status: "indeterminado", hash_antes: hashAntes });
    let r2: RespostaOmieSimples;
    try {
      r2 = await d.alterarCliente(payloadAlterar(cad, alvo));
    } catch (e) {
      if (!d.ehIndeterminada(e)) throw e;
      item.status = "indeterminado";
      item.erro = "AlterarCliente sem desfecho conhecido";
      await d.atualizar(id, { erro: item.erro });
      contar("indeterminado");
      res.parou = `escrita indeterminada no cliente ${cand.omie_codigo_cliente}`;
      break;
    }
    if (r2.fault !== null) {
      item.status = "erro_omie";
      item.erro = r2.fault;
      await d.atualizar(id, { status: "erro_omie", erro: r2.fault });
      contar("erro_omie");
      continue;
    }
    const relido = cadastroRelido(await d.relerCliente(cand.omie_codigo_cliente), cand.omie_codigo_cliente);
    const depois = relido ? vendedorDoCadastro(relido) : null;
    item.vendedor_depois = depois;
    if (depois !== alvo) {
      item.status = "divergente";
      item.erro = relido ? `releitura mostra vendedor ${depois ?? "vazio"}` : "releitura sem o cliente";
      await d.atualizar(id, { status: "divergente", vendedor_depois: depois, erro: item.erro });
      contar("divergente");
      res.parou = `divergência no cliente ${cand.omie_codigo_cliente}`;
      break;
    }
    const espelho = await d.atualizarEspelho(p.conta, cand.omie_codigo_cliente, cand.customer_user_id, alvo);
    item.status = "alterado";
    await d.atualizar(id, { status: "alterado", vendedor_depois: depois, espelho_ok: espelho });
    contar("alterado");
    aVerificar.push({ id, item, hashAntes, lidoEm });
  }
  res.fim = res.parou === null && processados === candidatos.length && candidatos.length < p.limite;

  // Prova de que a escrita não mexeu em mais nada: 2º ConsultarCliente ≥61s depois do 1º, hash igual.
  for (const x of aVerificar) {
    if (res.parou && res.parou.startsWith("divergência")) break;
    const espera = x.lidoEm + ESPERA_REDUNDANCIA_MS - d.agora();
    if (decorrido() + Math.max(0, espera) > o.orcamentoTotalMs) break; // fica 'alterado' → modo verificar
    if (espera > 0) await d.dormir(espera);
    const cad = cadastroDe(await d.consultarCliente(x.item.omie_codigo_cliente));
    if (!cad) continue; // sem leitura não há prova: segue 'alterado'
    const hashDepois = await hashCadastro(cad);
    if (hashDepois === x.hashAntes && vendedorDoCadastro(cad) === x.item.vendedor_alvo) {
      x.item.status = "verificado";
      await d.atualizar(x.id, { status: "verificado", hash_depois: hashDepois });
      contar("alterado", -1);
      contar("verificado");
    } else {
      x.item.status = "divergente";
      x.item.erro = "o cadastro mudou além do vendedor";
      await d.atualizar(x.id, { status: "divergente", hash_depois: hashDepois, erro: x.item.erro });
      contar("alterado", -1);
      contar("divergente");
      res.parou = `divergência no cliente ${x.item.omie_codigo_cliente}`;
      res.fim = false;
    }
  }
  return res;
}

async function verificar(p: Parametros, d: Dependencias, o: OpcoesBloco, res: ResultadoBloco): Promise<ResultadoBloco> {
  const inicio = d.agora();
  const pend = await d.pendentesVerificacao(p.execucao_id!, p.conta);
  for (const x of pend.slice(0, p.limite)) {
    if (d.agora() - inicio > o.orcamentoTotalMs) { res.parou = "orçamento de tempo do bloco"; break; }
    const item: ItemResultado = {
      omie_codigo_cliente: x.omie_codigo_cliente, customer_user_id: null, nome_fantasia: null, vendedor_antes: null,
      vendedor_alvo: x.vendedor_alvo, vendedor_depois: null, status: "alterado", erro: null,
    };
    res.itens.push(item);
    const cad = cadastroDe(await d.consultarCliente(x.omie_codigo_cliente));
    if (!cad) { item.erro = "ConsultarCliente sem cadastro legível"; continue; }
    const h = await hashCadastro(cad);
    item.vendedor_depois = vendedorDoCadastro(cad);
    const ok = x.hash_antes !== null && h === x.hash_antes && item.vendedor_depois === x.vendedor_alvo;
    item.status = ok ? "verificado" : "divergente";
    if (!ok) item.erro = "o cadastro mudou além do vendedor";
    await d.atualizar(x.id, { status: item.status, hash_depois: h, vendedor_depois: item.vendedor_depois, erro: item.erro });
    res.contagem[item.status] = (res.contagem[item.status] ?? 0) + 1;
  }
  res.fim = res.parou === null && pend.length <= p.limite;
  return res;
}
