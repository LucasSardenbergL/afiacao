// mapping.go — mapeamento declarativo do schema esperado do SayerSystem.
//
// Os nomes de tabela são em maiúsculas conforme o manual da Dnaxis; o PostgreSQL
// os armazena em lowercase — Validate compara tudo em lowercase (case-insensitive).
//
// Colunas marcadas como "candidatas" têm nomes não-confirmados pela Dnaxis: o
// Validate resolve para o primeiro nome existente no schema real. Se nenhum
// candidato existir, a coluna entra no SchemaDiff como ausente (Required=true →
// falha; Required=false → aviso apenas).
//
// FORMULA tem duas formas possíveis ("dual shape"):
//   - flat: colunas corante1..corante6 + qtd1ml..qtd6ml na própria tabela formula
//   - child: tabela filha formula_item(id_formula, id_corante, ordem, qtd_ml)
//
// Validate detecta qual shape existe e preenche ResolvedMapping.FormulaShape.
//
// Spec: docs/superpowers/specs/2026-06-09-tint-sync-sayersystem-design.md §2.2 + §5
package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
)

// ──────────────────────────────────────────────────────────────
// Tipos de alto nível
// ──────────────────────────────────────────────────────────────

// FormulaShape descreve a estrutura da tabela FORMULA detectada em runtime.
type FormulaShape string

const (
	FormulaShapeUnknown FormulaShape = "unknown"
	FormulaShapeFlat    FormulaShape = "flat"  // colunas corante1..6 + qtd1ml..6ml
	FormulaShapeChild   FormulaShape = "child" // tabela filha formula_item
)

// ColMapping descreve uma coluna esperada, com candidatos e flag de obrigatoriedade.
type ColMapping struct {
	// Candidates são os nomes possíveis para a coluna (primeiro que existir é usado).
	// Quando há só 1 candidato, o nome é confirmado.
	Candidates []string
	// Required: se true e nenhum candidato existir → SchemaDiff.OK = false (fail-closed).
	// Se false → aviso apenas (coluna opcional ou v2).
	Required bool
}

// TableMapping descreve o mapeamento de uma tabela completa.
type TableMapping struct {
	Table   string                // nome da tabela (lowercase, como no PG)
	Columns map[string]ColMapping // chave = nome lógico; value = ColMapping
}

// ResolvedMapping é o resultado de Validate: nomes de colunas reais por tabela,
// mais metadados como FormulaShape e fingerprint.
type ResolvedMapping struct {
	// Resolved: table → colName_lógico → colName_real_no_pg
	Resolved map[string]map[string]string

	// FormulaShape detectado pelo Validate.
	FormulaShape FormulaShape

	// FlatFormulaCols mapeia "corante1..6" e "qtd1ml..6ml" para os nomes reais (flat shape).
	FlatFormulaCols map[string]string // ex: "corante1" → "corante1", "qtd1ml" → "qtd1"

	// ChildHasOrdem indica se a tabela filha formula_item tem a coluna "ordem"
	// (detection só exige id_formula/id_corante/qtd_ml). Quando false, a extração
	// dos itens não a seleciona (evita "column ordem does not exist") e deriva a
	// ordem pela sequência de leitura. Só relevante no shape child.
	ChildHasOrdem bool
}

// SchemaDiff descreve divergências entre o schema esperado e o real.
type SchemaDiff struct {
	// OK: false → fail-closed (colunas required ausentes).
	OK bool
	// Missing: colunas obrigatórias ausentes por tabela.
	Missing map[string][]string
	// Warnings: colunas opcionais ausentes por tabela.
	Warnings map[string][]string
	// ExtraInfo: informações adicionais (ex: shape detectado).
	ExtraInfo map[string]string
}

// ──────────────────────────────────────────────────────────────
// Mapeamento declarativo
// ──────────────────────────────────────────────────────────────

// col constrói um ColMapping com um único candidato confirmado.
func col(name string) ColMapping {
	return ColMapping{Candidates: []string{name}, Required: true}
}

// colOpt constrói um ColMapping opcional (ausência não falha o ciclo).
func colOpt(name string) ColMapping {
	return ColMapping{Candidates: []string{name}, Required: false}
}

