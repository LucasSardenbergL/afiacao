// sentinela_corante_zero_test.go — CONTRATO da sentinela de slot livre '0'/0.
//
// O FATO (medido em prod via psql-ro, 2026-07-21): a fonte SayerSystem grava, em
// fórmulas PERSONALIZADAS, os slots LIVRES como id_corante='0' + qtd_ml=0. O corante
// '0' NÃO existe no cadastro (ids reais: 1..5, 8..16). Medição na janela do binário
// fiel 0.2.0 (subiu 09:44): personalizada=true → 35/35 fórmulas (100%) com o padrão;
// personalizada=false → 0/64 (0%), com o confundidor de produto descartado (FO10.6554
// aparece nos DOIS lados). O nº de '0' = 6 − corantes reais (não é "slot 6").
//
// Sem tratamento, o conector emite '0' como corante presente (string não-vazia) e o
// Guard 4 barra a fórmula INTEIRA → cor personalizada nova nunca entra no catálogo
// (medido: 0 promoções desde 09:44; CAFELATTE ARAUCO ZAMBALD promovia OK em 14/07).
//
// Por que isto NÃO afrouxa o transporte fiel da Fase 1d: a fonte tem DUAS grafias
// para a MESMA semântica "slot livre" — {vazio, nil/0} no catálogo padrão e {'0', 0}
// em personalizada. O conector já omitia a primeira (C29). Aqui ele passa a
// reconhecer a segunda, no MESMO escopo em que a evidência vale.
//
// Endurecimentos do challenge Codex xhigh (2026-07-21) fixados aqui:
//   - P1: 6 sentinelas NÃO podem virar is_base_pura=true (isso AUTORIZA limpeza de
//     receita no banco pela tríade da 1d). Omissão nunca vira afirmação positiva.
//   - P2: a regra é escopada a personalizada — fora dela '0' segue emitido e barrado
//     (é anomalia NOVA, que queremos ver).
//   - P1: '0' com dose ≠0 segue emitido (não é sentinela; o banco decide).
package main

import (
	"math"
	"testing"
)

// ──────────────────────────────────────────────────────────────
// A sentinela em fórmula PERSONALIZADA
// ──────────────────────────────────────────────────────────────

// Caso canônico medido: 5 corantes reais + slot 6 = {'0', 0}.
func TestSentinela_PersonalizadaOmiteSlotLivre(t *testing.T) {
	rows := []map[string]any{makeFormulaRow(map[int][2]any{
		1: {"1", float64(0.385)},
		2: {"2", float64(20.794)},
		3: {"3", float64(0.462)},
		4: {"5", float64(25.8)},
		5: {"11", float64(9.242)},
		6: {"0", float64(0)}, // sentinela de slot livre
	})}
	itens := aggregateFlatFormulaItems(rows, testFlatCols(), true)[0]["itens"].([]map[string]any)
	if len(itens) != 5 {
		t.Fatalf("esperava 5 itens (sentinela omitida), veio %d: %v", len(itens), itens)
	}
	for _, it := range itens {
		if it["id_corante"] == "0" {
			t.Fatalf("sentinela '0' não deveria ser emitida: %v", it)
		}
	}
}

// Cores novas medidas (4602081, CAFELATTE): 3 corantes reais + slots 4,5,6 sentinela.
// Fixa que NÃO é "slot 6" — é todo slot livre.
func TestSentinela_PersonalizadaOmiteTodosOsSlotsLivres(t *testing.T) {
	rows := []map[string]any{makeFormulaRow(map[int][2]any{
		1: {"1", float64(5.776)},
		2: {"2", float64(15.403)},
		3: {"11", float64(3.081)},
		4: {"0", float64(0)},
		5: {"0", float64(0)},
		6: {"0", float64(0)},
	})}
	itens := aggregateFlatFormulaItems(rows, testFlatCols(), true)[0]["itens"].([]map[string]any)
	if len(itens) != 3 {
		t.Fatalf("esperava 3 itens reais, veio %d: %v", len(itens), itens)
	}
}

