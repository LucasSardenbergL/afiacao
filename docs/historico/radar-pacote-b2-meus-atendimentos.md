# Radar, pacote B2: "Meus atendimentos" (2026-11-06)

**O que entrega.** No bloco "Sua fila de hoje" do `/radar`, a alternância **Fila | Meus atendimentos**. A segunda visão
mostra os leads que o vendedor assumiu e que continuam com ele: atendimento aberto, não expirado, dono = `auth.uid()`.
Cada linha já mostrava o vencimento no selo "com você até dd/mm" (`ChipAtendimento`), e o resumo do bloco diz
"N leads com você · o próximo vence em dd/mm". Antes disso, o vendedor que assumia um lead não tinha como voltar a ele,
a não ser procurando na fila.

## Desenho

- **O filtro fica no servidor, antes da paginação.** `radar_lista` ganha `p_so_meus boolean DEFAULT false`, como 22º
  argumento, por cima dos 21 do pacote C. O predicado é
  `e.cnpj IN (SELECT a.cnpj FROM public.radar_atendimentos_ativos() a WHERE a.eh_meu)`. Filtrar os 50 carregados no
  front daria **falso vazio**: os leads assumidos costumam estar fora da 1ª página. A prova P0 monta exatamente esse
  caso (os 5 do dono ficam fora dos 50 primeiros) e a P1 mostra que a visão traz os 5.
- **A regra do prazo não foi duplicada.** O conjunto vem de `radar_atendimentos_ativos()`, que já calcula a expiração
  na leitura (`private.radar_atendimento_expira_em`, a cadeia de toques) e já exclui o dono que perdeu a capability.
  As sabotagens `tabela_crua` e `tabela_sem_encerrado`, que leem a tabela diretamente, ficam vermelhas: a 1ª deixa
  passar o expirado e a 2ª o encerrado.
- **A visão usa filtros neutros** (`FILTROS_MEUS_ATENDIMENTOS`): inclui já-clientes, o Brasil todo, qualquer lote e
  leads sem contato. Só os descartados ficam de fora (o default da RPC). Um lead assumido continua do vendedor mesmo
  fora da região da fila. A amostra de controle não entra na visão.
- **A visão vai na URL (`?visao=meus`) e fica fora dos filtros e dos favoritos**, como o A6 fez com `vista`: entrar
  nela não muda o recorte da fila, e voltar devolve o recorte de antes. Visão e vista ficam no MESMO `useUrlState`,
  porque um único `set({ visao, vista })` evita a corrida entre dois setters (o `setSearchParams` funcional do
  react-router não compõe no mesmo tick). Entrar em "Meus atendimentos" a partir do mapa volta para a lista.
- **Na fila, a chave `p_so_meus` não vai** (fica `undefined` e o supabase-js a omite). A chamada da fila continua a
  de antes e **não depende da migration**. Sem a migration aplicada, só a visão nova falha, e o `EmptyState` de erro
  mostra o motivo (`Could not find the function…`), nunca um vazio.
- **O conjunto fica fresco.** Quando o conjunto dos meus em `radar_atendimentos_ativos` muda (assumir, liberar,
  vencer), a página invalida só as páginas da visão (7º elemento da `queryKey` = `'meus'`). Não mexi em
  `useRadarAtendimentos.ts`, que a sessão "atribuir lead" está alterando.

## Provas

- `db/test-radar-meus-atendimentos.sh` (PG17): parte do estado de prod (predecessoras, pacote C e as peças de
  atendimento EXTRAÍDAS LITERALMENTE de `20261029201200`, com o A0 conferindo os 3 md5 de prod). Aplica a migration
  real 2× e roda 27 asserts: E (`p_so_meus` omitido e `false` = antes, em 4 recortes), M (dono, renovado, expirado,
  encerrado, outro dono, dono sem acesso, vendedor sem nada), P (paginação), N (combina com os filtros), C (ACL) e
  F1/F2 (a PRE aborta com corpo divergente e sem `radar_atendimentos_ativos`). `--falsificar`: 10/10 sabotagens
  vermelhas, nos locales `C` **e** `pt_BR.UTF-8`.
- `src/pages/__tests__/RadarClientes.test.tsx`: 4 casos do B2 (filtros neutros + `soMeus` e volta à fila com o
  recorte; URL e mapa; vazio próprio e erro de migration ausente; releitura quando o conjunto muda). Falsificados com
  6 sabotagens na página, uma por vez, todas vermelhas e com o controle verde.
- `src/queries/__tests__/useRadarLista.regiao-contato.test.tsx`: `p_so_meus` só na visão, e os parâmetros neutros.

## Deploy

Migration manual `20261106212329_radar_lista_meus_atendimentos.sql` (o founder cola no SQL Editor e a validação
roda por psql-ro), depois o **Publish**. Ordem: a migration antes do Publish. Com o Publish antes, a fila funciona,
mas a visão nova mostra o erro de função até a migration entrar.

## Aplicada em prod (2026-11-06)

Pedido do founder ("cole você a migration"). Pelo `bun run db:aplicar` (commit `b5f20a5e7`, sha256 `eebc4fb9…`):
primeiro o ensaio, que rodou inteiro e fez ROLLBACK, depois o apply, **recibo #939**. A 2ª testemunha foi o psql-ro,
em outra conexão: ✅ md5 `c824ce104b6513307b6b027622c8fd50`, uma sobrecarga de `radar_lista`, ACL igual ao de antes
(authenticated e service_role executam; anon e PUBLIC não). No apply havia 0 atendimentos abertos em prod, então a
visão abre vazia até o vendedor do piloto assumir um lead. Falta só o **Publish**.
