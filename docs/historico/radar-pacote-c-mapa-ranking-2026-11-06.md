# Radar, pacote C: mapa, ranking de cidades e penetração (2026-11-06)

**Contexto.** O Radar segue sem uso humano (0 contatos em 60 dias). O founder vai fazer um piloto com um
vendedor. O Codex (xhigh) e o Fable revisaram a main em `17e6ab2fa` e separaram as melhorias em 4 pacotes.
Este é o C: o território (mapa, "Onde caçar" e penetração) passa a ver o mesmo recorte da fila. Os pacotes A
e B (fila e entrada do vendedor) e D (lead por e-mail e card) correm em sessões paralelas.

## O que entrou

| Achado | Conserto | Onde |
| --- | --- | --- |
| **C1** A penetração ignorava a região. Com o default da tela (região "atuação", UF vazia), a RPC recebia `p_uf=null` e devolvia os 500 maiores mercados do Brasil. Como o `ja_cliente` quase só cobre MG, a média ficava perto de 0 e "Mercado grande, pouca penetração" apontava PR e RS, fora da carteira. | `radar_penetracao_por_municipio` ganha `p_ufs`, com a mesma regra da contagem e da lista (UF escolhida vence a região, e a camada de concorrentes recorta igual). O hook usa `recorteDeUf`. | migration `20261106175800`, `useRadarPenetracaoMunicipios` |
| **C2** O clique numa cidade levava só o nome, com correspondência parcial. "Santa Luzia" trazia as homônimas de outras UFs (234 nomes de município se repetem entre UFs em `radar_municipios`, medido em prod), e clicar fora da região dava fila vazia. | `radar_lista` ganha `p_municipio_codigo`, filtro exato pelo código RFB de 4 dígitos (usa o `idx_radar_muni`). A URL ganha `municipioCodigo`, e o nome fica no campo como rótulo. `filtrosDaCidade` ajusta o recorte de forma explícita: troca a UF ou amplia a região para Brasil, e um toast diz o que mudou. Digitar no campo, trocar a UF ou trocar a região solta o código. A amostra segue o mesmo predicado. | migration, `useRadarLista`, `ui-helpers`, `amostra`, `RadarFiltros`, `RadarClientes` |
| **C3** "Só com telefone" valia para a lista e não para o ranking e o mapa. | `radar_contagem_por_municipio` ganha `p_com_telefone` nos 4 caminhos: agregado, fino, secundário coberto e vivo. O agregado já tinha `tem_telefone`, então o default continua sem ler `radar_empresas`. Em "só sugeridos", o filtro de telefone substitui o de contato, que fica redundante. | migration, `useRadarContagemMunicipios` |
| **C4** A soma de até 500 municípios aparecia como total de empresas, como se fosse um número nacional. | O ranking diz "nos N municípios exibidos {recorte}" e avisa quando bate no teto de 500. O mapa mostra quantos municípios estão desenhados. A penetração diz que o universo é o mercado do lote no recorte geográfico, em qualquer situação. | `RadarRankingCidades`, `RadarMapa` |
| **C5** As agregações do território disparavam junto com a 1ª página da fila. | O card "Onde caçar" só carrega quando entra na tela (IntersectionObserver; sem ele, carrega como antes) e depois que a fila assenta (`adiar={q.isPending}`). O mapa já ligava cada camada só quando visível. | `RadarRankingCidades`, `RadarClientes` |
| **C6** No mapa, o 1º toque abria o popup e já trocava para a lista. | O toque só abre o popup. A ação explícita "Ver empresas desta cidade" navega. O popup é montado com nós DOM (`textContent`), sem HTML cru. Saiu o `L.Icon.Default.mergeOptions`, que era código morto porque os pinos são `divIcon` e `circleMarker`. | `popupCidade.ts`, `RadarMapa` |

## C5: `useRadarIneditos` medido, sem mudança

O achado dizia que o `count exact` lia cerca de 500 mil linhas. Medido em prod pelo psql-ro em 2026-11-06,
com o lote 2026-10:

- o plano é **Index Only Scan** em `idx_radar_empresas_lote_vista` (criado em `20261103100000`), sobre 8.587
  linhas;
- a execução leva **1,08 s com cache frio** (716 páginas lidas do disco) e **4 ms quente** (2.623 buffers em
  cache);
- a policy de `radar_empresas` é `( SELECT private.cap_radar_prospectar(( SELECT auth.uid())) )`, ou seja, um
  initplan avaliado uma vez, sem custo por linha.