// ──────────────────────────────────────────────────────────────
// Os limites da regra (fail-closed)
// ──────────────────────────────────────────────────────────────

// ESCOPO (P2 Codex): em fórmula PADRÃO a evidência não vale (0/64 medido) → '0' é
// anomalia nova e tem de ser emitida para o Guard 4 barrar e DENUNCIAR.
func TestSentinela_NaoAplicaEmFormulaPadrao(t *testing.T) {
	rows := []map[string]any{makeFormulaRow(map[int][2]any{
		1: {"1", float64(5)},
		6: {"0", float64(0)},
	})}
	itens := aggregateFlatFormulaItems(rows, testFlatCols(), false)[0]["itens"].([]map[string]any)
	if len(itens) != 2 {
		t.Fatalf("fórmula padrão: '0' deve seguir emitido; esperava 2 itens, veio %d: %v", len(itens), itens)
	}
}

// P1 Codex: dose ≠0 NÃO é sentinela — pode ser componente real mal gravado.
func TestSentinela_DoseNaoZeroSegueEmitida(t *testing.T) {
	rows := []map[string]any{makeFormulaRow(map[int][2]any{
		1: {"1", float64(5)},
		6: {"0", float64(7.5)},
	})}
	itens := aggregateFlatFormulaItems(rows, testFlatCols(), true)[0]["itens"].([]map[string]any)
	if len(itens) != 2 {
		t.Fatalf("'0' com dose ≠0 deve seguir emitido; veio %d: %v", len(itens), itens)
	}
}

// Dose ILEGÍVEL com id '0': ambíguo (não prova dose 0) → emite com qtd nil e o
// ramo [1d-E] do Guard 4 barra. "Ausente ≠ zero" também vale para a sentinela.
func TestSentinela_DoseIlegivelSegueEmitida(t *testing.T) {
	rows := []map[string]any{makeFormulaRow(map[int][2]any{
		1: {"1", float64(5)},
		6: {"0", "lixo##"},
	})}
	itens := aggregateFlatFormulaItems(rows, testFlatCols(), true)[0]["itens"].([]map[string]any)
	if len(itens) != 2 {
		t.Fatalf("'0' com dose ilegível deve seguir emitido; veio %d: %v", len(itens), itens)
	}
	if itens[1]["qtd_ml"] != nil {
		t.Fatalf("dose ilegível deve virar nil, nunca 0: %v", itens[1])
	}
}

// Dose AUSENTE (nil) com id '0': idem — nil não prova zero.
func TestSentinela_DoseNilSegueEmitida(t *testing.T) {
	rows := []map[string]any{makeFormulaRow(map[int][2]any{
		1: {"1", float64(5)},
		6: {"0", nil},
	})}
	itens := aggregateFlatFormulaItems(rows, testFlatCols(), true)[0]["itens"].([]map[string]any)
	if len(itens) != 2 {
		t.Fatalf("'0' com dose nil deve seguir emitido; veio %d: %v", len(itens), itens)
	}
}

// Canonicalização: a regra casa o ID que ESTE código emitiria como "0". Um ID que
// stringifica diferente (" 0 " com espaços) NÃO é a sentinela → segue emitido.
// Fail-closed por construção — evita que variação de tipo/driver amplie a exceção.
func TestSentinela_IdNaoCanonicoSegueEmitido(t *testing.T) {
	rows := []map[string]any{makeFormulaRow(map[int][2]any{
		1: {"1", float64(5)},
		6: {" 0 ", float64(0)},
	})}
	itens := aggregateFlatFormulaItems(rows, testFlatCols(), true)[0]["itens"].([]map[string]any)
	if len(itens) != 2 {
		t.Fatalf("' 0 ' não é a sentinela canônica; deve seguir emitido; veio %d: %v", len(itens), itens)
	}
}

// ──────────────────────────────────────────────────────────────
// P1 do Codex: omissão NUNCA vira afirmação positiva de base pura
// ──────────────────────────────────────────────────────────────