// candidates constrói um ColMapping com múltiplos candidatos (nomes não confirmados).
func candidates(names ...string) ColMapping {
	return ColMapping{Candidates: names, Required: true}
}

// candidatesOpt constrói um ColMapping opcional com múltiplos candidatos.
func candidatesOpt(names ...string) ColMapping {
	return ColMapping{Candidates: names, Required: false}
}

// expectedMappings retorna o mapeamento declarativo completo do schema esperado.
// Os nomes de tabela e coluna são sempre lowercase.
func expectedMappings() []TableMapping {
	return []TableMapping{
		// ── produto ──────────────────────────────────────────────
		{Table: "produto", Columns: map[string]ColMapping{
			"id_produto":       col("id_produto"),
			"descricao":        col("descricao"),
			"data_atualizacao": col("data_atualizacao"),
		}},

		// ── base ─────────────────────────────────────────────────
		{Table: "base", Columns: map[string]ColMapping{
			"id_base":          col("id_base"),
			"descricao":        col("descricao"),
			"data_atualizacao": col("data_atualizacao"),
		}},

		// ── embalagens ───────────────────────────────────────────
		// "conteudo" é o nome mais provável segundo o manual; alternativas documentadas.
		{Table: "embalagens", Columns: map[string]ColMapping{
			"id_emb":           col("id_emb"),
			"descricao":        col("descricao"),
			"volume_ml":        candidates("conteudo", "volume", "volume_ml"),
			"data_atualizacao": col("data_atualizacao"),
		}},

		// ── produto_base_embalagem ────────────────────────────────
		{Table: "produto_base_embalagem", Columns: map[string]ColMapping{
			"id_produto":       col("id_produto"),
			"id_base":          col("id_base"),
			"id_emb":           col("id_emb"),
			"data_atualizacao": col("data_atualizacao"),
		}},

		// ── corantes ─────────────────────────────────────────────
		{Table: "corantes", Columns: map[string]ColMapping{
			"id_corante":       col("id_corante"),
			"descricao":        col("descricao"),
			"data_atualizacao": col("data_atualizacao"),
		}},

		// ── preco_corante ─────────────────────────────────────────
		// Nomes das colunas de custo e volume não confirmados pela Dnaxis.
		{Table: "preco_corante", Columns: map[string]ColMapping{
			"id_corante":       col("id_corante"),
			"custo":            candidates("custo", "preco", "valor"),
			"volume_ml":        candidates("volume", "volume_ml", "conteudo"),
			"data_atualizacao": col("data_atualizacao"),
		}},

		// ── preco_baseemb ─────────────────────────────────────────
		// Nomes de custo/imposto/margem não confirmados.
		{Table: "preco_baseemb", Columns: map[string]ColMapping{
			"id_produto":       col("id_produto"),
			"id_base":          col("id_base"),
			"id_emb":           col("id_emb"),
			"custo":            candidates("custo", "preco", "valor"),
			"imposto":          candidates("imposto", "imposto_pct", "aliquota"),
			"margem":           candidates("margem", "margem_pct"),
			"data_atualizacao": col("data_atualizacao"),
		}},

		// ── padracor ─────────────────────────────────────────────
		{Table: "padracor", Columns: map[string]ColMapping{
			"id_padraocor":     col("id_padraocor"),
			"descricao":        col("descricao"),
			"data_atualizacao": col("data_atualizacao"),
		}},

		// ── colecao ───────────────────────────────────────────────
		{Table: "colecao", Columns: map[string]ColMapping{
			"id_colecao": col("id_colecao"),
			"descricao":  col("descricao"),
			// data_atualizacao pode não existir na colecao (sem delta direto)
			"data_atualizacao": colOpt("data_atualizacao"),
		}},

		// ── subcolecao ────────────────────────────────────────────
		{Table: "subcolecao", Columns: map[string]ColMapping{
			"id_subcolecao": col("id_subcolecao"),
			"id_colecao":    col("id_colecao"),
			"descricao":     col("descricao"),
			// data_atualizacao pode não existir
			"data_atualizacao": colOpt("data_atualizacao"),
		}},

		// ── formula ───────────────────────────────────────────────
		// Colunas base conhecidas; as de corantes/qtds dependem do shape (flat vs child).
		{Table: "formula", Columns: map[string]ColMapping{
			"id_padraocor":     col("id_padraocor"),
			"id_produto":       col("id_produto"),
			"id_base":          col("id_base"),
			"id_emb":           col("id_emb"),
			"id_subcolecao":    colOpt("id_subcolecao"),
			"data_atualizacao": col("data_atualizacao"),
			// F5: PK da fórmula — só usada no shape CHILD para juntar com formula_item.id_formula.
			// Opcional porque o shape FLAT não precisa dela. A junção FALHA (itens vazios) se,
			// no shape child, nenhum candidato resolver (ver guarda em syncFormulas).
			"formula_pk": candidatesOpt("id_formula", "id", "codigo"),
			// Embalagem de FORMULAÇÃO: volume da embalagem em que o laboratório faz a fórmula.
			// A regra de 3 (no servidor) usa esse volume para expandir às embalagens vendáveis.
			// F4: o nome real não é confirmado — a Dnaxis disse "id_embalagem" numa resposta e a
			// lista de chaves trouxe "id_emb" em outra. Cobre ambos (+ id_embalagem_formulacao).
			// ⚠️ Se "id_emb" e "id_embalagem" coexistirem na origem, Validate avisa (ambíguo).
			"id_embalagem_formulacao": candidatesOpt("id_emb", "id_embalagem", "id_embalagem_formulacao"),
		}},

		// ── personcor ─────────────────────────────────────────────
		{Table: "personcor", Columns: map[string]ColMapping{
			"id_padraocor":     col("id_padraocor"),
			"descricao":        col("descricao"),
			"data_atualizacao": col("data_atualizacao"),
		}},

		// ── formulaperson ─────────────────────────────────────────
		{Table: "formulaperson", Columns: map[string]ColMapping{
			"id_padraocor":     col("id_padraocor"),
			"id_produto":       col("id_produto"),
			"id_base":          col("id_base"),
			"id_emb":           col("id_emb"),
			"data_atualizacao": col("data_atualizacao"),
			// F4: embalagem de formulação (ver nota em "formula"); cobre id_emb/id_embalagem.
			"id_embalagem_formulacao": candidatesOpt("id_emb", "id_embalagem", "id_embalagem_formulacao"),
			// F5: PK da fórmula personalizada (shape child). Opcional (flat não usa).
			"formula_pk": candidatesOpt("id_formulaperson", "id_formula", "id", "codigo"),
		}},

		// ── vendas e vendas_item (v2: mapeados para discovery, sem extração) ─────
		{Table: "vendas", Columns: map[string]ColMapping{
			"id_venda":     colOpt("id_venda"),
			"data_venda":   colOpt("data_venda"),
			"id_produto":   colOpt("id_produto"),
			"id_base":      colOpt("id_base"),
			"id_emb":       colOpt("id_emb"),
			"id_padraocor": colOpt("id_padraocor"),
		}},
		{Table: "vendas_item", Columns: map[string]ColMapping{
			"id_venda":   colOpt("id_venda"),
			"id_corante": colOpt("id_corante"),
			"qtd_ml":     colOpt("qtd_ml"),
		}},
	}
}

