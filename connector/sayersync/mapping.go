// mapping.go — mapeamento declarativo do schema esperado do SayerSystem.
//
// O mapeamento original foi escrito contra nomes FANTASIA (informados errado pelo
// suporte do fornecedor); o discovery de produção (2026-06-12) revelou o schema
// REAL (tabelas no singular: corante/embalagem/padraocor; colunas id/codigo/
// data_alteracao; fórmulas flat com qtd1..qtd6). Este arquivo resolve AMBOS:
//   - nomes de TABELA por candidatos (TableCandidates; primeiro que existir vence)
//   - nomes de COLUNA por candidatos (Candidates; idem)
//
// As entidades LÓGICAS mantêm os nomes antigos (corantes, embalagens, padracor...)
// para não quebrar o resto do código; só o nome FÍSICO resolve em rm.Tables.
//
// Colunas: o Validate resolve para o primeiro nome existente no schema real. Se
// nenhum candidato existir, a coluna entra no SchemaDiff como ausente
// (Required=true → falha; Required=false → aviso apenas).
//
// FORMULA tem duas formas possíveis ("dual shape"):
//   - flat: colunas corante1..corante6 + qtd1ml..qtd6ml (ou qtd1..qtd6) na própria
//     tabela — o schema REAL é flat em formula E formulaperson (FlatColsByTable)
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
	// Table é o nome LÓGICO da entidade (chave usada pelo resto do código:
	// rm.Resolved, HWM do state, contadores, payloads). Mantido mesmo quando o
	// nome físico difere (ex: lógico "corantes" → físico "corante").
	Table string
	// TableCandidates são os nomes FÍSICOS possíveis no PG (primeiro que existir
	// no information_schema vence). Vazio = usar Table como único candidato.
	TableCandidates []string
	Columns         map[string]ColMapping // chave = nome lógico; value = ColMapping
}

// ResolvedMapping é o resultado de Validate: nomes de colunas reais por tabela,
// mais metadados como FormulaShape e fingerprint.
type ResolvedMapping struct {
	// Resolved: entidade_lógica → colName_lógico → colName_real_no_pg
	Resolved map[string]map[string]string

	// Tables: entidade_lógica → nome FÍSICO da tabela no PG (ex: "corantes" → "corante").
	Tables map[string]string

	// FormulaShape detectado pelo Validate.
	FormulaShape FormulaShape

	// FlatColsByTable mapeia, POR entidade lógica ("formula"/"formulaperson"),
	// os slots "corante1..6" e "qtd1ml..6ml" para os nomes reais (flat shape).
	// Ex: FlatColsByTable["formula"]["qtd1ml"] == "qtd1" no schema real.
	FlatColsByTable map[string]map[string]string

	// ChildHasOrdem indica se a tabela filha formula_item tem a coluna "ordem"
	// (detection só exige id_formula/id_corante/qtd_ml). Quando false, a extração
	// dos itens não a seleciona (evita "column ordem does not exist") e deriva a
	// ordem pela sequência de leitura. Só relevante no shape child.
	ChildHasOrdem bool
}

