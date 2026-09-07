import { useEffect, useRef } from 'react';
import { useMyPositivacao } from '@/hooks/useMyPositivacao';
import { useMyCommercialRole } from '@/hooks/useMyCommercialRole';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { estadoDeLeitura, revalidando } from '@/lib/leitura/estado-de-leitura';
import { estadoNaSerie, motivoNaSerie } from '@/lib/leitura/serie';
import { track } from '@/lib/analytics';

/**
 * SENSOR do placar de positivação — só mede, não desenha.
 *
 * O `carteira.positivacao_vista` morava dentro do `PositivacaoHero`, que só existe no ramo de
 * SUCESSO: quem não recebia `kpis` (leitura falhou) não emitia nada. A série de adoção ficava sem
 * denominador — e sem denominador, zero não julga desenho nenhum (`docs/historico/fase-sem-sinal.md`).
 * "Mês parado", "não consegui ler", "sem rede" e "nunca abriu a tela" chegavam ao PostHog como o
 * mesmo silêncio.
 *
 * O #1886 consertou o que a tela MOSTRA no erro (`AvisoLeituraFalhou`) e não tocou no que ela
 * MEDE — são trabalhos diferentes, e é por isso que este sensor é um hook e não mais um
 * componente de estado: desenhar já tem dono, medir não tinha. O estado vem do primitivo
 * COMPARTILHADO (`estadoDeLeitura`, do próprio #1886) em vez de uma segunda conta minha: duas
 * derivações do mesmo estado divergiriam no primeiro caso de borda, e a de borda aqui é o offline.
 *
 * Por que o vocabulário do primitivo vai CRU no evento (`pronta`/`erro`/`sem-rede`) em vez de um
 * booleano: 'sem-rede' e 'erro' doem diferente. Um vendedor em campo sem sinal não é a RPC
 * quebrada, e colapsar os dois faria a série culpar o backend por cobertura de celular.
 *
 * ⚠️ SEM DADO EM MÃOS os números vão em `null`, NUNCA `0` (§2 do money-path — ausente ≠ zero):
 * zero somaria falha de leitura como se fosse carteira sem positivação, fabricando exatamente o
 * número que o sensor existe para medir.
 *
 * Chama `useMyPositivacao()` por dentro de propósito — o react-query deduplica pela queryKey, e
 * assim o host ganha o sensor com UMA linha, sem reestruturar o que já tem. Pelo MESMO motivo ele
 * passou a chamar `useMyCommercialRole()` e `useImpersonation()` por dentro (ver A1 abaixo).
 *
 * ══ REVISÃO RETROATIVA DO #1896 (2026-08-23): o sensor emitia, e ROTULAVA errado ══
 * Três defeitos independentes, cada um corrompendo a mesma série. O que os une: um rótulo com
 * DEFAULT constante não é fato — é a versão em booleano do `Number(null)===0`.
 *
 * A1 — `is_hunter` FABRICADO, e determinístico no offline. O host fazia
 *      `const { data: commercialRole } = useMyCommercialRole()` e passava
 *      `commercialRole === 'hunter'`: enquanto o papel não chegava, `false`. Sem rede as duas
 *      leituras pausam JUNTAS, então TODO evento 'sem-rede' de um hunter saía `is_hunter:false` —
 *      não é corrida, é sempre; e a dedup impedia a correção quando o papel chegasse.
 *      **O rótulo mudou-se para DENTRO do sensor** porque enquanto ele fosse parâmetro, cada host
 *      podia fabricá-lo de novo (e dois já fabricavam: os dashboards passavam literal, e o gate
 *      `isLoading` do `CommercialDashboard` não cobre o offline — ver abaixo). Sem parâmetro, não
 *      há o que fabricar: é estrutural, não disciplina.
 *      ⚠️ E o discriminante NÃO é `isLoading`: query pausada tem `isLoading === false` (v5:
 *      `isPending && isFetching`), então gatear por ele seria INERTE justo no caso medido. Quem
 *      responde "o papel é conhecido?" é o `estado` do `estadoDeLeitura`, e só `'pronta'` conta.
 *      Fora dele o rótulo vai `null` — ausente ≠ zero também para booleano.
 *      ⚠️ SEGURAR o evento enquanto o papel carrega foi a 1ª tentativa e o /codex a derrubou: a
 *      leitura do papel não tem garantia de TÉRMINO (rede parcial/captive portal deixa a promise
 *      pendente sem disparar retry, porque o navegador segue `online`), então segurar perde a
 *      linha de forma SISTEMÁTICA — e o sensor IRMÃO, que não espera papel nenhum, emite na mesma
 *      visita: os dois passariam a discordar sobre o vendedor ter visto a tela. Num sensor que
 *      existe para dar DENOMINADOR, perder linha é o pior defeito possível. Emite-se com `null`
 *      (honesto: "ainda não sei") e o rótulo entra na CHAVE, então a correção nunca é engolida —
 *      duas linhas distinguíveis valem mais que uma linha ausente ou mentirosa.
 *      E o `null` também cobre a leitura do papel que FALHA: `useMyCommercialRole` descartava o
 *      `error` do PostgREST, resolvia com sucesso e `null`, e este gate lia isso como fato. Era A1
 *      vivo por outro caminho — corrigido lá, na fonte.
 *
 * A2 — a dedup não resetava na troca de SUJEITO (a lente "Ver como"), herdado do #1859.
 *      `ImpersonationProvider` é Context e a rota NÃO remonta, então o ref sobrevivia à mudança de
 *      `effectiveUserId`: alvo diferente com o mesmo estado não emitia nada. A adoção do ALVO
 *      sumia da série e a sessão do staff ficava contada como vendedor real. Agora o sujeito entra
 *      na CHAVE de dedup, e `sob_lente` entra no payload — o id do alvo fica só na chave (que é
 *      local e nunca sai daqui): para não contar staff como vendedor basta o booleano, e mandar
 *      uid de terceiro para o PostHog seria dado pessoal a mais sem pergunta a mais respondida.
 *
 * A3 — `erro`/`sem-rede` COM cache iam como leitura FRESCA. `estadoDeLeitura` testa
 *      `status==='success'` ANTES do `fetchStatus`, então cache quente + sem sinal devolve
 *      'pronta' — medido: `{"estado":"pronta","pct":55,"positivados":22}` com a rede desligada,
 *      indistinguível de leitura de verdade. O irmão (#1892, `MixGapCard`) já tinha resolvido com
 *      `desatualizado` no payload + dedup por `estado:motivo`; este sensor não herdou. Agora os
 *      dois saem da MESMA `motivoNaSerie` (`@/lib/leitura/serie`).
 *      A repartição: **`estado` descreve o DADO, `desatualizado` descreve o FRESCOR.** Com número
 *      em mãos o estado é `'pronta'` mesmo que o refetch tenha falhado — e o número REAL vai
 *      junto, porque é o que o vendedor está olhando; o que muda é que a série sabe que ele é
 *      velho. `'erro'`/`'sem-rede'` ficam para quando não há número nenhum, e aí sim tudo `null`.
 *      A dedup precisa do motivo na chave, senão engole a transição "número fresco" → "número
 *      velho", que é justamente o sinal de leitura falhando em campo.
 *      ⚠️ E `desatualizado` não cobria a REVALIDAÇÃO: com `gcTime` de 15min, voltar a uma tela já
 *      visitada entrega cache de até 15 minutos como `success` + `fetching`, que `estadoDeLeitura`
 *      chama de 'pronta'. Daí `revalidando` no payload (e os NÚMEROS na chave, para que o valor
 *      corrigido chegue à série em vez de morrer na dedup).
 *
 * NÃO alinhado de propósito: o `estado` deste evento continua `'sem-rede'` (hifenizado) enquanto o
 * do irmão é `'aguardando_rede'`. São eventos DIFERENTES, cada um com histórico próprio no
 * PostHog; renomear agora partiria a série em duas que ninguém soma depois. O que precisava ser
 * comum — a disciplina de dedup e o alfabeto do campo NOVO `desatualizado` — está comum.
 */