Não há o que consertar no hook. O custo a frio é o mesmo cache frio da instância Mini de 1 GB (D11).

## Decisões

- **Assinatura nova = DROP + CREATE, uma sobrecarga só.** Duas sobrecargas com os mesmos argumentos nomeados
  fariam o PostgREST acusar ambiguidade. O DROP reseta o ACL, então o `REVOKE ... FROM PUBLIC, anon` e o `GRANT
  ... TO authenticated, service_role` são reemitidos nomeando as roles. A PÓS confere as duas pontas.
- **Parâmetros novos no fim, com DEFAULT.** A chamada de antes devolve o mesmo, e a prova [E] confere isso nas
  três RPCs.
- **Código malformado grita (22023), não conta zero.** O front manda o código como veio da URL, e a RPC recusa
  o que não tiver 4 dígitos.
- **Penetração não aplica "só com telefone".** O denominador é o mercado, não a fila.
- **Coordenação.** A sessão A/B mexe em `RadarClientes.tsx` (fila, Próximo, `vista` fora dos filtros) e na
  copy de `RadarMapa.tsx`. As minhas edições ficaram em linhas diferentes. A migration do `p_dono` dela em
  `radar_lista` encadeia por cima desta, com o predecessor sendo o corpo `2cb7ad50…`.

## Provas

- `db/test-radar-mapa-regiao-cidade.sh` (PG17, no núcleo do CI, 37 asserts): parte do estado de prod (md5 dos
  3 corpos vivos) e aplica a migration real duas vezes. Cobre o que existia sem mudança, penetração por região
  contra um oráculo em SQL direto (concorrente só de PR some, UF vence a região), telefone nos 4 caminhos
  contra o oráculo (o agregado segue com 0 leituras de `radar_empresas`), cidade exata contra o oráculo (com o
  controle do defeito: o nome traz a homônima), negativos com SQLSTATE 22023 e a mensagem do ramo, ACL (anon
  42501) e PRE com corpo divergente (aborta antes de qualquer DROP). `--falsificar`: controle verde e **13/13
  sabotagens vermelhas** no assert declarado. Verde também com `LOCALE_TESTE=pt_BR.UTF-8`.
- vitest: hook da penetração (região → `p_ufs`), contagem (`p_com_telefone`, e em "só sugeridos" o `or` de
  telefone no lugar do de contato), `parametrosDaLista` (código vence o nome), `casaFiltrosExplicitos` (código
  exato), `filtrosDaCidade` (dentro do recorte, fora da região, UF diferente), ranking (clique com código,
  rótulo e teto, `adiar`, visibilidade) e `popupCidade` (só o botão navega, texto nunca vira HTML).

## Camadas de deploy

| Camada | Quem | Observação |
| --- | --- | --- |
| Migration `20261106175800` ✅ aplicada 2026-11-06 (recibo #936) | sessão, pelo envelope (`db:aplicar`: idempotente, PRE/PÓS, sem BEGIN/COMMIT) | **antes** do Publish: o front novo manda `p_ufs`, `p_com_telefone` e `p_municipio_codigo`, que a função velha não conhece (PGRST202) |
| Publish do Lovable | founder | depois da migration |
| Edge | nenhuma | |

## Aplicação em prod (2026-11-06)

PR #3676 mergeado antes, com o CI verde. Até a migration entrar, a main tinha o front novo e a prod as RPCs
velhas, então qualquer Publish nesse intervalo quebraria o `/radar` (PGRST202).

- **Pré-voo (psql-ro):** os 3 corpos vivos eram os predecessores que a PRE espera (`08af5a…`, `a9cdba…`,
  `7bd102…`). Os bytes do arquivo são idênticos aos da main (sha256 `e46c99f7…`).
- **Ensaio:** `db:aplicar --ensaio` rodou inteiro, PRE e PÓS, e fez ROLLBACK.
- **Apply:** `db:aplicar`, tentativa **#936**, que virou recibo na mesma transação.
- **2ª testemunha (psql-ro, depois do commit):** a query de validação do PR deu `OK pacote C aplicado`. As 3
  RPCs têm o md5 deste arquivo (`2351fb07…`, `4b3b6f0a…`, `2cb7ad50…`), há uma sobrecarga de cada, são SECURITY
  DEFINER STABLE, e `authenticated` executa mas `anon` não.
- **Falta:** o Publish do Lovable (founder). A migration do B2 (`p_so_meus` em `radar_lista`, sessão A/B)
  encadeia por cima, com predecessor `2cb7ad50…`.
