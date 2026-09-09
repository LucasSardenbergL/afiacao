#!/usr/bin/env bash
# falsificar-gate-corpo.sh — o eixo 5 do gate de ordem (#2428) sabe ficar VERMELHO?
#
# Um gate que só se viu passar não provou nada: sempre-verde aprova tudo, e sempre-vermelho também
# "pega" o bug (docs/historico/falsificacao-sem-linha-de-base.md). Este script exige os DOIS lados
# na MESMA invocação — o controle verde roda ANTES de qualquer sabotagem, e se ele não ficar verde
# o script aborta sem sabotar nada, porque uma sabotagem sobre uma base já vermelha não mede nada.
#
# Cada cenário é uma leitura de sonda + um histórico, alimentados direto em `julgarPrecondicao`.
# São fixtures e não prod de propósito: o cenário "prod em dia" não existe em prod hoje (a migration
# do incidente segue por aplicar), e um falsificador que só rode quando o banco coopera não roda.
#
# ## Por que ele NÃO é um step do CI (medido, não suposto)
#
# Tentei ligá-lo ao `gates-e-falsificacao` e o `exclusividade` reprovou: GATE_NOVO_SEM_EXCLUSIVIDADE
# — "um gate custa segundos em todo PR, para sempre; a prova de que ele pega algo que os outros não
# pegam é o preço". Fui medir em vez de fabricar um defeito para ganhar a métrica:
#
#   sabotagem: o ramo `CORPO_ANTERIOR` de `classificarCorpo` passa a devolver `DERIVA`
#   controle verde antes  → vitest 0
#   sob sabotagem         → vitest 1   ·  este script 1
#
# Os dois pegam. A cobertura de CI já está em `precondicao-banco.test.ts` e `pendencias-pacote.test.ts`,
# que rodam no job `testes` e exercitam os MESMOS cenários (corpo anterior bloqueia, deriva libera,
# overload indecidível, os dois controles positivos). Um step aqui só repetiria isso mais devagar.
#
# Então este arquivo é FERRAMENTA DE MÃO, da família de `falsificar-individuais.sh` e
# `falsificar-baixa-nao-ingerida.sh`: serve para conferir o gate de uma vez só, em um comando, ao
# mexer no eixo 5 — sem esperar a suíte inteira. Se um dia ele passar a cobrir algo que o vitest
# não cobre, aí ele paga o próprio preço e vira step, com o defeito em `scripts/exclusividade.d/`.
#
# Uso: bun run falsificar:gate-corpo    ·    exit 0 = o gate discrimina; ≠0 = ele não discrimina.
set -euo pipefail

cd "$(dirname "$0")/.."

# Sonda ausente é fail-CLOSED aqui: este script decide se um gate de money-path é confiável, e
# `command -v` não basta — presente-porém-quebrado esvazia o guard do mesmo jeito.
if ! bun --version >/dev/null 2>&1; then
  echo "⛔ bun não respondeu a --version — sem runtime não há falsificação, e 'pulei' não é verde"
  exit 2
fi

exec bun - <<'TS'
import {
  type CorposEsperados,
  julgarPrecondicao,
  type LeituraSonda,
} from './scripts/lib/precondicao-banco';

const ALVO = [{ rpc: 'criar_pedidos_com_itens', edges: ['omie-vendas-sync'] }];
// md5 de 'a' e 'b' — digitados, conferíveis com `printf 'a' | md5`.
const ATUAL = '0cc175b9c0f1b6a831c399e269772661';
const VELHO = '92eb5ffee6ae2fec3ad71c777531578f';
const NOVA = '20260908215704_desconto_valor_atravessa_os_escritores.sql';
const ANTIGA = '20260908163659_pedido_nasce_com_identidade_de_linha.sql';

const historico = (): CorposEsperados => ({
  historico: new Map([[
    'public.criar_pedidos_com_itens',
    [{ migration: ANTIGA, md5: VELHO }, { migration: NOVA, md5: ATUAL }],
  ]]),
  inventarioDaRef: 721,
  migrationsLidas: 721,
  funcoesConhecidas: 1,
});

