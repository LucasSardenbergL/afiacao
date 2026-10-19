# SW ponte não promovia a release: o host pina o browser num deployment pelo cookie `__dpl`

**Data:** 2026-10-19 · **Área:** PWA / service worker ponte (`src/sw/`, `src/lib/pwa-atualizacao.ts`) · **Money-path:** não.

## Sintoma (medido na aba logada do founder, QA dos #3158/#3162)

O servidor (curl por fora) servia o entry `index-DNJHyL4m` (`__BUILD_SHA__ = 28080496`, a main); a aba rodava `index-D8govl0X` (`0153e797`). Caches: `afiacao-release-index-D8govl0X` 362 (promovida), `index-mb2_1diM` 360 (anterior) e **`index-DNJHyL4m` com SÓ 14 entradas**, que não cresciam em 8 s nem em 2 min. `registration.waiting` existia. O toast "Nova versão disponível" aparecia; clicar "Atualizar" fechava o toast e a aba continuava no build velho. Só desregistrar o SW + reload trouxe o build novo.

## O que foi descartado (com evidência)

- **Chunk ausente no CDN:** curl das **367** URLs do manifesto do `sw.js` servido → 367 × `200`, content-type certo (355 `text/javascript`, 2 css, 1 html, ícones), nenhum 404. O manifesto tem 3 URLs duplicadas (`favicon.ico`, `pwa-192`, `pwa-512`) — por isso a release completa tem 364 chaves, não 367; inofensivo (`faltantes` compara por URL).
- **Bug na lógica de progresso/promoção** (`executarPreparo`, `promover`): a release nova, registrada do zero depois do reparo, fechou em 364/364 e foi promovida. A lógica funciona quando a rede entrega o que o manifesto pede.
- **Diferença de `/` vs `/index.html` no host:** era só um Publish novo entre dois curls.

## Causa raiz (provada ao vivo, na mesma aba, com um Publish novo no ar)

Três leituras na aba do founder (com o SW novo `index-lxXxvm7h` já ATIVO, release em **365/367**, `problema: 'obsoleta'`, promovida presa):

| pedido | com cookies (`credentials: 'same-origin'`) | sem cookies (`credentials: 'omit'`) |
|---|---|---|
| `/index.html` | entry `DNJHyL4m`, `x-deployment-id: psr2.edb7c9b2…`, `cache-control: private, no-store` | entry `B6QCfAWT`, `x-deployment-id: psr2.ce4db336…`, `cache-control: no-cache, must-revalidate` |
| `/assets/index-lxXxvm7h.js` | **404** | 404 (já havia um Publish mais novo) |
| `/sw.js` | manifesto `B6QCfAWT` — **sempre o deployment mais novo** | — |
| `document.cookie` | contém o id do deployment velho no cookie **`__dpl`** | — |

Repetido no 4º Publish do dia (`index-BaM-tCGm`, commit `f040e4f0`), com o SW desse build já ativo e a release dele parada em **361**: entry `index-BaM-tCGm.js` → **404 com cookies, 200 (152 KB) sem**; `/index.html` com cookies → `index-DNJHyL4m` do deployment `edb7c9b2` (o pinado), sem cookies → `index-BaM-tCGm` do deployment `35104372` (o que o curl vê). Quatro builds, mesmo padrão: o cache pára sempre em "tudo menos entry e `index.html`".

Ou seja: o host do Lovable (Cloudflare na frente) **pina o browser num deployment** pelo cookie `__dpl` — todo pedido com cookie recebe HTML e assets DAQUELE deployment — mas entrega `/sw.js` sempre do mais novo. O ciclo:

