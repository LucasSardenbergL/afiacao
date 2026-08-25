// Testes da ASSINATURA COMPORTAMENTAL da canária `identidade_probe` (#1888 / PR-2 / A2).
//
// O QUE ESTE ARQUIVO PROVA, e o que NÃO prova. O avaliador recebe as duas funções deployadas por
// PARÂMETRO (o `index.ts` importa `npm:@supabase/supabase-js@2` e `test:edges` roda com
// `--no-remote`, então nenhum teste alcança o arquivo). Aqui ele é exercitado contra duplos:
//
//   PROVA ....... que o avaliador ACEITA uma implementação que respeita o contrato A2 e REJEITA
//                 cada sabotagem, nomeando o caso — ou seja, que ele DISCRIMINA. Sem isto a
//                 assinatura seria "teatro verde" (docs/agent/deploy.md).
//   NÃO PROVA ... que a implementação real está correta. Isso é
//                 `src/lib/omie/omie-identity-snapshot.test.ts` (o oráculo) mais a PARIDADE
//                 textual src×edge de `src/__tests__/edge-money-path-invariants.test.ts`.
//
// O terceiro teste fecha o furo que sobra entre os dois: as marcas de erro que a assinatura casa
// são trechos LITERAIS das mensagens do bloco espelhado. Se uma mensagem mudar lá e a marca ficar
// para trás, a canária devolveria `assinatura_a2.ok:false` sobre um bundle CORRETO — falso negativo
// que se lê como reversão do Lovable. O teste lê o `index.ts` como TEXTO e cobra que cada marca ainda
// case (é o mesmo recurso que o gate de contrato usa; `--allow-read=supabase/functions` cobre).

import { removerComentarios } from "../_shared/limpeza-fonte.ts";
import { avaliarAssinaturaA2, CONTRATO_A2, type DepsAssinaturaA2, MARCAS_A2 } from "./assinatura-a2.ts";
import type { AssinaturaA2 } from "./assinatura-a2.ts";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const CODIGO_RE = /^[1-9][0-9]*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Duplo CORRETO: reimplementa as regras do contrato A2 que a assinatura cobra. É deliberadamente
 * uma segunda escrita das regras, e não uma cópia do helper — se fosse cópia, o teste provaria só
 * que dois arquivos iguais concordam.
 */
const depsCorretas: DepsAssinaturaA2 = {
  parse(snap) {
    const s = snap as Record<string, unknown>;
    const docToUserMap = new Map<string, string>(
      Object.entries(s.doc_to_user as Record<string, string>),
    );
    const ambiguousDocs = new Set<string>(s.ambiguous_docs as string[]);
    const c2u = s.client_to_user;
    if (!c2u || typeof c2u !== "object" || Array.isArray(c2u)) {
      throw new Error("identity snapshot: client_to_user ausente ou não-objeto (fail-closed)");
    }
    const usuariosComDocUnico = new Set(docToUserMap.values());
    const clientToUser = new Map<number, string>();
    for (const [codigo, user] of Object.entries(c2u)) {
      if (typeof user !== "string" || !UUID_RE.test(user)) {
        throw new Error("identity snapshot: user_id não-UUID em client_to_user (fail-closed)");
      }
      if (!CODIGO_RE.test(codigo) || !Number.isSafeInteger(Number(codigo))) {
        throw new Error("identity snapshot: código de cliente inválido em client_to_user (fail-closed)");
      }
      if (!usuariosComDocUnico.has(user)) {
        throw new Error("identity snapshot: user de client_to_user fora de doc_to_user (fail-closed)");
      }
      clientToUser.set(Number(codigo), user);
    }
    const rev = s.revoked_client_codes;
    if (!Array.isArray(rev)) {
      throw new Error("identity snapshot: revoked_client_codes ausente ou não-array (fail-closed)");
    }
    const revokedClientCodes = new Set<number>();
    for (const codigo of rev) {
      const cod = Number(codigo);
      if (clientToUser.has(cod)) {
        throw new Error("identity snapshot: código em client_to_user E revoked_client_codes (fail-closed)");
      }
      revokedClientCodes.add(cod);
    }
    return { docToUserMap, ambiguousDocs, clientToUser, revokedClientCodes };
  },
  aplicar(cache, prova, revogados) {
    const cacheDaView = cache.size;
    if (cacheDaView >= 100 && revogados.size > cacheDaView * 0.3) {
      throw new Error("identity snapshot: revogação em massa é sinal de snapshot degradado (fail-closed)");
    }
    let divergencias = 0;
    for (const [codigo, userProvado] of prova) {
      const doCache = cache.get(codigo);
      if (doCache !== undefined && doCache !== userProvado) divergencias++;
      cache.set(codigo, userProvado);
    }
    let revogadosNoCache = 0;
    for (const codigo of revogados) if (cache.delete(codigo)) revogadosNoCache++;
    return {
      cacheDaView,
      provados: prova.size,
      divergencias,
      revogados: revogadosNoCache,
      cobertura: cacheDaView === 0 ? 0 : prova.size / cacheDaView,
    };
  },
};

