// A sonda desta edge é um SUPERSET da do #1618 — este arquivo é o que impede a regressão.
//
// O gate de CONTRATO das sondas (`_shared/sonda-versao-contrato_test.ts`) cobre o que é igual em
// toda edge: formato do `VERSAO`, `EFEITO` que nomeia o custo. O que é só DAQUI mora aqui: esta é a
// única edge cuja sonda já existia antes do mecanismo compartilhado, então ela tem uma dívida de
// retrocompatibilidade que as outras cinco não têm.
//
// Sem import de assert de propósito (o `test:edges` roda `--no-remote`, e `std/assert` é remoto).

import { EFEITO, respostaSondaTactical, VERSAO } from "./versao.ts";
import { MODELO } from "./plano-helpers.ts";

/**
 * As chaves que a sonda do #1618 servia. Estão escritas LITERALMENTE, e não derivadas da
 * implementação, porque o valor do teste está justamente em ser uma cópia independente: derivar do
 * código faria o assert acompanhar a remoção em silêncio.
 */
const CHAVES_DO_1618 = ["ok", "motor", "modelo", "tool", "fallback_fabricado"] as const;

Deno.test("a sonda responde o contrato compartilhado: probe ecoado + versao", () => {
  const r = respostaSondaTactical();
  // O eco `probe:true` é o que distingue "a sonda respondeu" de "o fluxo real respondeu": um bundle
  // anterior à sonda IGNORA o parâmetro (docs/agent/deploy.md §Canárias, armadilha 1).
  if (r.probe !== true) throw new Error(`sonda sem eco probe:true: ${JSON.stringify(r)}`);
  if (r.versao !== VERSAO) throw new Error(`versao divergente: ${r.versao} != ${VERSAO}`);
  if (r.ok !== true) throw new Error(`sonda deve responder ok:true, veio ${JSON.stringify(r.ok)}`);
});

Deno.test("a sonda NÃO perde nenhuma chave da versão anterior (#1618)", () => {
  // Esta edge é a única com sonda PRÉ-existente: quem tem o curl do #1618 anotado lê `motor` e
  // conclui "Anthropic no ar". Trocar em vez de estender quebraria essa verificação em uso — e
  // quebraria em PRODUÇÃO, silenciosamente, porque o leitor é humano e não CI.
  const r = respostaSondaTactical() as unknown as Record<string, unknown>;
  for (const chave of CHAVES_DO_1618) {
    if (!(chave in r)) {
      throw new Error(`a sonda perdeu a chave '${chave}' do #1618 — é retrocompatibilidade, não sobra`);
    }
  }
});

Deno.test("os campos do #1618 mantêm o VALOR que a verificação daquele PR lê", () => {
  // Presença não basta: o discriminante do #1618 é `motor === 'anthropic'` (gateway Lovable vs
  // Anthropic direta) e `fallback_fabricado === false` (o catch que inventava plano foi removido).
  // Uma chave presente com valor trocado passaria no teste de presença e mentiria igual.
  const r = respostaSondaTactical();
  if (r.motor !== "anthropic") throw new Error(`motor deixou de ser 'anthropic': ${r.motor}`);
  if (r.fallback_fabricado !== false) throw new Error("fallback_fabricado deixou de ser false");
  if (r.modelo !== MODELO) throw new Error(`modelo divergente do helper: ${r.modelo} != ${MODELO}`);
  if (typeof r.tool !== "string" || r.tool.length === 0) {
    throw new Error(`tool vazio — o nome da tool é o que prova forced tool-use: ${JSON.stringify(r.tool)}`);
  }
});

Deno.test("o EFEITO nomeia AS DUAS metades do custo: modelo e escrita", () => {
  // O 400 de `probe` ambíguo cita o EFEITO para que quem tomou a recusa decida se pode retentar.
  // Aqui o custo é duplo e as metades são independentes — citar só uma subestima a recusa.
  if (!/anthropic|modelo|token/i.test(EFEITO)) {
    throw new Error(`EFEITO não menciona o custo do modelo: ${EFEITO}`);
  }
  if (!/farmer_tactical_plans/.test(EFEITO)) {
    throw new Error(`EFEITO não menciona a escrita em farmer_tactical_plans: ${EFEITO}`);
  }
});