// flatFormulaSlotCandidates descreve os candidatos para cada slot de corante/qtd
// na forma flat da fórmula (corante1..6 / qtd1ml..6ml).
// Retorna (slotKey → []candidateNames).
func flatFormulaSlotCandidates() map[string][]string {
	out := make(map[string][]string, 12)
	for i := 1; i <= 6; i++ {
		k := fmt.Sprintf("corante%d", i)
		out[k] = []string{
			fmt.Sprintf("corante%d", i),
			fmt.Sprintf("id_corante%d", i),
		}
		qk := fmt.Sprintf("qtd%dml", i)
		out[qk] = []string{
			fmt.Sprintf("qtd%dml", i),
			fmt.Sprintf("qtd%d", i),
			fmt.Sprintf("qtd_%d", i),
			fmt.Sprintf("qtd%dml", i),
		}
	}
	return out
}

// ──────────────────────────────────────────────────────────────
// Validate
// ──────────────────────────────────────────────────────────────

// tableColumns carrega todas as colunas de todas as tabelas acessíveis de
// information_schema.columns (case-insensitive, só schema 'public').
func tableColumns(ctx context.Context, db *sql.DB) (map[string]map[string]bool, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT lower(table_name), lower(column_name)
		FROM information_schema.columns
		WHERE table_schema = 'public'
		ORDER BY table_name, ordinal_position
	`)
	if err != nil {
		return nil, fmt.Errorf("erro ao consultar information_schema.columns: %w", err)
	}
	defer rows.Close()

	out := make(map[string]map[string]bool)
	for rows.Next() {
		var tbl, col string
		if err := rows.Scan(&tbl, &col); err != nil {
			return nil, err
		}
		if out[tbl] == nil {
			out[tbl] = make(map[string]bool)
		}
		out[tbl][col] = true
	}
	return out, rows.Err()
}

// Validate consulta information_schema.columns e resolve o mapeamento declarativo
// contra o schema real do SayerSystem.
//
// Retorna:
//   - *ResolvedMapping com os nomes reais das colunas + FormulaShape detectado.
//   - *SchemaDiff com as divergências encontradas (pode ser non-nil mesmo com rm!=nil).
//   - error se a consulta ao banco falhar.
//
// Se SchemaDiff.OK == false, o ciclo de sync não deve prosseguir (fail-closed).
func Validate(ctx context.Context, db *sql.DB) (*ResolvedMapping, *SchemaDiff, error) {
	cols, err := tableColumns(ctx, db)
	if err != nil {
		return nil, nil, err
	}

	diff := &SchemaDiff{
		OK:        true,
		Missing:   make(map[string][]string),
		Warnings:  make(map[string][]string),
		ExtraInfo: make(map[string]string),
	}
	rm := &ResolvedMapping{
		Resolved:        make(map[string]map[string]string),
		FormulaShape:    FormulaShapeUnknown,
		FlatFormulaCols: make(map[string]string),
	}

	for _, tm := range expectedMappings() {
		tblCols, exists := cols[tm.Table]
		if !exists {
			// Tabela inteiramente ausente: verifica se havia colunas required.
			for logicName, cm := range tm.Columns {
				if cm.Required {
					diff.Missing[tm.Table] = append(diff.Missing[tm.Table], logicName)
					diff.OK = false
				}
			}
			continue
		}

		rm.Resolved[tm.Table] = make(map[string]string)
		for logicName, cm := range tm.Columns {
			resolved := ""
			for _, cand := range cm.Candidates {
				if tblCols[strings.ToLower(cand)] {
					resolved = strings.ToLower(cand)
					break
				}
			}
			if resolved == "" {
				if cm.Required {
					diff.Missing[tm.Table] = append(diff.Missing[tm.Table], logicName)
					diff.OK = false
				} else {
					diff.Warnings[tm.Table] = append(diff.Warnings[tm.Table], logicName)
				}
			} else {
				rm.Resolved[tm.Table][logicName] = resolved
			}
		}
	}

	// ── Detectar o shape da FORMULA ──────────────────────────────
	rm.FormulaShape = detectFormulaShape(cols, rm)
	diff.ExtraInfo["formula_shape"] = string(rm.FormulaShape)

	// ── F4: ambiguidade da embalagem de formulação ───────────────
	// A coluna de embalagem de formulação tem nome não-confirmado (id_emb vs id_embalagem).
	// Se ambas existirem fisicamente em formula/formulaperson, NÃO dá pra saber qual é a
	// vendável e qual é a de formulação só pelo nome → registra aviso (não falha o ciclo).
	noteFormulationAmbiguity(cols, "formula", diff)
	noteFormulationAmbiguity(cols, "formulaperson", diff)

	return rm, diff, nil
}

// noteFormulationAmbiguity grava um aviso em SchemaDiff.ExtraInfo quando a tabela
// tem AS DUAS colunas candidatas à embalagem de formulação (id_emb E id_embalagem),
// caso em que a semântica (vendável × formulação) é ambígua e precisa de discovery.
func noteFormulationAmbiguity(cols map[string]map[string]bool, table string, diff *SchemaDiff) {
	tc, ok := cols[table]
	if !ok {
		return
	}
	if tc["id_emb"] && tc["id_embalagem"] {
		diff.ExtraInfo[table+"_embalagem_ambigua"] =
			"id_emb e id_embalagem coexistem; confirmar qual é a embalagem de formulação (regra de 3)"
	}
}

// detectFormulaShape examina o schema para determinar se a tabela FORMULA
// usa colunas achatadas (flat) ou tabela filha (child).
func detectFormulaShape(cols map[string]map[string]bool, rm *ResolvedMapping) FormulaShape {
	// Primeiro tenta a tabela filha formula_item.
	if fi, ok := cols["formula_item"]; ok && fi["id_formula"] && fi["id_corante"] && fi["qtd_ml"] {
		// Tabela filha encontrada com as colunas obrigatórias.
		// "ordem" é opcional (a extração deriva pela sequência se ausente).
		rm.ChildHasOrdem = fi["ordem"]
		return FormulaShapeChild
	}

	// Tenta a forma flat: pelo menos corante1 + qtd1ml (ou variantes) na tabela formula.
	formulaCols, ok := cols["formula"]
	if !ok {
		return FormulaShapeUnknown
	}

	slotCandidates := flatFormulaSlotCandidates()
	foundFlat := false
	for slotKey, candidates := range slotCandidates {
		for _, cand := range candidates {
			if formulaCols[strings.ToLower(cand)] {
				rm.FlatFormulaCols[slotKey] = strings.ToLower(cand)
				foundFlat = true
				break
			}
		}
	}
	if foundFlat {
		return FormulaShapeFlat
	}

	return FormulaShapeUnknown
}

// ──────────────────────────────────────────────────────────────
// Fingerprint
// ──────────────────────────────────────────────────────────────

// ── tipos para Fingerprint (exportados para uso em testes) ─────────────────

// ColEntry representa uma coluna no payload de fingerprint.
type ColEntry struct {
	Logic string `json:"l"`
	Real  string `json:"r"`
}

// TableEntry representa uma tabela no payload de fingerprint.
type TableEntry struct {
	Table string     `json:"t"`
	Cols  []ColEntry `json:"c"`
}

// Fingerprint retorna um hash SHA-256 hex do ResolvedMapping normalizado.
// Garante que a mesma schema real → mesmo fingerprint (independente de ordem).
func Fingerprint(rm *ResolvedMapping) string {
	var tables []TableEntry
	for tbl, colMap := range rm.Resolved {
		te := TableEntry{Table: tbl}
		for logic, real := range colMap {
			te.Cols = append(te.Cols, ColEntry{Logic: logic, Real: real})
		}
		// Ordena colunas pelo nome lógico para determinismo.
		sortColEntries(te.Cols)
		tables = append(tables, te)
	}
	// Ordena tabelas pelo nome.
	sortTableEntries(tables)

	type fpPayload struct {
		Tables       []TableEntry `json:"tables"`
		FormulaShape string       `json:"formula_shape"`
	}
	payload := fpPayload{
		Tables:       tables,
		FormulaShape: string(rm.FormulaShape),
	}

	data, _ := json.Marshal(payload)
	sum := sha256.Sum256(data)
	return fmt.Sprintf("%x", sum)
}

// sortColEntries ordena in-place pelo campo Logic.
func sortColEntries(cols []ColEntry) {
	for i := 1; i < len(cols); i++ {
		for j := i; j > 0 && cols[j].Logic < cols[j-1].Logic; j-- {
			cols[j], cols[j-1] = cols[j-1], cols[j]
		}
	}
}

// sortTableEntries ordena in-place pelo campo Table.
func sortTableEntries(tables []TableEntry) {
	for i := 1; i < len(tables); i++ {
		for j := i; j > 0 && tables[j].Table < tables[j-1].Table; j-- {
			tables[j], tables[j-1] = tables[j-1], tables[j]
		}
	}
}