// TableFor retorna o nome FÍSICO da tabela de uma entidade lógica
// (fallback: a própria entidade, para mapeamentos antigos/testes).
func (rm *ResolvedMapping) TableFor(entity string) string {
	if t := rm.Tables[entity]; t != "" {
		return t
	}
	return entity
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
// Os nomes de tabela e coluna são sempre lowercase. A ORDEM dos candidatos importa
// (primeiro que existir vence): o nome fantasia vem primeiro para compatibilidade,
// o nome REAL do SayerSystem em seguida.
func expectedMappings() []TableMapping {
	return []TableMapping{
		// ── produto ──────────────────────────────────────────────
		// Real: produto(id, codigo, descricao, ..., liberado, data_alteracao)
		{Table: "produto", Columns: map[string]ColMapping{
			"id_produto":       candidates("id_produto", "id"),
			"descricao":        col("descricao"),
			"codigo":           candidatesOpt("codigo"),
			"liberado":         colOpt("liberado"),
			"data_atualizacao": candidates("data_atualizacao", "data_alteracao"),
		}},

		// ── base ─────────────────────────────────────────────────
		// Real: base(id, id_produto, codigo, descricao, ..., liberado, data_alteracao)
		{Table: "base", Columns: map[string]ColMapping{
			"id_base":          candidates("id_base", "id"),
			"codigo":           candidatesOpt("codigo"),
			"descricao":        col("descricao"),
			"liberado":         colOpt("liberado"),
			"data_atualizacao": candidates("data_atualizacao", "data_alteracao"),
		}},

		// ── embalagens ───────────────────────────────────────────
		// Real: embalagem(id, descricao, conteudo, ...). ⚠️ "conteudo" vem POR ÚLTIMO:
		// se existir uma coluna volume_ml literal, ela é ml; "conteudo" é em LITROS
		// (ex: 0.810) — a conversão litros→ml acontece nos lookups/mapeadores.
		{Table: "embalagens", TableCandidates: []string{"embalagens", "embalagem"}, Columns: map[string]ColMapping{
			"id_emb":           candidates("id_emb", "id"),
			"descricao":        col("descricao"),
			"volume_ml":        candidates("volume_ml", "volume", "conteudo"),
			"liberado":         colOpt("liberado"),
			"data_atualizacao": candidates("data_atualizacao", "data_alteracao"),
		}},

		// ── produto_base_embalagem ────────────────────────────────
		// Real: produto_base_embalagem(id, id_produto, id_base, id_embalagem, ...).
		// ⚠️ id_produto é FK com candidato ÚNICO — NÃO incluir "id" (a tabela tem
		// ambos e "id" é a PK dela própria, não a FK do produto).
		{Table: "produto_base_embalagem", Columns: map[string]ColMapping{
			"id_produto":       col("id_produto"),
			"id_base":          col("id_base"),
			"id_emb":           candidates("id_emb", "id_embalagem"),
			"data_atualizacao": candidates("data_atualizacao", "data_alteracao"),
		}},

		// ── corantes ─────────────────────────────────────────────
		// Real: corante(id, codigo, descricao, ..., volume_ml, ..., liberado, data_alteracao).
		// corante.volume_ml já está em ML (não converter).
		{Table: "corantes", TableCandidates: []string{"corantes", "corante"}, Columns: map[string]ColMapping{
			"id_corante":       candidates("id_corante", "id"),
			"codigo":           candidatesOpt("codigo"),
			"descricao":        col("descricao"),
			"volume_ml":        candidatesOpt("volume_ml"),
			"liberado":         colOpt("liberado"),
			"data_atualizacao": candidates("data_atualizacao", "data_alteracao"),
		}},

		// ── preco_corante ─────────────────────────────────────────
		// ⚠️ NÃO existe no banco real (preços moram em outro lugar; v0.1.4).
		// TODAS as colunas opcionais → tabela ausente não falha o schema (só warnings).
		// Mapeamento mantido por forward-compat.
		{Table: "preco_corante", Columns: map[string]ColMapping{
			"id_corante":       candidatesOpt("id_corante", "id"),
			"custo":            candidatesOpt("custo", "preco", "valor"),
			"volume_ml":        candidatesOpt("volume", "volume_ml", "conteudo"),
			"data_atualizacao": candidatesOpt("data_atualizacao", "data_alteracao"),
		}},

		// ── preco_baseemb ─────────────────────────────────────────
		// ⚠️ NÃO existe no banco real (v0.1.4). Tudo opcional; ver preco_corante.
		{Table: "preco_baseemb", Columns: map[string]ColMapping{
			"id_produto":       candidatesOpt("id_produto"),
			"id_base":          candidatesOpt("id_base"),
			"id_emb":           candidatesOpt("id_emb", "id_embalagem"),
			"custo":            candidatesOpt("custo", "preco", "valor"),
			"imposto":          candidatesOpt("imposto", "imposto_pct", "aliquota"),
			"margem":           candidatesOpt("margem", "margem_pct"),
			"data_atualizacao": candidatesOpt("data_atualizacao", "data_alteracao"),
		}},

		// ── padracor ─────────────────────────────────────────────
		// Real: padraocor(id, id_subcolecao, codigo, descricao, ..., liberado, data_alteracao)
		{Table: "padracor", TableCandidates: []string{"padracor", "padraocor"}, Columns: map[string]ColMapping{
			"id_padraocor":     candidates("id_padraocor", "id"),
			"codigo":           candidatesOpt("codigo"),
			"descricao":        col("descricao"),
			"id_subcolecao":    colOpt("id_subcolecao"),
			"liberado":         colOpt("liberado"),
			"data_atualizacao": candidates("data_atualizacao", "data_alteracao"),
		}},

		// ── colecao ───────────────────────────────────────────────
		// Real: colecao(id, codigo, descricao, liberado, data_cadastro, data_alteracao)
		{Table: "colecao", Columns: map[string]ColMapping{
			"id_colecao": candidates("id_colecao", "id"),
			"codigo":     candidatesOpt("codigo"),
			"descricao":  col("descricao"),
			// data_atualizacao pode não existir na colecao (sem delta direto)
			"data_atualizacao": candidatesOpt("data_atualizacao", "data_alteracao"),
		}},

		// ── subcolecao ────────────────────────────────────────────
		// Real: subcolecao(id, id_colecao, codigo, descricao, liberado, data_*)
		{Table: "subcolecao", Columns: map[string]ColMapping{
			"id_subcolecao": candidates("id_subcolecao", "id"),
			"id_colecao":    col("id_colecao"),
			"codigo":        candidatesOpt("codigo"),
			"descricao":     col("descricao"),
			// data_atualizacao pode não existir
			"data_atualizacao": candidatesOpt("data_atualizacao", "data_alteracao"),
		}},

		// ── formula ───────────────────────────────────────────────
		// Real: formula(id, id_padraocor, id_produto, id_base, id_embalagem, ...,
		// liberado, corante1..6, qtd1..6, ..., data_alteracao).
		// Colunas base conhecidas; as de corantes/qtds dependem do shape (flat vs child).
		{Table: "formula", Columns: map[string]ColMapping{
			"id_padraocor": col("id_padraocor"),
			"id_produto":   col("id_produto"),
			"id_base":      col("id_base"),
			"id_emb":       candidates("id_emb", "id_embalagem"),
			// No real NÃO existe — a subcoleção vem da COR via lookup (padraocor.id_subcolecao).
			"id_subcolecao":    colOpt("id_subcolecao"),
			"liberado":         colOpt("liberado"),
			"data_atualizacao": candidates("data_atualizacao", "data_alteracao"),
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
		// Real: personcor(id, codigo_cor NOT NULL, descricao) — ⚠️ SEM NENHUMA coluna
		// de timestamp → data_atualizacao OPCIONAL (ExtractDelta cai no full-scan
		// automaticamente; a tabela é minúscula).
		{Table: "personcor", Columns: map[string]ColMapping{
			"id_padraocor":     candidates("id_padraocor", "id"),
			"codigo":           candidatesOpt("codigo", "codigo_cor"),
			"descricao":        col("descricao"),
			"data_atualizacao": candidatesOpt("data_atualizacao", "data_alteracao"),
		}},

		// ── formulaperson ─────────────────────────────────────────
		// Real: formulaperson(id, id_personcor NOT NULL, id_produto, id_base,
		// id_embalagem NOT NULL, ..., data_atualizacao, ..., qtd1..6, corante1..6).
		// ⚠️ ESTA tabela usa data_atualizacao (≠ data_alteracao das demais).
		{Table: "formulaperson", Columns: map[string]ColMapping{
			// Semântica: id da cor personalizada (FK → personcor.id no real).
			"id_padraocor":     candidates("id_padraocor", "id_personcor"),
			"id_produto":       col("id_produto"),
			"id_base":          col("id_base"),
			"id_emb":           candidates("id_emb", "id_embalagem"),
			"data_atualizacao": candidates("data_atualizacao", "data_alteracao"),
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
//   - *ResolvedMapping com os nomes reais das tabelas/colunas + FormulaShape detectado.
//   - *SchemaDiff com as divergências encontradas (pode ser non-nil mesmo com rm!=nil).
//   - error se a consulta ao banco falhar.
//
// Se SchemaDiff.OK == false, o ciclo de sync não deve prosseguir (fail-closed).
func Validate(ctx context.Context, db *sql.DB) (*ResolvedMapping, *SchemaDiff, error) {
	cols, err := tableColumns(ctx, db)
	if err != nil {
		return nil, nil, err
	}
	rm, diff := resolveMapping(cols)
	return rm, diff, nil
}

// resolveMapping é o núcleo PURO do Validate: resolve o mapeamento declarativo
// contra um snapshot de information_schema (tabela → coluna → existe).
// Separado para ser testável sem banco (os testes chamam ESTA função, não um espelho).
func resolveMapping(cols map[string]map[string]bool) (*ResolvedMapping, *SchemaDiff) {
	diff := &SchemaDiff{
		OK:        true,
		Missing:   make(map[string][]string),
		Warnings:  make(map[string][]string),
		ExtraInfo: make(map[string]string),
	}
	rm := &ResolvedMapping{
		Resolved:        make(map[string]map[string]string),
		Tables:          make(map[string]string),
		FormulaShape:    FormulaShapeUnknown,
		FlatColsByTable: make(map[string]map[string]string),
	}

	for _, tm := range expectedMappings() {
		// ── Resolve o nome FÍSICO da tabela (primeiro candidato existente vence) ──
		tableCands := tm.TableCandidates
		if len(tableCands) == 0 {
			tableCands = []string{tm.Table}
		}
		physical := ""
		for _, cand := range tableCands {
			if _, ok := cols[strings.ToLower(cand)]; ok {
				physical = strings.ToLower(cand)
				break
			}
		}
		if physical == "" {
			// Tabela ausente em TODOS os candidatos: required → fail-closed; opcional → aviso.
			for logicName, cm := range tm.Columns {
				if cm.Required {
					diff.Missing[tm.Table] = append(diff.Missing[tm.Table], logicName)
					diff.OK = false
				} else {
					diff.Warnings[tm.Table] = append(diff.Warnings[tm.Table], logicName)
				}
			}
			continue
		}
		rm.Tables[tm.Table] = physical

		tblCols := cols[physical]
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

	return rm, diff
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
// usa colunas achatadas (flat) ou tabela filha (child). O shape é ÚNICO e global
// (decidido pela tabela formula); no flat, os slots são resolvidos POR tabela
// (formula E formulaperson — o schema real tem corante1..6/qtd1..6 em AMBAS) e
// gravados em rm.FlatColsByTable.
func detectFormulaShape(cols map[string]map[string]bool, rm *ResolvedMapping) FormulaShape {
	if rm.FlatColsByTable == nil {
		rm.FlatColsByTable = make(map[string]map[string]string)
	}
	// Primeiro tenta a tabela filha formula_item.
	if fi, ok := cols["formula_item"]; ok && fi["id_formula"] && fi["id_corante"] && fi["qtd_ml"] {
		// Tabela filha encontrada com as colunas obrigatórias.
		// "ordem" é opcional (a extração deriva pela sequência se ausente).
		rm.ChildHasOrdem = fi["ordem"]
		return FormulaShapeChild
	}

	// Tenta a forma flat: pelo menos corante1 + qtd1ml (ou variantes) na tabela.
	// Resolve os slots contra CADA tabela de fórmula (nome FÍSICO resolvido).
	slotCandidates := flatFormulaSlotCandidates()
	for _, entity := range []string{"formula", "formulaperson"} {
		tblCols, ok := cols[rm.TableFor(entity)]
		if !ok {
			continue
		}
		for slotKey, cands := range slotCandidates {
			for _, cand := range cands {
				if tblCols[strings.ToLower(cand)] {
					if rm.FlatColsByTable[entity] == nil {
						rm.FlatColsByTable[entity] = make(map[string]string)
					}
					rm.FlatColsByTable[entity][slotKey] = strings.ToLower(cand)
					break
				}
			}
		}
	}
	// O shape global é decidido pela tabela formula (como sempre foi).
	if len(rm.FlatColsByTable["formula"]) > 0 {
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
