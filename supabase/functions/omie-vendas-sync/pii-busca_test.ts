// Sem rede (`--no-remote` do test:edges): assert inline.
function igual(a: unknown, b: unknown, msg?: string) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(msg ?? `esperado ${jb}, veio ${ja}`);
}
import { decidirRevelacao, lerCodigoRevelar, mascararLinhaBusca } from "./pii-busca.ts";

const LINHA = {
  codigo_cliente: 42,
  razao_social: "MEI JOAO ***.***.***-**",
  razao_fiscal: "MEI JOAO 123.456.789-09",
  fantasia_fiscal: "JOAO 123.456.789-09",
  nome_fantasia: "JOAO",
  cnpj_cpf: "123.456.789-09",
  codigo_vendedor: 7,
  endereco: "Rua A",
  endereco_numero: "10",
  complemento: "fundos",
  bairro: "Centro",
  cidade: "JOINVILLE",
  estado: "SC",
  cep: "89200-000",
  telefone: "(47) 99999-0000",
  contato: "Maria",
  tags: ["marcenaria"],
  atividade: "",
};

Deno.test("busca fora da carteira: documento, endereço, telefone, contato e razão fiscal saem; identidade fica", () => {
  const m = mascararLinhaBusca(LINHA, false) as Record<string, unknown>;
  for (const c of ["cnpj_cpf", "endereco", "endereco_numero", "complemento", "bairro", "cep", "telefone", "contato"]) {
    igual(m[c], null, c);
  }
  igual("razao_fiscal" in m, false, "razao_fiscal ficou");
  igual("fantasia_fiscal" in m, false, "fantasia_fiscal ficou");
  igual(JSON.stringify(m).includes("123.456.789"), false, "o CPF sobrou em algum campo");
  igual([m.razao_social, m.cidade, m.estado, m.codigo_vendedor, m.contato_visivel], [LINHA.razao_social, "JOINVILLE", "SC", 7, false]);
  igual(LINHA.cnpj_cpf, "123.456.789-09", "mutou a entrada");
});

Deno.test("busca na carteira: linha inteira + contato_visivel", () => {
  const m = mascararLinhaBusca(LINHA, true);
  igual(m.cnpj_cpf, LINHA.cnpj_cpf);
  igual(m.razao_fiscal, LINHA.razao_fiscal);
  igual(m.contato_visivel, true);
});

Deno.test("codigo_cliente do revelar: só inteiro positivo", () => {
  igual(lerCodigoRevelar(42), 42);
  igual(lerCodigoRevelar("42"), 42);
  for (const ruim of [0, -1, 1.5, "4 2", "", null, undefined, "1e3", Number.MAX_SAFE_INTEGER + 2, {}]) {
    igual(lerCodigoRevelar(ruim), null, `aceitou ${String(ruim)}`);
  }
});

const U = "u-1";
const RPC_OK = [{ customer_user_id: U, document: "12345678909", cnpj: null }];

Deno.test("revelar: na carteira abre sem exceção", () => {
  igual(decidirRevelacao({ naCarteira: true, usuariosDoCodigo: new Set(), linhasRpc: [], cnpjCpfOmie: null }), {
    abre: true, via: "carteira",
  });
});

Deno.test("revelar fora da carteira: abre só com o ledger do titular deste código e o documento casando", () => {
  igual(decidirRevelacao({ naCarteira: false, usuariosDoCodigo: new Set([U]), linhasRpc: RPC_OK, cnpjCpfOmie: "123.456.789-09" }), {
    abre: true, via: "excecao",
  });
});

Deno.test("revelar fora da carteira: sem vínculo, outro titular, documento divergente ou RPC vazia → não abre", () => {
  igual(decidirRevelacao({ naCarteira: false, usuariosDoCodigo: new Set(), linhasRpc: RPC_OK, cnpjCpfOmie: "123.456.789-09" }), {
    abre: false, motivo: "sem_vinculo",
  });
  const fecha = { abre: false, motivo: "cadastro_divergente" };
  igual(decidirRevelacao({ naCarteira: false, usuariosDoCodigo: new Set(["u-2"]), linhasRpc: RPC_OK, cnpjCpfOmie: "123.456.789-09" }), fecha);
  igual(decidirRevelacao({ naCarteira: false, usuariosDoCodigo: new Set([U]), linhasRpc: RPC_OK, cnpjCpfOmie: "987.654.321-00" }), fecha);
  igual(decidirRevelacao({ naCarteira: false, usuariosDoCodigo: new Set([U]), linhasRpc: [], cnpjCpfOmie: "123.456.789-09" }), fecha);
  igual(decidirRevelacao({ naCarteira: false, usuariosDoCodigo: new Set([U]), linhasRpc: RPC_OK, cnpjCpfOmie: null }), fecha);
});