// O achado bloqueante: se os 6 slots forem sentinela, omitir todos deixaria
// len(itens)==0 → is_base_pura=true → a TRÍADE da Fase 1d AUTORIZA o banco a LIMPAR
// a receita existente (até o cap de 50/24h). Uma fotografia transitória de cor
// personalizada em cadastro viraria destruição de receita. Sentinela vista ⇒ veto.
func TestSentinela_TodosSlotsSentinela_NaoDeclaraBasePura(t *testing.T) {
	rows := []map[string]any{makeFormulaRow(map[int][2]any{
		1: {"0", float64(0)},
		2: {"0", float64(0)},
		3: {"0", float64(0)},
		4: {"0", float64(0)},
		5: {"0", float64(0)},
		6: {"0", float64(0)},
	})}
	out := aggregateFlatFormulaItems(rows, testFlatCols(), true)[0]
	if _, declarou := out["is_base_pura"]; declarou {
		t.Fatalf("6 sentinelas NÃO provam base pura — declarar autoriza limpeza de receita: %v", out["is_base_pura"])
	}
}

// Contraprova: base pura LEGÍTIMA (slots realmente vazios) segue declarada. Sem este
// assert, o veto acima poderia ser implementado como "nunca declarar" e passar.
func TestSentinela_BasePuraLegitimaSeguePreservada(t *testing.T) {
	rows := []map[string]any{makeFormulaRow(map[int][2]any{})}
	out := aggregateFlatFormulaItems(rows, testFlatCols(), true)[0]
	if out["is_base_pura"] != true {
		t.Fatalf("6 slots vazios de verdade seguem provando base pura; veio %v", out["is_base_pura"])
	}
}

// Mistura: sentinela + slot vazio, sem corante real. Ainda assim vetado — a presença
// da sentinela torna o vazio ambíguo (a fonte estava escrevendo aquela fórmula).
func TestSentinela_MisturadaComVazio_NaoDeclaraBasePura(t *testing.T) {
	rows := []map[string]any{makeFormulaRow(map[int][2]any{
		1: {"0", float64(0)},
	})}
	out := aggregateFlatFormulaItems(rows, testFlatCols(), true)[0]
	if _, declarou := out["is_base_pura"]; declarou {
		t.Fatalf("sentinela presente ⇒ nunca declarar base pura: %v", out["is_base_pura"])
	}
}

// ──────────────────────────────────────────────────────────────
// Finitude de toFloat64OK (P2 Codex, pré-existente)
// ──────────────────────────────────────────────────────────────

// parseFloatStr rejeita NaN/Inf, mas float64/float32/pgtype.Numeric retornavam
// (n, true) direto. NaN/Inf num item fazem json.Marshal REJEITAR O LOTE INTEIRO
// (api.go) — não é rejeição por fórmula, é o ciclo do balcão parando.
func TestToFloat64OK_RejeitaNaNInfEmFloatNativo(t *testing.T) {
	nan := math.NaN()
	inf := math.Inf(1)
	ninf := math.Inf(-1)
	casos := []struct {
		nome string
		in   any
	}{
		{"float64 NaN", nan},
		{"float64 +Inf", inf},
		{"float64 -Inf", ninf},
		{"float32 NaN", float32(nan)},
		{"float32 +Inf", float32(inf)},
	}
	for _, c := range casos {
		if v, ok := toFloat64OK(c.in); ok {
			t.Errorf("%s: esperava (0,false), veio (%v,true)", c.nome, v)
		}
	}
}

// Contraprova: float finito segue aceito (o fix não pode rejeitar dose válida).
func TestToFloat64OK_FloatFinitoSegueAceito(t *testing.T) {
	if v, ok := toFloat64OK(float64(5.16)); !ok || v != 5.16 {
		t.Fatalf("float finito deve ser aceito; veio (%v,%v)", v, ok)
	}
	if v, ok := toFloat64OK(float64(0)); !ok || v != 0 {
		t.Fatalf("zero é dose legível (e é a sentinela); veio (%v,%v)", v, ok)
	}
}
