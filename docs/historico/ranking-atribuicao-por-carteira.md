# Ranking do Master pelo dono da carteira (2026-10-06)

**Problema.** O card "Ranking de vendedores · mês" creditava a venda ao `created_by`. Na importada
(`hash_payload 'omie_*'`) esse campo é o carimbo técnico do `omie-vendas-sync`: o 1º `profiles WHERE
is_employee`, com `LIMIT 1` e sem `ORDER BY`. Em set+out/26 isso deu 589 pedidos e R$ 592.547,12, 100% numa farmer
só. O tile "vendedores ativos" contava a mesma farmer como ativa sem ela ter lançado nada.

**Régua (decisão do founder).** A venda vai para o dono ATUAL da carteira ELEGÍVEL do cliente, a mesma régua da
positivação e da cadeia de comissão. Dono sem papel de venda (master, pool órfão) aparece como "Carteira de
não-vendedor"; cliente sem carteira aparece como "Sem vendedor atribuído". A leitura acontece no front
(`fetchDonosCarteira`, lotes de 150, e falha lança).

**Antes → projeção da régua nova (set/26, 528 pedidos válidos, R$ 533.890,89).** Os números da régua nova vêm da
SQL do Apêndice A da spec, rodada na prod. O card em si é medido depois do Publish. Antes, 100% numa farmer só.
Pela régua nova: Regina 69,0% (332 ped.), Tatyana 27,4% (175 ped.), carteira de não-vendedor 3,7% (21 ped.) e sem
vendedor 0%.

**No ar (09/10/26).** O PR #2844 foi mergeado em 07/10 (`bd0c56e`). Depois do Publish, o bundle de `steu.lovable.app`
passou a conter "por dono da carteira". Às 16:33 de 09/10, o Apêndice A (01–09/10, todas as contas) deu Regina
R$ 77.058,07 (82 ped.), Tatyana R$ 31.582,55 (45 ped.), carteira de não-vendedor R$ 16.005,30 (8 ped.) e sem vendedor 0.
O card no Master, com o escopo "todas as empresas", mostrou os mesmos valores, ao centavo. Por conta, a SQL dá: Oben,
Regina R$ 70.472,57 (61), Tatyana R$ 22.684,51 (29) e não-vendedor R$ 5.864,30 (4); Colacor, Tatyana R$ 8.898,04 (16),
Regina R$ 6.585,50 (21) e não-vendedor R$ 10.141,00 (4). Bytes no ar provam que a versão está disponível, não que foi
adotada: cada cliente só passa a vê-la quando aceita a atualização do app.

**Lições.**
- `created_by` da importada é carimbo técnico, não autoria (→ `docs/agent/database.md`).
- Comentário em edge instrumentada não é "zero deploy": o `sonda:fingerprint` faz hash dos bytes crus, e um
  comentário abriria pendência DIVERGE_P2. Lição de documentação vai para `docs/agent/`, não para a edge.
- Dois `Map<string, string>` posicionais trocam de lugar sem erro de tipo, por isso viraram um objeto nomeado.
- No harness de falsificação, `locale -a | grep -qx` sob `pipefail` sai 141: o `grep -q` encerra no 1º casamento e o produtor morre por SIGPIPE, o que inverte o teste (o `pt_BR.UTF-8` "não existia"). Sem pipe para `grep -q`: here-string.
- A revisão com contexto novo achou dois furos que a execução não viu. Primeiro, `commercial_roles` com `data` nula
  sem `error` virava destino: sem vendedores, tudo ia para "Carteira de não-vendedor". Segundo, o teste de falha da
  carteira só exigia "lançou algo". Toda leitura que DECIDE destino lança, inclusive a dos papéis; e o teste casa a
  marca do ramo.

**Prova.** vitest (TDD) e `scripts/falsificar-ranking-carteira.sh` (13 sabotagens, vermelho exato, `LC_ALL=C` e
`pt_BR.UTF-8`). Spec: `docs/superpowers/specs/2026-10-06-ranking-atribuicao-por-carteira-design.md`.