/** Falhas nomeadas, para os asserts lerem por caso em vez de por índice. */
function reprovados(a: AssinaturaA2): string[] {
  return a.casos.filter((c) => !c.ok).map((c) => c.caso);
}

Deno.test("assinatura A2: implementação que respeita o contrato passa em TODOS os casos", () => {
  const a = avaliarAssinaturaA2(depsCorretas);
  if (!a.ok) {
    throw new Error(`o avaliador reprovou uma implementação correta: ${reprovados(a).join(", ")}`);
  }
  if (a.casos.length !== 9) {
    throw new Error(`a tabela-verdade encolheu para ${a.casos.length} casos — cobertura silenciosamente menor`);
  }
  if (a.contrato !== CONTRATO_A2) {
    throw new Error(`contrato ${JSON.stringify(a.contrato)} — a resposta não diz mais O QUE o ok afirma`);
  }
});

Deno.test("FALSIFICAÇÃO: um bundle PRÉ-#1888 é reprovado — é para isso que a assinatura existe", () => {
  // A forma exata do bundle anterior: o parse do PR-1 devolve doc_to_user/ambiguous_docs e IGNORA
  // client_to_user (a chave nem existia no contrato dele), e `aplicarProvaPositivaNoCache` não
  // existe — o `index.ts` de então não teria o que passar. Aqui o `aplicar` é um no-op, que é o
  // efeito observável de "a sobreposição não está no ar".
  const preA2: DepsAssinaturaA2 = {
    parse(snap) {
      const s = snap as Record<string, unknown>;
      return {
        docToUserMap: new Map(Object.entries(s.doc_to_user as Record<string, string>)),
        ambiguousDocs: new Set(s.ambiguous_docs as string[]),
        clientToUser: new Map(),
        revokedClientCodes: new Set(),
      };
    },
    aplicar(cache) {
      return { cacheDaView: cache.size, provados: 0, divergencias: 0, revogados: 0, cobertura: 0 };
    },
  };
  const a = avaliarAssinaturaA2(preA2);
  if (a.ok) throw new Error("o avaliador APROVOU um bundle pré-#1888 — a canária não discrimina");
  // Não basta reprovar: tem de reprovar em TODO caso que o #1888 introduziu, senão a sabotagem
  // seguinte passa pelo caso que sobrou.
  for (
    const esperado of [
      "parse_exige_client_to_user",
      "parse_exige_revoked_client_codes",
      "parse_devolve_prova_e_revogados",
      "parse_recusa_user_fora_de_doc_to_user",
      "parse_recusa_provado_e_revogado",
      "parse_recusa_codigo_nao_decimal",
      "prova_vence_cache_divergente",
      "revogado_sai_do_cache",
      "revogacao_em_massa_aborta",
    ]
  ) {
    if (!reprovados(a).includes(esperado)) {
      throw new Error(`bundle pré-#1888 passou no caso ${esperado} — cobertura cega ali`);
    }
  }
});