1. O soft update acha o `sw.js` novo (manifesto do build N+1). Ele instala, ativa e começa o preparo.
2. O preparo buscava cada entrada com `credentials: 'same-origin'` → cookie `__dpl` → deployment N → o **entry** do build N+1 responde **404** (posição 1 do manifesto) → `FimDoPreparo('obsoleta')`; o `index.html` vem do build N → `htmlEhDaRelease` recusa → `obsoleta` de novo.
3. As entradas que fecham são as reaproveitáveis de outro cache do aparelho + as de revisão que existem igual no deployment velho (ícones, `push-sw.js`): com 4 workers, isso dá os **14**. O resto é 404 em todo gatilho.
4. O cookie só se renova numa navegação que chega à rede — e a navegação é servida do cache pelo próprio SW. **Deadlock** até desregistrar o SW (a navegação vai à rede, o host grava `__dpl` novo, e o build novo chega).
5. `obsoleta` é, por desenho, "há build mais novo no ar, o SW mais novo vem no próximo update" — a página mostra `baixando`, nunca `falhou`. Aqui o SW JÁ era o mais novo: um `obsoleta` que nunca se resolve.

**O toast que mentia:** `derivar()` dava `pronta` só porque `reg.waiting && reg.active` — um segundo SW ponte em waiting (segurado pelos eventos pendentes do ativo; ele já pediu `skipWaiting`). Medido: o SW novo ficou em `installed` por ~60–90 s com a página ativa e ativou sozinho quando o ativo ficou ocioso — transitório, não é a causa. "Atualizar" postava `SKIP_WAITING`, que o SW ponte ignora, e esperava um `controllerchange` que não vinha: fechava o toast e não fazia nada.

## Correção

- `src/sw/releases.ts` · `opcoesDeBusca(e)`: o preparo busca **sem cookies** (`credentials: 'omit'`; o modo de cache segue por tipo). Sem cookie o pedido cai no deployment atual — o mesmo que entregou o `sw.js`. Teste: unidade + leitura de `sw.ts` como texto (nenhum `credentials: 'same-origin'`).
- `src/lib/pwa-atualizacao.ts` · `derivar()`: com o SW ponte publicando estado, a fase vem **só** de `faseDaPagina`; o ramo `reg.waiting` fica para o SW à moda antiga (que não publica estado). `aplicadorPadrao`: se o waiting não assume em 1,5 s, recarrega mesmo assim (a navegação recebe o HTML promovido). `lerCarimbosDoServidor` ("Verificar agora") também sem cookies — com cookie o "servidor" era o deployment pinado e "em dia" virava mentira.

## O que NÃO foi feito (e por quê)

- Não se tenta renovar o cookie `__dpl` a partir do SW (sem Cookie Store, fora do escopo); o cookie velho continua no browser e pina as requisições de runtime da página velha no deployment dela — o que, para a página velha, é o comportamento certo.
- O 14 do incidente original não foi reproduzido um a um (o deployment velho já foi retirado); a contagem é consistente com a ordem do manifesto e os 4 workers, e o mecanismo (entry 404 com cookie, 200 sem) foi medido no Publish seguinte, na mesma aba.

## Lição

- **Medir "o que o servidor serve" com curl não é medir o que o BROWSER recebe** quando o host roteia por cookie. Toda sonda de "disponibilidade" (`verify-frontend.sh`, `lerCarimbosDoServidor`) mede o deployment padrão; o cliente pinado pode ver outro. Prova pelo browser: mesmo pedido com `credentials: 'omit'` e `'same-origin'`, comparando `x-deployment-id`.
- Veredito `obsoleta` (404) só é "virá SW mais novo" se o 404 vier do deployment que entregou o `sw.js`.

## Verificado em prod (2026-10-19, Chrome real, aba logada do founder)

