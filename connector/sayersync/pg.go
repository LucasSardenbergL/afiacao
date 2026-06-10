// pg.go — funções de acesso ao PostgreSQL local do SayerSystem.
//
// Princípios:
//   - Conexões curtas: conecta, extrai, fecha. Sem pool persistente.
//   - client_encoding=UTF8: o SayerSystem pode gravar em Latin-1/Win-1252;
//     o PG converte na saída para evitar problemas de encoding no JSON.
//   - Timeout curto (10s): localhost — se não conectar rápido, algo está errado.
//   - ReadCommitted (default do PG): suficiente para leitura de delta.
//   - HWM = MAX(data_atualizacao) OBSERVADO no resultado — NUNCA now() do conector
//     (§11 P1-D: clock skew do PC do balcão não perde registro).
//
// Spec: docs/superpowers/specs/2026-06-09-tint-sync-sayersystem-design.md §5.3 + §11
package main

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib" // driver pgx para database/sql
)

// Connect abre uma conexão com o PostgreSQL do SayerSystem.
// Inclui client_encoding=UTF8 e timeout de 10s.
// O caller é responsável por fechar db.Close().
func Connect(ctx context.Context, connStr string) (*sql.DB, error) {
	// Injeta client_encoding=UTF8 se não estiver na string de conexão.
	// O PG converte a saída mesmo que os dados originais estejam em Latin-1/Win-1252.
	if !strings.Contains(connStr, "client_encoding") {
		if strings.Contains(connStr, "?") {
			connStr += "&client_encoding=UTF8"
		} else {
			connStr += "?client_encoding=UTF8"
		}
	}

	db, err := sql.Open("pgx", connStr)
	if err != nil {
		return nil, fmt.Errorf("Connect: erro ao abrir conexão: %w", err)
	}

	// Configurações conservadoras para conexão curta.
	db.SetMaxOpenConns(2)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(2 * time.Minute)

	// Valida a conexão com timeout de 10s.
	pingCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := db.PingContext(pingCtx); err != nil {
		db.Close()
		return nil, fmt.Errorf("Connect: falha ao conectar em %s: %w", sanitizeConnStr(connStr), err)
	}

	return db, nil
}

// ExtractDelta executa o SELECT de delta para uma entidade, com:
//   - WHERE data_atualizacao > hwm OR data_atualizacao IS NULL
//   - ORDER BY data_atualizacao ASC (para processar em ordem cronológica)
//   - HWM resultante = MAX(data_atualizacao) observado no resultado (relógio da ORIGEM)
//
// A aplicação da margem de 5min (hwm - 5min) é responsabilidade do CALLER,
// para manter a lógica de margem centralizada no sync.go.
//
// Parâmetros:
//   - rm: mapeamento resolvido (nomes reais das colunas)
//   - entity: nome da tabela (ex: "produto", "formula")
//   - hwm: high-water mark a partir do qual buscar (já com margem aplicada pelo caller)
//
// Retorna:
//   - rows: linhas como map[string]any (chave = nome LÓGICO da coluna)
//   - maxDA: MAX(data_atualizacao) observado; é zero-time se nenhuma linha tiver DA preenchida
//   - err: erro de consulta
func ExtractDelta(
	ctx context.Context,
	db *sql.DB,
	rm *ResolvedMapping,
	entity string,
	hwm time.Time,
) (rows []map[string]any, maxDA time.Time, err error) {
	resolvedCols, ok := rm.Resolved[entity]
	if !ok {
		return nil, time.Time{}, fmt.Errorf("ExtractDelta: entidade %q não encontrada no mapeamento resolvido", entity)
	}

	// Monta a lista de colunas a selecionar (nome real no PG).
	// Preserva o mapeamento lógico→real para nomear as colunas no resultado.
	var selectCols []colPair
	for logic, real := range resolvedCols {
		selectCols = append(selectCols, colPair{logic, real})
	}
	// Ordena por nome lógico para SELECT determinístico.
	sortColPairs(selectCols)

	colNames := make([]string, len(selectCols))
	for i, cp := range selectCols {
		colNames[i] = cp.real
	}

	daCol, hasDA := resolvedCols["data_atualizacao"]
	if !hasDA {
		// Tabela sem data_atualizacao: faz full scan (ex: colecao, subcolecao).
		return extractFullScan(ctx, db, entity, selectCols, colNames)
	}

	// Monta a query de delta.
	query := fmt.Sprintf(
		`SELECT %s FROM %s WHERE %s > $1 OR %s IS NULL ORDER BY %s ASC`,
		strings.Join(quoteIdents(colNames), ", "),
		quoteIdent(entity),
		quoteIdent(daCol),
		quoteIdent(daCol),
		quoteIdent(daCol),
	)

	sqlRows, err := db.QueryContext(ctx, query, hwm)
	if err != nil {
		return nil, time.Time{}, fmt.Errorf("ExtractDelta %s: erro na query: %w", entity, err)
	}
	defer sqlRows.Close()

	rows, maxDA, err = scanRows(sqlRows, selectCols, daCol)
	if err != nil {
		return nil, time.Time{}, fmt.Errorf("ExtractDelta %s: erro ao ler linhas: %w", entity, err)
	}

	// Para a shape flat da FORMULA, agrega os itens de corante em []map[string]any.
	if entity == "formula" && rm.FormulaShape == FormulaShapeFlat {
		rows = aggregateFlatFormulaItems(rows, rm.FlatFormulaCols)
	}

	return rows, maxDA, nil
}

