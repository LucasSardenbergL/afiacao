// Fluxo de UM bloco da troca de vendedor, com rede e banco INJETADOS (o index.ts liga os reais; o teste, os falsos).
//
// Por cliente, no modo aplicar:
//   1. ConsultarCliente → vendedor ATUAL no Omie (o espelho só escolhe os candidatos, nunca decide). A resposta tem
//      de ser DO cliente pedido (mesmo codigo_cliente_omie), senão nada é escrito.
//   2. decidir(): já certo → pula; vendedor inesperado ou ilegível → não toca.
//   3. recibo 'indeterminado' ANTES de escrever (se a edge morrer no meio, o recibo diz "não sei", nunca some), com
//      o `recomendacoes` de antes (permite desfazer).
//   4. AlterarCliente com o `recomendacoes` inteiro, só o vendedor trocado.
//   5. Releitura por ListarClientes (OUTRA chamada: o Omie recusa repetir o ConsultarCliente em <60s) — SEMPRE, mesmo
//      depois de fault, porque um retry que volta REDUNDANT pode esconder uma escrita feita. Alvo na releitura →
//      'alterado' e o vendedor novo no espelho `omie_customer_account_map`; vendedor de antes + fault → 'erro_omie'.
//   6. Depois de ≥61s do ConsultarCliente, um 2º ConsultarCliente → hash do cadastro sem vendedor/info igual ao de
//      antes → 'verificado'. Hash diferente ou releitura sem o alvo → 'divergente' e o bloco PARA.
// O que não couber no tempo fica 'alterado'/'indeterminado' e o modo verificar termina depois.
//
// Risco residual aceito (Codex P1, registrado no PR): se um operador editar o MESMO cadastro no ~1s entre o
// ConsultarCliente e o AlterarCliente, o `recomendacoes` reenviado sobrescreve essa edição. O recibo guarda o
// `recomendacoes` de antes, então dá para conferir e desfazer.

import {
  type Conta,
  conferirAlvo,
  decidir,
  type Dono,
  ESPERA_REDUNDANCIA_MS,
  hashCadastro,
  lerVendedor,
  type Lote,
  NOME_ESPERADO,
  type Parametros,
  blocosPreenchidos,
  camposDiferentes,
  enderecoFaltando,
  payloadAlterar,
  recomendacoesDe,
  VENDEDOR,
  vendedorDoCadastro,
} from "./decisao.ts";
import { mensagemDeErro } from "../_shared/erro-mensagem.ts";

type StatusRecibo =
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
  recomendacoes_antes?: Record<string, unknown> | null;
  hash_antes?: string | null;
  hash_depois?: string | null;
  espelho_ok?: boolean | null;
  erro?: string | null;
  executado_por: string;
}

export interface RespostaOmieSimples {
  corpo: Record<string, unknown> | null;
  fault: string | null;
}

interface Pendente {
  id: number;
  omie_codigo_cliente: number;
  customer_user_id: string | null;
  status: "alterado" | "indeterminado";
  vendedor_antes: number | null;
  vendedor_alvo: number;
  hash_antes: string | null;
  /** ms epoch de quando o recibo nasceu (logo depois do 1º ConsultarCliente). */
  criado_em_ms: number;
}

export interface Dependencias {
  consultarCliente(codigo: number): Promise<RespostaOmieSimples>;
  /** ListarClientes filtrado pelo código: a releitura que não colide com o REDUNDANT do ConsultarCliente. */
  relerCliente(codigo: number): Promise<RespostaOmieSimples>;
  /** Lança uma exceção que `ehIndeterminada` reconhece quando o desfecho é desconhecido. */
  alterarCliente(payload: Record<string, unknown>): Promise<RespostaOmieSimples>;
  listarVendedores(): Promise<{ vendedores: { codigo?: unknown; nome?: unknown; inativo?: unknown }[] } | { erro: string }>;
  ehIndeterminada(e: unknown): boolean;
  candidatos(p: Parametros): Promise<Candidato[]>;
  registrar(r: Recibo): Promise<number>;
  atualizar(id: number, patch: Partial<Recibo>): Promise<void>;
  /** UPDATE estreito do vendedor no espelho; true = exatamente 1 linha atualizada. */
  atualizarEspelho(conta: Conta, codigo: number, userId: string | null, alvo: number): Promise<boolean>;
  /** Lote orfaos: o vínculo (conta, código) → user ainda está no espelho FRESCO? Conferido logo antes de escrever. */
  confirmarVinculo(conta: Conta, codigo: number, userId: string): Promise<boolean>;
  /** TODOS os recibos 'alterado'/'indeterminado' da execução na conta (sem filtro de idade), o menos tocado primeiro. */
  pendentesVerificacao(execucaoId: string, conta: Conta): Promise<Pendente[]>;
  agora(): number;
  dormir(ms: number): Promise<void>;
  novoId(): string;
}