Deno.test("FALSIFICAÇÃO: cada sabotagem PONTUAL é pega pelo caso que lhe corresponde", () => {
  // Uma sabotagem por vez, sobre a implementação correta: prova que os casos são independentes e
  // que nenhum deles está passando por acidente do vizinho.
  const sabotagens: Array<{ nome: string; caso: string; deps: DepsAssinaturaA2 }> = [
    {
      nome: "parse aceita client_to_user ausente (o fail-closed do A2 sumiu)",
      caso: "parse_exige_client_to_user",
      deps: {
        ...depsCorretas,
        parse(snap) {
          const s = { ...(snap as Record<string, unknown>) };
          if (!("client_to_user" in s)) s.client_to_user = {};
          return depsCorretas.parse(s);
        },
      },
    },
    {
      nome: "parse confia em user fora de doc_to_user (contrato v1 afrouxado)",
      caso: "parse_recusa_user_fora_de_doc_to_user",
      deps: {
        ...depsCorretas,
        parse(snap) {
          const s = snap as Record<string, unknown>;
          const base = depsCorretas.parse({ ...s, client_to_user: {} });
          for (const [cod, user] of Object.entries(s.client_to_user as Record<string, string>)) {
            base.clientToUser.set(Number(cod), user);
          }
          return base;
        },
      },
    },
    {
      nome: "parse aceita código não-decimal (Number('1e3') vira 1000 — chave FABRICADA)",
      caso: "parse_recusa_codigo_nao_decimal",
      deps: {
        ...depsCorretas,
        parse(snap) {
          const s = snap as Record<string, unknown>;
          const c2u = s.client_to_user as Record<string, string>;
          const saneado: Record<string, string> = {};
          for (const [cod, user] of Object.entries(c2u)) saneado[String(Number(cod))] = user;
          return depsCorretas.parse({ ...s, client_to_user: saneado });
        },
      },
    },
    {
      nome: "aplicar não sobrepõe o cache divergente (a prova positiva vira ornamento)",
      caso: "prova_vence_cache_divergente",
      deps: {
        ...depsCorretas,
        aplicar(cache, _prova, revogados) {
          return depsCorretas.aplicar(cache, new Map(), revogados);
        },
      },
    },
    {
      nome: "aplicar não REMOVE o revogado (só omite — o cache segue servindo o vínculo podre)",
      caso: "revogado_sai_do_cache",
      deps: {
        ...depsCorretas,
        aplicar(cache, prova, _revogados) {
          return depsCorretas.aplicar(cache, prova, new Set());
        },
      },
    },
    {
      nome: "aplicar perdeu o teto de 30% (revogação em massa vira rate-limit no Omie)",
      caso: "revogacao_em_massa_aborta",
      deps: {
        ...depsCorretas,
        aplicar(cache, prova, revogados) {
          let removidos = 0;
          for (const [codigo, user] of prova) cache.set(codigo, user);
          for (const codigo of revogados) if (cache.delete(codigo)) removidos++;
          return {
            cacheDaView: cache.size + removidos,
            provados: prova.size,
            divergencias: 0,
            revogados: removidos,
            cobertura: 0,
          };
        },
      },
    },
  ];
  for (const { nome, caso, deps } of sabotagens) {
    const a = avaliarAssinaturaA2(deps);
    const falhos = reprovados(a);
    if (!falhos.includes(caso)) {
      throw new Error(`sabotagem "${nome}" NÃO foi pega pelo caso ${caso} (reprovados: ${falhos.join(", ") || "nenhum"})`);
    }
  }
});

Deno.test("a assinatura NUNCA propaga exceção — um throw derruba a canária inteira", () => {
  // A `identidade_probe` responde por DENTRO do try do handler: um erro escapando daqui vira 500
  // e leva junto a prova do P0-B, que não tem nada a ver com o A2. A canária mentiria sobre si
  // mesma no ponto em que ela é mais lida.
  const explosivas: DepsAssinaturaA2 = {
    parse() {
      throw new Error("boom no parse");
    },
    aplicar() {
      throw new Error("boom no aplicar");
    },
  };
  const a = avaliarAssinaturaA2(explosivas);
  if (a.ok) throw new Error("deps que só explodem foram aprovadas");
  if (a.casos.length !== 9) throw new Error("a avaliação abortou no meio em vez de reportar caso a caso");
});