// extractFullScan faz um SELECT sem filtro de data (para tabelas sem data_atualizacao).
func extractFullScan(
	ctx context.Context,
	db *sql.DB,
	entity string,
	selectCols []colPair,
	colNames []string,
) ([]map[string]any, time.Time, error) {
	query := fmt.Sprintf(
		`SELECT %s FROM %s`,
		strings.Join(quoteIdents(colNames), ", "),
		quoteIdent(entity),
	)
	sqlRows, err := db.QueryContext(ctx, query)
	if err != nil {
		return nil, time.Time{}, fmt.Errorf("extractFullScan %s: %w", entity, err)
	}
	defer sqlRows.Close()
	rows, _, err := scanRows(sqlRows, selectCols, "")
	return rows, time.Time{}, err
}

// scanRows lê as linhas do sql.Rows, nomeando colunas pelo nome LÓGICO.
// Rastreia o MAX(data_atualizacao) observado (relógio da ORIGEM).
func scanRows(sqlRows *sql.Rows, selectCols []colPair, daLogicName string) ([]map[string]any, time.Time, error) {
	var maxDA time.Time

	// Prepara os destinos de scan: ponteiros para interface{} (aceita qualquer tipo do PG).
	dest := make([]any, len(selectCols))
	destPtrs := make([]any, len(selectCols))
	for i := range dest {
		destPtrs[i] = &dest[i]
	}

	var out []map[string]any
	for sqlRows.Next() {
		if err := sqlRows.Scan(destPtrs...); err != nil {
			return nil, maxDA, err
		}
		row := make(map[string]any, len(selectCols))
		for i, cp := range selectCols {
			row[cp.logic] = dest[i]
		}
		// Rastreia o MAX(data_atualizacao) — relógio da ORIGEM.
		if daLogicName != "" {
			if daVal := row[daLogicName]; daVal != nil {
				if t, ok := toTime(daVal); ok && t.After(maxDA) {
					maxDA = t
				}
			}
		}
		out = append(out, row)
	}
	return out, maxDA, sqlRows.Err()
}