interface ItemResultado {
  omie_codigo_cliente: number;
  customer_user_id: string | null;
  nome_fantasia: string | null;
  vendedor_antes: number | null;
  vendedor_alvo: number;
  vendedor_depois: number | null;
  status: StatusRecibo;
  espelho_ok: boolean | null;
  erro: string | null;
  /** Listas/objetos PREENCHIDOS no cadastro lido (não vão no payload) — para escolher o canário que prova a preservação. */
  blocos?: string[];
}

export interface ResultadoBloco {
  execucao_id: string;
  modo: Parametros["modo"];
  lote: Lote;
  conta: Conta;
  itens: ItemResultado[];
  contagem: Partial<Record<StatusRecibo, number>>;
  /** Passe como `apos` na próxima chamada. O cursor PASSA por cima de falhas: elas ficam no recibo e numa nova
   *  rodada a partir de apos=0 (idempotente: quem já trocou sai do conjunto de origem). */
  proximo_apos: number | null;
  /** true = o cursor chegou ao fim dos candidatos (verificar: não sobrou pendente). Falhas não impedem o fim. */
  fim: boolean;
  /** Clientes deste bloco que pedem nova rodada ou conferência: erro_omie + indeterminado + alterado sem prova. */
  pendentes: number;
  /** Motivo de o bloco ter parado ANTES do fim (divergência, indeterminação, espelho, tempo, alvo). */
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

/** O cadastro do ConsultarCliente — só se for DO cliente pedido (Codex P1: resposta de outro código não autoriza nada). */
function cadastroDe(r: RespostaOmieSimples, codigo: number): Record<string, unknown> | null {
  return r.fault === null && r.corpo && r.corpo.codigo_cliente_omie === codigo ? r.corpo : null;
}

function cadastroRelido(r: RespostaOmieSimples, codigo: number): Record<string, unknown> | null {
  if (r.fault !== null || !r.corpo) return null;
  const lista = r.corpo.clientes_cadastro;
  if (!Array.isArray(lista)) return null;
  const achados = lista.filter((c) => c && typeof c === "object" && (c as Record<string, unknown>).codigo_cliente_omie === codigo);
  return achados.length === 1 ? achados[0] as Record<string, unknown> : null;
}

function contar(res: ResultadoBloco, s: StatusRecibo, delta = 1) {
  res.contagem[s] = (res.contagem[s] ?? 0) + delta;
}

function fecharPendentes(res: ResultadoBloco) {
  res.pendentes = res.itens.filter((i) => i.status === "erro_omie" || i.status === "indeterminado" || i.status === "alterado").length;
}

export async function processarBloco(p: Parametros, d: Dependencias, o: OpcoesBloco): Promise<ResultadoBloco> {
  const execucao_id = p.modo === "verificar" ? p.execucao_id! : d.novoId();
  const res: ResultadoBloco = {
    execucao_id, modo: p.modo, lote: p.lote, conta: p.conta, itens: [], contagem: {}, proximo_apos: null, fim: false, pendentes: 0, parou: null,
  };
  // Exceção no meio (banco, leitura) NÃO perde o execucao_id nem os itens já feitos (Codex r2 P1): o operador precisa
  // deles para o modo verificar.
  try {
    await bloco(p, d, o, res);
  } catch (e) {
    res.fim = false;
    res.parou = `exceção: ${mensagemDeErro(e) ?? "erro sem mensagem"}`;
  }
  fecharPendentes(res);
  return res;
}

async function bloco(p: Parametros, d: Dependencias, o: OpcoesBloco, res: ResultadoBloco): Promise<void> {
  const inicio = d.agora();
  const decorrido = () => d.agora() - inicio;
  const execucao_id = res.execucao_id;
  const itens = res.itens;

  if (p.modo === "verificar") return await verificar(p, d, o, res);

  // O alvo tem de existir, estar ativo e ter o nome esperado NA CONTA — antes de tocar qualquer cliente.
  const donos = new Set<Dono>(p.lote === "saida_vendedora" ? ["REGINA"] : (p.escolhas ?? []).map((e) => e.dono));
  const vend = await d.listarVendedores();
  if ("erro" in vend) { res.parou = `ListarVendedores falhou: ${vend.erro}`; return; }
  for (const dono of donos) {
    const c = conferirAlvo(vend.vendedores, VENDEDOR[dono][p.conta], NOME_ESPERADO[dono]);
    if (!c.ok) { res.parou = `alvo ${dono}/${p.conta}: ${c.erro}`; return; }
  }

  const candidatos = await d.candidatos(p);
  // `esperado`: o vendedor que a prova tem de achar — o alvo (escrita feita) ou o de antes (fault, nada gravado).
  const aVerificar: { id: number; item: ItemResultado; hashAntes: string; cadAntes: Record<string, unknown>; lidoEm: number; esperado: number | null; seConfirmar: StatusRecibo }[] = [];
  let processados = 0;

  for (const cand of candidatos) {
    if (decorrido() > o.orcamentoEscritaMs) { res.parou = "orçamento de tempo do bloco"; break; }
    const alvo = VENDEDOR[cand.dono][p.conta];
    const item: ItemResultado = {
      omie_codigo_cliente: cand.omie_codigo_cliente, customer_user_id: cand.customer_user_id, nome_fantasia: null,
      vendedor_antes: null, vendedor_alvo: alvo, vendedor_depois: null, status: "erro_omie", espelho_ok: null, erro: null,
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
    const cad = cadastroDe(r1, cand.omie_codigo_cliente);
    if (!cad) {
      item.erro = r1.fault ?? "ConsultarCliente sem o cadastro deste cliente";
      await d.registrar({ ...base, status: "erro_omie", erro: item.erro });
      contar(res, "erro_omie");
      continue;
    }
    item.nome_fantasia = texto(cad.nome_fantasia);
    item.blocos = blocosPreenchidos(cad);
    const leitura = lerVendedor(cad);
    const atual = leitura === "ilegivel" ? null : leitura;
    item.vendedor_antes = atual;
    base.vendedor_antes = atual;
    base.recomendacoes_antes = recomendacoesDe(cad);
    const hashAntes = await hashCadastro(cad);
    const v = decidir(p.lote, p.conta, leitura, alvo);

    if (v.tipo === "ja_certo") {
      item.status = "ja_certo";
      item.vendedor_depois = atual;
      if (p.modo === "aplicar") item.espelho_ok = await d.atualizarEspelho(p.conta, cand.omie_codigo_cliente, cand.customer_user_id, alvo);
      await d.registrar({ ...base, status: "ja_certo", hash_antes: hashAntes, espelho_ok: item.espelho_ok });
      contar(res, "ja_certo");
      if (item.espelho_ok === false) { res.parou = `espelho não atualizou no cliente ${cand.omie_codigo_cliente}`; break; }
      continue;
    }
    if (v.tipo === "precondicao_falhou") {
      item.status = "precondicao_falhou";
      item.erro = v.motivo;
      await d.registrar({ ...base, status: "precondicao_falhou", hash_antes: hashAntes, erro: v.motivo });
      contar(res, "precondicao_falhou");
      continue;
    }
    const payload = payloadAlterar(cad, alvo);
    if (!payload) {
      item.status = "precondicao_falhou";
      item.erro = `endereço incompleto no Omie (o AlterarCliente exige): falta ${enderecoFaltando(cad).join(", ")}`;
      await d.registrar({ ...base, status: "precondicao_falhou", hash_antes: hashAntes, erro: item.erro });
      contar(res, "precondicao_falhou");
      continue;
    }
    if (p.modo === "dry_run") {
      item.status = "planejado";
      await d.registrar({ ...base, status: "planejado", hash_antes: hashAntes });
      contar(res, "planejado");
      continue;
    }

    // orfaos: a escolha do founder é por CLIENTE — o vínculo código→user tem de seguir fresco AGORA (Codex r2 P1).
    if (p.lote === "orfaos" && !(cand.customer_user_id && await d.confirmarVinculo(p.conta, cand.omie_codigo_cliente, cand.customer_user_id))) {
      item.status = "precondicao_falhou";
      item.erro = "o vínculo do cliente mudou ou venceu no espelho";
      await d.registrar({ ...base, status: "precondicao_falhou", hash_antes: hashAntes, erro: item.erro });
      contar(res, "precondicao_falhou");
      continue;
    }

    // aplicar — o recibo nasce 'indeterminado' e só sai disso com prova.
    const id = await d.registrar({ ...base, status: "indeterminado", hash_antes: hashAntes });
    let faultEscrita: string | null = null;
    try {
      faultEscrita = (await d.alterarCliente(payload)).fault;
    } catch (e) {
      if (!d.ehIndeterminada(e)) throw e;
      item.status = "indeterminado";
      item.erro = "AlterarCliente sem desfecho conhecido";
      await d.atualizar(id, { erro: item.erro });
      contar(res, "indeterminado");
      res.parou = `escrita indeterminada no cliente ${cand.omie_codigo_cliente}`;
      break;
    }
    // Releitura SEMPRE — inclusive depois de fault (um retry REDUNDANT pode esconder escrita feita; Codex P1).
    const relido = cadastroRelido(await d.relerCliente(cand.omie_codigo_cliente), cand.omie_codigo_cliente);
    // Leitura CRUA: ilegível não vira "vazio" na comparação com o de antes (Codex r2 P2).
    const depoisL = relido ? lerVendedor(relido) : "ilegivel";
    const depois = depoisL === "ilegivel" ? null : depoisL;
    item.vendedor_depois = depois;
    if (depoisL !== alvo) {
      if (faultEscrita !== null && relido && depoisL === leitura && leitura !== "ilegivel") {
        // O Omie recusou e o vendedor segue o de antes. Pode ter mexido em OUTRO campo (Codex r2 P1): recibo E resposta
        // seguem 'indeterminado' até a prova por hash confirmar que nada mudou ('erro_omie') — e o bloco continua.
        // (Codex v1.3 P2: antes a resposta já dizia 'erro_omie' sem prova quando faltava tempo para verificar.)
        item.status = "indeterminado";
        item.erro = faultEscrita;
        await d.atualizar(id, { vendedor_depois: depois, erro: faultEscrita });
        contar(res, "indeterminado");
        aVerificar.push({ id, item, hashAntes, cadAntes: cad, lidoEm, esperado: atual, seConfirmar: "erro_omie" });
        continue;
      }
      item.status = faultEscrita !== null && !relido ? "indeterminado" : "divergente";
      item.erro = relido ? `releitura mostra vendedor ${depois ?? "vazio"}${faultEscrita ? ` (fault: ${faultEscrita})` : ""}` : "releitura sem o cliente";
      await d.atualizar(id, { status: item.status, vendedor_depois: depois, erro: item.erro });
      contar(res, item.status);
      res.parou = `${item.status === "divergente" ? "divergência" : "escrita indeterminada"} no cliente ${cand.omie_codigo_cliente}`;
      break;
    }
    item.espelho_ok = await d.atualizarEspelho(p.conta, cand.omie_codigo_cliente, cand.customer_user_id, alvo);
    item.status = "alterado";
    await d.atualizar(id, { status: "alterado", vendedor_depois: depois, espelho_ok: item.espelho_ok, erro: faultEscrita });
    contar(res, "alterado");
    aVerificar.push({ id, item, hashAntes, cadAntes: cad, lidoEm, esperado: alvo, seConfirmar: "verificado" });
    if (!item.espelho_ok) { res.parou = `espelho não atualizou no cliente ${cand.omie_codigo_cliente}`; break; }
  }
  res.fim = res.parou === null && processados === candidatos.length && candidatos.length < p.limite;

  // Prova de que a escrita não mexeu em mais nada: 2º ConsultarCliente ≥61s depois do 1º, hash igual.
  for (const x of aVerificar) {
    if (res.parou?.startsWith("divergência")) break;
    const espera = x.lidoEm + ESPERA_REDUNDANCIA_MS - d.agora();
    if (decorrido() + Math.max(0, espera) > o.orcamentoTotalMs) break; // fica 'alterado' → modo verificar
    if (espera > 0) await d.dormir(espera);
    const cad = cadastroDe(await d.consultarCliente(x.item.omie_codigo_cliente), x.item.omie_codigo_cliente);
    if (!cad) continue; // sem leitura não há prova: segue 'alterado'/'indeterminado' → modo verificar
    const hashDepois = await hashCadastro(cad);
    const statusAntes = x.item.status;
    contar(res, statusAntes, -1);
    if (hashDepois === x.hashAntes && lerVendedor(cad) === x.esperado) {
      x.item.status = x.seConfirmar;
      await d.atualizar(x.id, { status: x.seConfirmar, hash_depois: hashDepois });
      contar(res, x.seConfirmar);
      if (x.seConfirmar === "erro_omie") x.item.erro = `${x.item.erro ?? ""} (provado: nada gravado)`.trim();
    } else {
      x.item.status = "divergente";
      const dif = camposDiferentes(x.cadAntes, cad);
      const vendLido = lerVendedor(cad);
      x.item.erro = (dif.length
        ? `o cadastro mudou além do vendedor: ${dif.join("; ")}`
        : `vendedor esperado ${x.esperado ?? "vazio"}, lido ${vendLido === "ilegivel" ? "ilegível" : vendLido ?? "vazio"}`).slice(0, 1500);
      await d.atualizar(x.id, { status: "divergente", hash_depois: hashDepois, erro: x.item.erro });
      contar(res, "divergente");
      res.parou = `divergência no cliente ${x.item.omie_codigo_cliente}`;
      res.fim = false;
    }
  }
}

/**
 * Modo verificar: termina a prova dos recibos 'alterado' e decide os 'indeterminado' pela leitura do Omie.
 * indeterminado + vendedor de antes = nada gravado ('erro_omie'); + alvo e hash igual = 'verificado'; resto 'divergente'.
 * `fim` só é true quando NÃO sobrou pendente nenhum (inclusive os novos demais para o ConsultarCliente).
 */
async function verificar(p: Parametros, d: Dependencias, o: OpcoesBloco, res: ResultadoBloco): Promise<void> {
  const inicio = d.agora();
  const pend = await d.pendentesVerificacao(p.execucao_id!, p.conta);
  let restam = 0;
  let feitos = 0;
  for (const x of pend) {
    if (feitos >= p.limite || d.agora() - inicio > o.orcamentoTotalMs) { restam++; continue; }
    if (d.agora() - x.criado_em_ms < ESPERA_REDUNDANCIA_MS) { restam++; continue; } // cedo demais: REDUNDANT
    feitos++;
    const item: ItemResultado = {
      omie_codigo_cliente: x.omie_codigo_cliente, customer_user_id: x.customer_user_id, nome_fantasia: null,
      vendedor_antes: x.vendedor_antes, vendedor_alvo: x.vendedor_alvo, vendedor_depois: null, status: x.status,
      espelho_ok: null, erro: null,
    };
    res.itens.push(item);
    const cad = cadastroDe(await d.consultarCliente(x.omie_codigo_cliente), x.omie_codigo_cliente);
    if (!cad) {
      // Sem leitura: segue pendente, mas é TOCADO (atualizado_em) para ir ao fim da fila — um cliente excluído do Omie
      // não pode travar a verificação dos outros (Codex r2 P2).
      item.erro = "ConsultarCliente sem o cadastro deste cliente";
      await d.atualizar(x.id, { erro: item.erro });
      restam++;
      continue;
    }
    const h = await hashCadastro(cad);
    const vendL = lerVendedor(cad); // cru: ilegível ≠ vazio (Codex r2 P2)
    const vend = vendL === "ilegivel" ? null : vendL;
    item.vendedor_depois = vend;
    let status: StatusRecibo;
    if (x.hash_antes !== null && h === x.hash_antes && vendL === x.vendedor_alvo) {
      status = "verificado";
      if (x.status === "indeterminado") item.espelho_ok = await d.atualizarEspelho(p.conta, x.omie_codigo_cliente, x.customer_user_id, x.vendedor_alvo);
    } else if (x.status === "indeterminado" && x.hash_antes !== null && h === x.hash_antes && vendL === x.vendedor_antes) {
      status = "erro_omie";
      item.erro = "a escrita indeterminada não chegou ao Omie";
    } else {
      status = "divergente";
      item.erro = "o cadastro mudou além do vendedor";
    }
    item.status = status;
    await d.atualizar(x.id, {
      status, hash_depois: h, vendedor_depois: vend, erro: item.erro,
      ...(item.espelho_ok === null ? {} : { espelho_ok: item.espelho_ok }),
    });
    contar(res, status);
    if (item.espelho_ok === false) { res.parou = `espelho não atualizou no cliente ${x.omie_codigo_cliente}`; restam++; break; }
    // Divergência PARA o operador também no modo verificar — senão `fim=true, parou=null` esconde o dano (Codex v1.1 P2).
    if (status === "divergente") { res.parou = `cadastro divergente no cliente ${x.omie_codigo_cliente}`; break; }
  }
  res.fim = res.parou === null && restam === 0;
}