Deno.test("as MARCAS ainda existem no index.ts — senão a sonda dá falso NEGATIVO em bundle correto", () => {
  const fonte = Deno.readTextFileSync("supabase/functions/omie-vendas-sync/index.ts");
  // Controle positivo: sem isto o teste passaria lendo um arquivo vazio.
  if (!fonte.includes("function parseIdentitySnapshot(")) {
    throw new Error("li o arquivo errado — parseIdentitySnapshot não está lá (controle positivo vazio)");
  }
  for (const [nome, marca] of Object.entries(MARCAS_A2)) {
    if (!marca.test(fonte)) {
      throw new Error(
        `a marca ${nome} (${marca.source}) não aparece mais no index.ts — a mensagem do ramo mudou e ` +
          `a assinatura passaria a reprovar um bundle CORRETO`,
      );
    }
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// Gates TEXTUAIS sobre o `index.ts`: os testes acima provam que o avaliador DISCRIMINA, mas ele
// roda contra duplos e não tem como saber se a edge lhe passou as funções deployadas ou dois stubs
// que sempre concordam. Estes dois fecham esse elo. Ficam aqui, e não no vitest, porque leem o
// mesmo arquivo que o teste de marcas acima já lê (`--allow-read=supabase/functions` cobre).
// ─────────────────────────────────────────────────────────────────────────────

/** Bloco da action, SEM comentários: a prosa que explica o campo cita o campo, e um assert
 *  positivo sobre o texto cru passaria lendo o comentário mesmo com o código removido. */
function blocoDaCanaria(): string {
  const fonte = Deno.readTextFileSync("supabase/functions/omie-vendas-sync/index.ts");
  const limpo = removerComentarios(fonte);
  const m = limpo.match(/case "identidade_probe":[\s\S]*?\n {6}case /);
  if (!m) throw new Error("bloco da identidade_probe não encontrado (controle positivo vazio)");
  return m[0];
}

Deno.test("a canária ENTREGA a assinatura, e alimentada pelas funções REAIS do bundle", () => {
  // Sem isto, trocar `parse: parseIdentitySnapshot` por um stub deixaria a canária respondendo
  // `assinatura_a2.ok:true` sobre QUALQUER bundle: a prova do A2 viraria decoração, verde por
  // construção — que é o modo de falha que este PR existe para fechar.
  const bloco = blocoDaCanaria();
  if (!/avaliarAssinaturaA2\(/.test(bloco)) {
    throw new Error("a canária não roda mais a assinatura A2 — voltou a provar só o P0-B");
  }
  if (!/parse:\s*parseIdentitySnapshot\b/.test(bloco)) {
    throw new Error("a assinatura não recebe mais o parseIdentitySnapshot DEPLOYADO (stub? outro nome?)");
  }
  if (!/aplicar:\s*aplicarProvaPositivaNoCache\b/.test(bloco)) {
    throw new Error("a assinatura não recebe mais o aplicarProvaPositivaNoCache DEPLOYADO");
  }
  if (!/assinatura_a2:/.test(bloco)) {
    throw new Error("a assinatura é calculada e NÃO sai na resposta — quem sonda não vê o veredito");
  }
  // O `ok` agregado tem de INCLUIR a assinatura: se ele continuar sendo só a tabela do P0-B, um
  // bundle com o A2 revertido responde `ok:true` e a receita de leitura conclui "íntegro".
  if (!/ok:[^,]*assinaturaA2\.ok/.test(bloco)) {
    throw new Error("o `ok` agregado ignora a assinatura A2 — bundle com o A2 revertido leria como verde");
  }
});

Deno.test("CALIBRAÇÃO: os padrões acima reprovam a canária PRÉ-este-PR e a alimentada por stub", () => {
  // Sem isto os asserts só provariam que o arquivo tem as âncoras (deploy.md: "canária que não
  // discrimina é teatro verde"). Sabotar o `index.ts` real dentro do teste não é possível, então a
  // forma errada é montada aqui como texto.
  const preEstePr = 'result = { success: true, canary: true, contrato: "x", ok: casosId.every((c) => c.ok) };';
  if (/avaliarAssinaturaA2\(/.test(preEstePr)) {
    throw new Error("o padrão da assinatura não reprovaria a canária que só roda o P0-B");
  }
  if (/ok:[^,]*assinaturaA2\.ok/.test(preEstePr)) {
    throw new Error("o padrão do `ok` agregado não reprovaria um ok que ignora a assinatura");
  }
  const comStub = 'avaliarAssinaturaA2({ parse: parseFake, aplicar: aplicarFake }); assinatura_a2: a,';
  if (/parse:\s*parseIdentitySnapshot\b/.test(comStub)) {
    throw new Error("o padrão das deps não reprovaria uma assinatura alimentada por stub");
  }
});

Deno.test("o marcador `contrato` da canária NOMEIA a fatia do A2 — senão não discrimina este deploy", () => {
  // O `identidade-fail-closed-v1` do #1922 nasceu DEPOIS do #1888, então prova o A2 por
  // transitividade — mas responderia idêntico antes e depois DESTE PR, e é este PR que instala a
  // prova comportamental. Marcador que não muda quando o comportamento provado muda é a ⚠️ #2
  // "mente verde" de docs/agent/deploy.md.
  const bloco = blocoDaCanaria();
  const m = bloco.match(/contrato: ["\x27]([a-z0-9-]+)["\x27]/);
  if (!m) throw new Error("sumiu o marcador `contrato` da canária");
  if (!/a2|client-to-user/.test(m[1])) {
    throw new Error(
      `o marcador ${JSON.stringify(m[1])} não nomeia a fatia do A2 — a canária responderia igual ` +
        `num bundle com a assinatura e num sem ela`,
    );
  }
});