// aggregateFlatFormulaItems converte as colunas achatadas corante1..6 + qtd1ml..6ml
// em um campo "itens" []map[string]any com {id_corante, ordem, qtd_ml}.
// Slots com corante vazio ou qtd <= 0 são omitidos.
func aggregateFlatFormulaItems(rows []map[string]any, flatCols map[string]string) []map[string]any {
	for _, row := range rows {
		var itens []map[string]any
		for i := 1; i <= 6; i++ {
			coranteKey := fmt.Sprintf("corante%d", i)
			qtdKey := fmt.Sprintf("qtd%dml", i)

			// Usa o nome real mapeado para buscar o valor na linha.
			coranteReal := flatCols[coranteKey]
			qtdReal := flatCols[qtdKey]

			// Permite que o slot use o nome real ou o nome lógico (para flexibilidade).
			coranteVal := row[coranteKey]
			if coranteVal == nil && coranteReal != "" {
				coranteVal = row[coranteReal]
			}
			qtdVal := row[qtdKey]
			if qtdVal == nil && qtdReal != "" {
				qtdVal = row[qtdReal]
			}

			// Remove SEMPRE as colunas brutas (inclusive slots vazios/pulados),
			// para não enviá-las ao servidor com qualquer valor que tenham.
			delete(row, coranteKey)
			if coranteReal != "" {
				delete(row, coranteReal)
			}
			delete(row, qtdKey)
			if qtdReal != "" {
				delete(row, qtdReal)
			}

			// Pula slots com corante vazio ou nil.
			if coranteVal == nil || fmt.Sprintf("%v", coranteVal) == "" {
				continue
			}

			// Converte qtd para float64; pula se <= 0.
			qtd := toFloat64(qtdVal)
			if qtd <= 0 {
				continue
			}

			itens = append(itens, map[string]any{
				"id_corante": fmt.Sprintf("%v", coranteVal),
				"ordem":      i,
				"qtd_ml":     qtd,
			})
		}
		row["itens"] = itens
	}
	return rows
}

// ExtractFormulaChildItems extrai os itens da tabela filha formula_item e os
// agrega por id_formula (para shape child). Retorna map[id_formula → []item].
// Usado pelo sync.go quando FormulaShape == FormulaShapeChild.
func ExtractFormulaChildItems(ctx context.Context, db *sql.DB) (map[string][]map[string]any, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT id_formula::text, id_corante::text, ordem, qtd_ml
		FROM formula_item
		ORDER BY id_formula, ordem
	`)
	if err != nil {
		return nil, fmt.Errorf("ExtractFormulaChildItems: %w", err)
	}
	defer rows.Close()

	out := make(map[string][]map[string]any)
	for rows.Next() {
		var idFormula, idCorante string
		var ordem int
		var qtdML float64
		if err := rows.Scan(&idFormula, &idCorante, &ordem, &qtdML); err != nil {
			return nil, err
		}
		if qtdML <= 0 {
			continue // pula slots vazios
		}
		out[idFormula] = append(out[idFormula], map[string]any{
			"id_corante": idCorante,
			"ordem":      ordem,
			"qtd_ml":     qtdML,
		})
	}
	return out, rows.Err()
}

// ──────────────────────────────────────────────────────────────
// helpers internos
// ──────────────────────────────────────────────────────────────

// colPair associa o nome lógico de uma coluna ao nome real no PG.
type colPair struct {
	logic string
	real  string
}

func sortColPairs(pairs []colPair) {
	for i := 1; i < len(pairs); i++ {
		for j := i; j > 0 && pairs[j].logic < pairs[j-1].logic; j-- {
			pairs[j], pairs[j-1] = pairs[j-1], pairs[j]
		}
	}
}

// quoteIdent envolve um identificador em aspas duplas para evitar conflitos
// com palavras reservadas do SQL.
func quoteIdent(name string) string {
	return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
}

// quoteIdents aplica quoteIdent a cada elemento.
func quoteIdents(names []string) []string {
	out := make([]string, len(names))
	for i, n := range names {
		out[i] = quoteIdent(n)
	}
	return out
}

// toTime tenta converter um valor retornado pelo driver pgx em time.Time.
func toTime(v any) (time.Time, bool) {
	switch t := v.(type) {
	case time.Time:
		return t, true
	case *time.Time:
		if t != nil {
			return *t, true
		}
	}
	return time.Time{}, false
}

// toFloat64 converte um valor retornado pelo driver pgx em float64.
// Retorna 0 se não for conversível.
func toFloat64(v any) float64 {
	if v == nil {
		return 0
	}
	switch n := v.(type) {
	case float64:
		return n
	case float32:
		return float64(n)
	case int64:
		return float64(n)
	case int32:
		return float64(n)
	case int:
		return float64(n)
	}
	return 0
}

// sanitizeConnStr remove a senha da string de conexão para logs.
func sanitizeConnStr(conn string) string {
	// Substitui "://user:pass@" por "://user:***@"
	if idx := strings.Index(conn, "@"); idx > 0 {
		prefix := conn[:idx]
		rest := conn[idx:]
		if at := strings.LastIndex(prefix, ":"); at > 0 {
			return prefix[:at] + ":***" + rest
		}
	}
	return conn
}
