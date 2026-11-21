// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/omie-cliente-trocar-vendedor/
import {
  CONFIRMACAO_APLICAR,
  conferirAlvo,
  decidir,
  hashCadastro,
  lerParametros,
  blocosPreenchidos,
  enderecoFaltando,
  payloadAlterar,
  textoParaHash,
  VENDEDOR,
  vendedorDoCadastro,
} from "./decisao.ts";

function igual(a: unknown, b: unknown, msg: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: recebido ${JSON.stringify(a)}, esperado ${JSON.stringify(b)}`);
}

const CAD = {
  codigo_cliente_omie: 8689681368,
  razao_social: "X LTDA",
  info: { dAlt: "20/08/2026", hAlt: "10:24:45", uAlt: "P1" },
  recomendacoes: { codigo_transportadora: 8689697767, codigo_vendedor: 8689670840, gerar_boletos: "N" },
  tags: [{ tag: "Cliente" }],
  endereco: "RUA A", endereco_numero: "10", bairro: "CENTRO", cidade: "ITAUNA (MG)", estado: "MG", cep: "35680-000",
};

Deno.test("decidir saida_vendedora: troca só quem está num código de origem DA MESMA conta", () => {
  igual(decidir("saida_vendedora", "oben", 8689670840, 8689670842).tipo, "trocar", "origem oben");
  igual(decidir("saida_vendedora", "oben", 8689670842, 8689670842).tipo, "ja_certo", "já no alvo");
  igual(decidir("saida_vendedora", "oben", null, 8689670842).tipo, "precondicao_falhou", "vazio não é da saída");
  igual(decidir("saida_vendedora", "oben", 4231476928, 8689670842).tipo, "precondicao_falhou", "código da colacor na oben");
  igual(decidir("saida_vendedora", "colacor_sc", 3545068907, 3545068880).tipo, "trocar", "4º código colacor_sc");
  igual(decidir("saida_vendedora", "oben", 8689670832, 8689670842).tipo, "precondicao_falhou", "outro vendedor: não toca");
});

Deno.test("decidir orfaos: só troca quem está sem vendedor", () => {
  igual(decidir("orfaos", "oben", null, VENDEDOR.LUCAS.oben).tipo, "trocar", "vazio");
  igual(decidir("orfaos", "oben", VENDEDOR.LUCAS.oben, VENDEDOR.LUCAS.oben).tipo, "ja_certo", "já certo");
  igual(decidir("orfaos", "oben", 8689670840, VENDEDOR.REGINA.oben).tipo, "precondicao_falhou", "tem vendedor");
});

Deno.test("vendedorDoCadastro: 0/ausente/lixo = null, string numérica aceita", () => {
  igual(vendedorDoCadastro(CAD), 8689670840, "número");
  igual(vendedorDoCadastro({ recomendacoes: { codigo_vendedor: 0 } }), null, "zero");
  igual(vendedorDoCadastro({ recomendacoes: {} }), null, "ausente");
  igual(vendedorDoCadastro({}), null, "sem recomendacoes");
  igual(vendedorDoCadastro({ recomendacoes: { codigo_vendedor: "123" } }), 123, "string");
  igual(vendedorDoCadastro({ recomendacoes: { codigo_vendedor: "12a" } }), null, "string lixo");
});

Deno.test("payloadAlterar: recomendacoes inteiro, só o vendedor muda; escalares voltam como lidos, sem info/tags", () => {
  const p = payloadAlterar(CAD, 8689670842);
  igual(p, {
    codigo_cliente_omie: 8689681368,
    razao_social: "X LTDA",
    endereco: "RUA A", endereco_numero: "10", bairro: "CENTRO", cidade: "ITAUNA (MG)", estado: "MG", cep: "35680-000",
    recomendacoes: { codigo_transportadora: 8689697767, codigo_vendedor: 8689670842, gerar_boletos: "N" },
  }, "payload");
  igual(CAD.recomendacoes.codigo_vendedor, 8689670840, "não muta o cadastro lido");
});

Deno.test("hash ignora vendedor e info, e enxerga qualquer outra mudança", async () => {
  const depois = { ...CAD, info: { dAlt: "21/11/2026" }, recomendacoes: { ...CAD.recomendacoes, codigo_vendedor: 8689670842 } };
  igual(await hashCadastro(CAD), await hashCadastro(depois), "só vendedor+info mudaram");
  const ordem = { endereco: "RUA A", endereco_numero: "10", bairro: "CENTRO", cidade: "ITAUNA (MG)", estado: "MG", cep: "35680-000", tags: CAD.tags, recomendacoes: { gerar_boletos: "N", codigo_vendedor: 1, codigo_transportadora: 8689697767 }, razao_social: "X LTDA", codigo_cliente_omie: 8689681368 };
  igual(await hashCadastro(CAD), await hashCadastro(ordem), "ordem das chaves não importa");
  const transp = { ...CAD, recomendacoes: { ...CAD.recomendacoes, codigo_transportadora: 0 } };
  if (await hashCadastro(CAD) === await hashCadastro(transp)) throw new Error("transportadora zerada passou despercebida");
  const tag = { ...CAD, tags: [] };
  if (await hashCadastro(CAD) === await hashCadastro(tag)) throw new Error("tag apagada passou despercebida");
  if (textoParaHash(CAD).includes("8689670840")) throw new Error("o vendedor entrou no texto do hash");
});

Deno.test("conferirAlvo: fail-closed em ausente, inativo e nome trocado", () => {
  const vs = [{ codigo: 1, nome: "REGINA", inativo: "N" }, { codigo: 2, nome: "REGINA", inativo: "S" }, { codigo: 3, nome: "OUTRA", inativo: "N" }];
  igual(conferirAlvo(vs, 1, "REGINA").ok, true, "ativo");
  igual(conferirAlvo(vs, 2, "REGINA").ok, false, "inativo");
  igual(conferirAlvo(vs, 3, "REGINA").ok, false, "nome");
  igual(conferirAlvo(vs, 9, "REGINA").ok, false, "ausente");
});

Deno.test("lerParametros: aplicar sem confirmação, conta/limite inválidos e alvo no body são recusados", () => {
  const base = { modo: "dry_run", lote: "saida_vendedora", conta: "oben" };
  igual(lerParametros(base).ok, true, "dry_run mínimo");
  igual(lerParametros({ ...base, modo: "aplicar" }).ok, false, "aplicar sem confirmo");
  igual(lerParametros({ ...base, modo: "aplicar", confirmo: CONFIRMACAO_APLICAR }).ok, true, "aplicar com confirmo");
  igual(lerParametros({ ...base, conta: "todas" }).ok, false, "conta");
  igual(lerParametros({ ...base, limite: 31 }).ok, false, "limite > max");
  igual(lerParametros({ ...base, limite: 0 }).ok, false, "limite 0");
  igual(lerParametros({ ...base, clientes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }).ok, false, "canário > 10");
  igual(lerParametros({ ...base, clientes: [1.5] }).ok, false, "código não inteiro");
  igual(lerParametros({ ...base, escolhas: [] }).ok, false, "escolhas fora do lote orfaos");
  const r = lerParametros({ ...base, alvo: 123 });
  igual(r.ok && !("alvo" in r.p), true, "alvo no body é ignorado: nunca vira parâmetro");
});

Deno.test("lerParametros orfaos: exige escolhas válidas, sem duplicata", () => {
  const base = { modo: "dry_run", lote: "orfaos", conta: "oben" };
  const id = "33f59dc7-0000-4000-8000-000000000001";
  igual(lerParametros(base).ok, false, "sem escolhas");
  igual(lerParametros({ ...base, escolhas: [{ customer_user_id: id, dono: "REGINA" }] }).ok, true, "uma escolha");
  igual(lerParametros({ ...base, escolhas: [{ customer_user_id: id, dono: "TATYANA" }] }).ok, false, "dono inválido");
  igual(lerParametros({ ...base, escolhas: [{ customer_user_id: id, dono: "REGINA" }, { customer_user_id: id.toUpperCase(), dono: "LUCAS" }] }).ok, false, "duplicada");
});

Deno.test("lerParametros verificar: exige execucao_id", () => {
  igual(lerParametros({ modo: "verificar", lote: "saida_vendedora", conta: "oben" }).ok, false, "sem id");
  igual(lerParametros({ modo: "verificar", lote: "saida_vendedora", conta: "oben", execucao_id: "33f59dc7-0000-4000-8000-000000000001" }).ok, true, "com id");
});

Deno.test("v1.2/v1.3 payloadAlterar: endereço vazio = null; payload = escalares como lidos", () => {
  for (const k of ["endereco", "endereco_numero", "bairro", "cidade", "estado", "cep"]) {
    igual(payloadAlterar({ ...CAD, [k]: "" }, 1), null, `${k} vazio`);
    igual(payloadAlterar({ ...CAD, [k]: "  " }, 1), null, `${k} em branco`);
    const { [k]: _x, ...sem } = CAD as Record<string, unknown>;
    igual(payloadAlterar(sem, 1), null, `sem ${k}`);
  }
  igual(enderecoFaltando({ ...CAD, bairro: "", cep: 0 }), ["bairro", "cep"], "lista o que falta");
  const p = payloadAlterar({ ...CAD, complemento: "SALA 2", email: "x@y.com", inativo: "N", valor_limite_credito: 0, bloq: true, nan: NaN, nada: null, dadosBancarios: { banco: "1" }, separar_endereco: "S", pesquisar_cep: "S" }, 1)!;
  igual(Object.keys(p).sort(), ["bairro", "bloq", "cep", "cidade", "codigo_cliente_omie", "complemento", "email", "endereco", "endereco_numero", "estado", "inativo", "razao_social", "recomendacoes", "valor_limite_credito"], "v1.3: só escalares + recomendações (sem info/tags/objetos/null/NaN)");
  igual([p.email, p.complemento, p.valor_limite_credito, p.bloq], ["x@y.com", "SALA 2", 0, true], "valores como lidos");
});

Deno.test("v1.3 blocosPreenchidos: lista só listas/objetos NÃO vazios, fora info/recomendacoes", () => {
  igual(blocosPreenchidos({ ...CAD, caracteristicas: [], enderecoEntrega: { entEndereco: "R" }, dadosBancarios: {} }), ["enderecoEntrega", "tags"], "blocos");
});
