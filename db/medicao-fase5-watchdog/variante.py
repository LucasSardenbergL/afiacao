#!/usr/bin/env python3
"""TEMPORÁRIO — sai do branch antes do PR. Ablação da prova consertada: remove UMA camada.
  sem-indices  tira os dois índices de prod do fixture
  sem-analyze  tira o ANALYZE após o seed
Âncora única ou ABORTA (ablação que não aplicou mediria a prova inteira sob outro nome)."""
import sys
src, dst, qual = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(src).read()
def troca(b, t):
    global s
    n = s.count(b)
    if n != 1:
        sys.exit("ANCORA com %d ocorrencias: %r" % (n, b[:80]))
    s = s.replace(b, t)
if qual == "sem-indices":
    troca("CREATE INDEX idx_tint_formulas_busca_cor ON public.tint_formulas USING btree (account, sku_id, cor_id);\n", "")
    troca(",\n  CONSTRAINT tint_formula_itens_formula_id_corante_id_key UNIQUE (formula_id, corante_id));", ");")
elif qual == "sem-analyze":
    troca('P -q -c "ANALYZE;"\n', "")
else:
    sys.exit("variante desconhecida: " + qual)
open(dst, "w").write(s)
sys.stderr.write("variante %s: %s\n" % (qual, dst))