type EstadoSinal = 'pronta' | 'erro' | 'sem-rede';

export function useSinalPositivacao(): EstadoSinal | null {
  const query = useMyPositivacao();
  const { data } = query;
  const leitura = estadoDeLeitura(query);
  const papel = useMyCommercialRole();
  const { isImpersonating, effectiveUserId } = useImpersonation();

  // `data === null` é a RPC dizendo "você não é staff" (ela retorna NULL sem uid/sem role) — a
  // RESPOSTA, não um estado de leitura, e por isso não sai do helper. `undefined` não é sinônimo
  // (é pendente, pausada ou sem rede). `carregando` e `desabilitada` também não são desfecho:
  // nada a medir ainda. Só emite quem chegou a um DESFECHO. Mesma ordem do irmão.
  const temDado = data != null;
  const estado: EstadoSinal | null =
    data === null || leitura === 'desabilitada' || leitura === 'carregando'
      ? null
      : temDado
        ? 'pronta'
        : leitura === 'sem-rede'
          ? 'sem-rede'
          : leitura === 'erro'
            ? 'erro'
            : null;

  const desatualizacao = motivoNaSerie(query, temDado);
  const emRevalidacao = revalidando(query, temDado);

  // Só `'pronta'` autoriza tratar o papel como fato; fora dela o rótulo é `null` (A1).
  const isHunter: boolean | null = papel.estado === 'pronta' ? papel.data === 'hunter' : null;
  const mes = temDado ? data.mes : null;
  const positivados = temDado ? data.positivados : null;
  const totalEligible = temDado ? data.totalEligible : null;

  const emitidas = useRef<Set<string>>(new Set());
  useEffect(() => {
    // A CHAVE É TUDO O QUE O PAYLOAD AFIRMA COMO FATO — essa é a regra, e ela vem de três
    // correções que o /codex derrubou uma a uma no fix anterior:
    //   · sujeito, senão o ref sobrevive à troca de alvo da lente e a adoção do ALVO some (A2);
    //   · motivo, senão a dedup engole "número fresco" → "número velho" (A3);
    //   · `is_hunter`, senão o rótulo lido de um cache velho fica gravado PARA SEMPRE e a
    //     correção que chega depois é descartada;
    //   · os NÚMEROS, senão o cache que estava sendo revalidado sai e o valor corrigido nunca
    //     chega à série (com `gcTime` de 15min isso é a rotina de quem volta a uma tela).
    // Um SET por montagem (e não um slot único) é o que impede o ciclo A→B→A de reemitir A e
    // inflar `count()`: cada asserção distinta sai UMA vez, e transições continuam passando
    // porque a chave delas é outra.
    if (!estado) return;
    const chave = [
      effectiveUserId ?? 'sem-sujeito',
      estado,
      desatualizacao ?? 'fresco',
      emRevalidacao ? 'revalidando' : 'estavel',
      isHunter === null ? 'papel-desconhecido' : String(isHunter),
      mes ?? 'sem-mes',
      `${positivados}/${totalEligible}`,
    ].join('|');
    if (emitidas.current.has(chave)) return;
    emitidas.current.add(chave);
    track('carteira.positivacao_vista', {
      // Traduzido na fronteira: aqui dentro o estado é `'sem-rede'` (a língua do helper) e no
      // evento sai `sem_rede` (a língua da série, que o `carteira.mixgap_visto` já falava). O
      // `desatualizado` abaixo já passava pelo `motivoNaSerie`; este eixo não tinha tradutor.
      estado: estadoNaSerie(estado),
      mes,
      pct: temDado ? data.pctPositivacao : null,
      positivados,
      total_eligible: totalEligible,
      a_positivar: temDado ? data.aPositivar.length : null,
      is_hunter: isHunter,
      sob_lente: isImpersonating,
      desatualizado: desatualizacao,
      revalidando: emRevalidacao,
    });
  }, [estado, data, temDado, desatualizacao, emRevalidacao, isHunter, mes, positivados,
      totalEligible, effectiveUserId, isImpersonating]);

  return estado;
}