Publish do Lovable às ~15:05Z (clique do founder no editor; o `deploy_project` pelo MCP foi negado pelo classificador de deploy de produção). Build publicado `2f16e2cb` (contém o `54f3ced22` do #3181). Medição na aba do grupo MCP do Claude-in-Chrome, mesma origem/perfil da aba logada — a página montou em `/` já autenticada.

**Pré-condição provada:** `curl -s https://steu.lovable.app/sw.js` passou de `credentials:"same-origin"` 1× / `"omit"` 0× (deployment `7c7845e9`) para `"omit"` 1× (deployment `33b51d44`) na primeira leitura após o clique. `monitor-deploy.sh --pr 3181` antes do Publish: `PR_FORA_DO_AR`, ar `9e9c340c`, `PR_TOCA_O_BUNDLE` (sw.ts, releases.ts, pwa-atualizacao.ts).

**Antes do Publish (o sintoma, ainda com o SW velho no ar):**

| item | valor |
|---|---|
| ESTADO (MessageChannel) | promovida `index-DNJHyL4m` · release do SW rodando `index-CiJBrr63` · progresso `null` · problema `null` |
| cache da release do SW rodando | `afiacao-release-index-CiJBrr63` = **361** chaves, nunca promovida |
| página | entry `index-DNJHyL4m`, `__BUILD_SHA__=28080496` (03:01Z, anterior ao #3181) |
| `x-deployment-id` de `/` com cookie / sem cookie | `edb7c9b2` (entry `DNJHyL4m`) / `7c7845e9` (entry `eEtNvdDs`) |
| caches `afiacao-release-*` retidos | 6 (D8govl0X 362 · DNJHyL4m 364 · lxXxvm7h 362 · B6QCfAWT 362 · BaM-tCGm 361 · CiJBrr63 361) |

**Depois do Publish (um reload da aba, sem desregistrar nada — `getRegistrations().length` = 1, mesmo `scriptURL`):**

| instante | leitura |
|---|---|
| 15:06:15Z (~1 min após o reload) | release `index-Ccbc8fVo` em preparo: progresso **251/367**, cache `afiacao-release-index-Ccbc8fVo` = 251, promovida ainda `DNJHyL4m` |
| 15:06:40Z | **promovida = `index-Ccbc8fVo`**, progresso `null`, cache = **364** chaves; meta `anteriores` = `[DNJHyL4m, D8govl0X]`; toast "Nova versão disponível · Atualizar" na tela |
| 15:07:36Z (clique em "Atualizar" + ≤7 s) | `navigation.type = reload`, entry **`/assets/index-Ccbc8fVo.js`**, `__BUILD_SHA__=2f16e2cb`, toast sumiu, `reg.waiting = false` |
| 15:07:59Z | `/` com cookie: **ainda** `edb7c9b2` / entry `DNJHyL4m`; sem cookie: `33b51d44` / `Ccbc8fVo`; `/sw.js`: `33b51d44` |

Total do manifesto: **367 entradas, 364 URLs únicas** (`favicon.ico`, `pwa-192x192.png` e `pwa-512x512.png` aparecem 2×) — o cache fecha em 364, não em 367; o `progresso.total` reporta 367 porque conta entradas. Caches retidos após a promoção: **3** (D8govl0X 362 · DNJHyL4m 364 · Ccbc8fVo 364) — os 5 intermediários (lxXxvm7h, B6QCfAWT, BaM-tCGm, CiJBrr63 e o parcial eEtNvdDs em 209) foram removidos pela própria promoção.

**Leituras:**

- O fix fecha o laço: o SW novo preparou a release inteira em ~1,5 min (antes parava em 361/364 e virava `obsoleta` em loop), promoveu sem desregistrar e a página trocou de entry no clique.
- O cookie `__dpl` continua pinando o **host**: a navegação `/` com cookie segue devolvendo o HTML do deployment velho mesmo depois do Publish. O que o usuário recebe é o HTML da release promovida servido pelo SW — sem o SW ponte, o browser pinado continuaria no build velho até o cookie expirar. É por isso que a prova tem de ser lida no browser, não no curl.
- A última linha "sem o fix" da versão original deste doc continua certa: o build velho no ar era `28080496`, mais de 11 h atrás do Publish, com 6 caches de release acumulados — o custo do bug era disco e adoção zero.