const sonda = (md5s: string[], overloads = 1): LeituraSonda => ({
  medicoes: [{ rpc: 'criar_pedidos_com_itens', existe: true, familia: 12 }],
  corpos: new Map([['criar_pedidos_com_itens', { md5s, overloads }]]),
  funcoesPublic: 1200,
  fim: true,
  dialetoOk: true,
});

const estado = (l: LeituraSonda, c: CorposEsperados = historico()) =>
  julgarPrecondicao(ALVO, l, 0, c).estado;

let falhas = 0;
const exigir = (rotulo: string, obtido: string, esperado: string) => {
  const ok = obtido === esperado;
  if (!ok) falhas++;
  console.log(`${ok ? '  ok  ' : '  FALHA'} ${rotulo}: ${obtido} (esperado ${esperado})`);
};

// ── CONTROLE VERDE, antes de qualquer sabotagem ────────────────────────────────────────────────
// Se ele não passar, o resto não mede nada: um gate sempre-vermelho "pega" o bug e reprova o mundo.
console.log('CONTROLE (prod rodando o corpo da última migration — tem de LIBERAR):');
exigir('corpo em dia', estado(sonda([ATUAL])), 'LIBERADA');
if (falhas > 0) {
  console.log('\n⛔ o CONTROLE já está vermelho — abortei ANTES de sabotar.');
  console.log('   Sabotagem sobre base vermelha não distingue "o gate pegou" de "ele reprova tudo".');
  process.exit(1);
}

// ── SABOTAGENS: cada uma tem de virar o veredito ───────────────────────────────────────────────
console.log('\nSABOTAGENS (cada uma tem de virar o veredito):');
// A do incidente: mesma RPC, mesma existência, só o CORPO é o da migration anterior.
exigir('prod roda o corpo ANTERIOR (#2428)', estado(sonda([VELHO])), 'BLOQUEADA');
exigir('repo foi lido VAZIO (extrator cego)', estado(sonda([VELHO]), {
  historico: new Map(),
  inventarioDaRef: 0,
  migrationsLidas: 0,
  funcoesConhecidas: 0,
}), 'INCERTA');
exigir('arquivos lidos, ZERO funções extraídas', estado(sonda([ATUAL]), {
  historico: new Map(),
  inventarioDaRef: 721,
  migrationsLidas: 721,
  funcoesConhecidas: 0,
}), 'INCERTA');

// ── NÃO-SABOTAGENS: têm de continuar VERDES, senão o gate trava todo deploy ─────────────────────
// Este bloco é o que separa "o gate discrimina" de "o gate reprova tudo que não é idêntico".
console.log('\nNÃO-SABOTAGENS (deriva histórica e afins — têm de seguir LIBERADA):');
exigir('DERIVA: corpo que nenhuma migration declara', estado(sonda(['f'.repeat(32)])), 'LIBERADA');
exigir('overload em prod (indecidível, não atraso)', estado(sonda([VELHO, ATUAL], 2)), 'LIBERADA');
exigir('prod sem corpo textual (prosqlbody / C)', estado(sonda([])), 'LIBERADA');
exigir('função sem CREATE commitado', estado(sonda([ATUAL]), {
  historico: new Map([['public.outra', [{ migration: 'm.sql', md5: ATUAL }]]]),
  inventarioDaRef: 721,
  migrationsLidas: 721,
  funcoesConhecidas: 1,
}), 'LIBERADA');

console.log(
  falhas === 0
    ? '\n✅ FALSIFICADO: o gate fica VERMELHO no cenário medido e VERDE na deriva benigna.'
    : `\n⛔ ${falhas} cenário(s) com o veredito errado — o gate NÃO discrimina.`,
);
process.exit(falhas === 0 ? 0 : 1);
TS
