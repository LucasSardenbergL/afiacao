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
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	_ "github.com/jackc/pgx/v5/stdlib" // driver pgx para database/sql
)

// querier abstrai *sql.DB e *sql.Tx — a extração pai+filha das fórmulas child
// roda na MESMA transação REPEATABLE READ (Fase 1d, Codex P1: com duas queries
// em conexões separadas sob READ COMMITTED, um DELETE+COMMIT/reinsert na origem
// entre elas produzia uma fotografia "0 linhas na filha" logicamente vazia →
// is_base_pura falso → limpeza indevida de 1 fórmula, por baixo de qualquer cap).
type querier interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

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
	db querier,
	rm *ResolvedMapping,
	entity string,
	hwm time.Time,
) (rows []map[string]any, maxDA time.Time, err error) {
	resolvedCols, ok := rm.Resolved[entity]
	if !ok {
		return nil, time.Time{}, fmt.Errorf("ExtractDelta: entidade %q não encontrada no mapeamento resolvido", entity)
	}

	// Monta a lista de colunas a selecionar — inclui os slots flat das fórmulas
	// (P0: sem isso corante1..6/qtd1..6 nunca entravam no SELECT e os itens saíam vazios).
	selectCols := buildDeltaSelectCols(rm, entity)
	colNames := make([]string, len(selectCols))
	for i, cp := range selectCols {
		colNames[i] = cp.real
	}

	// FROM usa o nome FÍSICO da tabela (ex: lógico "corantes" → físico "corante").
	physical := rm.TableFor(entity)

	daCol, hasDA := resolvedCols["data_atualizacao"]
	if !hasDA {
		// Tabela sem data_atualizacao: faz full scan (ex: personcor no schema real).
		rows, maxDA, err = extractFullScan(ctx, db, entity, physical, selectCols, colNames)
	} else {
		// Monta a query de delta.
		query := fmt.Sprintf(
			`SELECT %s FROM %s WHERE %s > $1 OR %s IS NULL ORDER BY %s ASC`,
			strings.Join(quoteIdents(colNames), ", "),
			quoteIdent(physical),
			quoteIdent(daCol),
			quoteIdent(daCol),
			quoteIdent(daCol),
		)

		sqlRows, qErr := db.QueryContext(ctx, query, hwm)
		if qErr != nil {
			return nil, time.Time{}, fmt.Errorf("ExtractDelta %s: erro na query: %w", entity, qErr)
		}
		defer sqlRows.Close()

		rows, maxDA, err = scanRows(sqlRows, selectCols, daCol)
		if err != nil {
			err = fmt.Errorf("ExtractDelta %s: erro ao ler linhas: %w", entity, err)
		}
	}
	if err != nil {
		return nil, time.Time{}, err
	}

	// Para a shape flat das FÓRMULAS (formula E formulaperson), agrega os itens de
	// corante em []map[string]any usando os flat cols da TABELA correspondente.
	if (entity == "formula" || entity == "formulaperson") && rm.FormulaShape == FormulaShapeFlat {
		rows = aggregateFlatFormulaItems(rows, rm.FlatColsByTable[entity], entity == "formulaperson")
	}

	return rows, maxDA, nil
}

// buildDeltaSelectCols monta a lista de colunas (lógico→real) do SELECT de delta
// de uma entidade. Para fórmulas no shape FLAT, APPENDA os slots corante1..6 +
// qtd1ml..6ml resolvidos em rm.FlatColsByTable[entity] — eles não estão em
// rm.Resolved (são detectados pelo shape, não pelo mapeamento declarativo) e sem
// isso o aggregateFlatFormulaItems produzia itens VAZIOS para toda fórmula (P0).
// Função pura (testável sem banco).
func buildDeltaSelectCols(rm *ResolvedMapping, entity string) []colPair {
	resolvedCols := rm.Resolved[entity]
	selectCols := make([]colPair, 0, len(resolvedCols)+12)
	for logic, real := range resolvedCols {
		selectCols = append(selectCols, colPair{logic, real})
	}
	if (entity == "formula" || entity == "formulaperson") && rm.FormulaShape == FormulaShapeFlat {
		for slotKey, realName := range rm.FlatColsByTable[entity] {
			selectCols = append(selectCols, colPair{slotKey, realName})
		}
	}
	// Ordena por nome lógico para SELECT determinístico.
	sortColPairs(selectCols)
	return selectCols
}

// extractFullScan faz um SELECT sem filtro de data (para tabelas sem data_atualizacao).
// physical é o nome FÍSICO da tabela; entity (lógico) só aparece nas mensagens de erro.
func extractFullScan(
	ctx context.Context,
	db querier,
	entity string,
	physical string,
	selectCols []colPair,
	colNames []string,
) ([]map[string]any, time.Time, error) {
	query := fmt.Sprintf(
		`SELECT %s FROM %s`,
		strings.Join(quoteIdents(colNames), ", "),
		quoteIdent(physical),
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

// sentinelaSlotLivre é o id_corante que a fonte SayerSystem grava, em fórmulas
// PERSONALIZADAS, para marcar slot LIVRE (sempre com dose exatamente 0). O corante
// '0' não existe no cadastro (ids reais 1..5, 8..16) — medido em prod 2026-07-21:
// 100% das personalizadas materializam assim, 0% das padrão (confundidor de produto
// descartado: FO10.6554 aparece nos dois lados com comportamento oposto). É a MESMA
// semântica "slot livre" do catálogo padrão, em outra grafia: {vazio, nil/0} lá,
// {'0', 0} aqui. A comparação usa a MESMA stringificação do emissor — a regra é "o
// item que este código emitiria como id_corante='0'". ID que stringifica diferente
// (" 0 ", []byte) NÃO casa → segue emitido → Guard 4 barra. Fail-closed por construção.
const sentinelaSlotLivre = "0"

// aggregateFlatFormulaItems converte as colunas achatadas corante1..6 + qtd1ml..6ml
// em um campo "itens" []map[string]any com {id_corante, ordem, qtd_ml}.
//
// FASE 1d (money-path) — o conector é TRANSPORTE FIEL, o banco é a fronteira:
//   - corante PRESENTE (qualquer qtd): EMITE o item cru — qtd_ml = número parseado
//     (mesmo <=0) ou nil quando não-parseável (ausente ≠ zero, NUNCA 0). Antes o
//     slot inválido era OMITIDO aqui e o payload chegava "limpo" no banco →
//     receita PARCIAL promovida sem nenhum guard ver (subfaturamento silencioso).
//     Quem barra é o Guard 4 de tint_promote_sync_run, com log em tint_sync_errors.
//   - órfão (corante vazio + dose legível ≠0): EMITE {id_corante:"", qtd_ml} —
//     dose sem corante é corrupção (Guard 4b do banco).
//   - slot LIVRE (corante vazio + qtd nil ou 0 legível): OMITIDO — é o estado
//     normal de ~100% do catálogo flat (<6 slots usados); emitir viraria
//     placeholder e barraria toda fórmula (C29).
//   - corante vazio + qtd ILEGÍVEL: não emite (nada aproveitável sem corante),
//     mas BLOQUEIA a declaração de base pura — o vazio fica ambíguo e o banco
//     barra. Limite conhecido: se a fórmula tem OUTROS itens válidos, promove
//     sem o lixo (comportamento igual ao de prod hoje; sem corante não há
//     componente identificável a preservar).
//   - is_base_pura=true SÓ quando TODOS os 6 slots são livres E os 12 flat cols
//     resolveram no discovery (slot invisível pode conter corante real —
//     fail-closed). É o sinal EXPLÍCITO da fonte que a Fase 1d exige para a
//     transição legítima para base pura limpar receita no banco.
//   - slot livre na grafia das PERSONALIZADAS (`sentinelaSlotLivre` + dose 0):
//     OMITIDO como qualquer slot livre, MAS veta a declaração de base pura — ver
//     a const abaixo e o comentário do veto no fim da função.
func aggregateFlatFormulaItems(rows []map[string]any, flatCols map[string]string, personalizada bool) []map[string]any {
	colsCompletos := flatColsCompletos(flatCols)
	for _, row := range rows {
		itens := make([]map[string]any, 0, 6)
		sentinelaVista := false
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

			corantePresente := coranteVal != nil && fmt.Sprintf("%v", coranteVal) != ""
			qtd, qtdOK := toFloat64OK(qtdVal)

			// SENTINELA DE SLOT LIVRE das fórmulas PERSONALIZADAS (ver doc acima).
			// Escopada a `personalizada` de propósito: é onde a evidência vale (100%
			// vs 0%). Em fórmula padrão um '0' é anomalia NOVA e segue emitida p/ o
			// Guard 4 barrar e denunciar.
			if personalizada && corantePresente && qtdOK && qtd == 0 &&
				fmt.Sprintf("%v", coranteVal) == sentinelaSlotLivre {
				sentinelaVista = true
				continue
			}

			switch {
			case corantePresente:
				item := map[string]any{
					"id_corante": fmt.Sprintf("%v", coranteVal),
					"ordem":      i,
				}
				if qtdOK {
					item["qtd_ml"] = qtd
				} else {
					item["qtd_ml"] = nil
				}
				itens = append(itens, item)
			case qtdOK && qtd != 0:
				// Órfão: dose legível ≠0 sem corante — transporta p/ o Guard 4b barrar.
				itens = append(itens, map[string]any{
					"id_corante": "",
					"ordem":      i,
					"qtd_ml":     qtd,
				})
			case qtdVal != nil && !qtdOK:
				// Ilegível sem corante: EMITE placeholder {"", nil} — no protocolo 1d o
				// banco barra a fórmula inteira ([1d-E]: linha emitida que não é corante+
				// dose válida é corrupção). Codex P1: "não consigo identificar o
				// componente" não prova que ele não existe; ambiguidade bloqueia.
				itens = append(itens, map[string]any{
					"id_corante": "",
					"ordem":      i,
					"qtd_ml":     nil,
				})
			}
			// default: slot livre (corante vazio + qtd nil/0) → omitido.
		}
		row["itens"] = itens
		// A sentinela VETA a declaração de base pura (P1 do challenge Codex xhigh):
		// omitir 6 sentinelas deixaria itens vazio → is_base_pura=true → a TRÍADE da
		// Fase 1d AUTORIZA o banco a LIMPAR a receita (cap 50/24h). Uma fotografia
		// transitória de cor personalizada em cadastro viraria destruição de receita.
		// Omissão nunca vira afirmação positiva: só o vazio GENUÍNO da fonte prova.
		if len(itens) == 0 && colsCompletos && !sentinelaVista {
			row["is_base_pura"] = true
		}
	}
	return rows
}

// flatColsCompletos: os 12 slots (corante1..6 + qtd1ml..6ml) resolveram no
// discovery. Sem isso, um slot invisível ao SELECT pode conter corante real e
// "todos os slots vazios" não prova base pura (fail-closed: nunca declarar).
func flatColsCompletos(flatCols map[string]string) bool {
	for i := 1; i <= 6; i++ {
		if flatCols[fmt.Sprintf("corante%d", i)] == "" || flatCols[fmt.Sprintf("qtd%dml", i)] == "" {
			return false
		}
	}
	return true
}

// ExtractFormulaChildItems extrai os itens da tabela filha formula_item e os
// agrega por id_formula (= PK da fórmula no pai; ver F5 em sync.go). Retorna
// map[id_formula → []item]. Usado pelo sync.go quando FormulaShape == Child.
//
// hasOrdem: se a tabela filha tem a coluna "ordem" (detectada em Validate). Quando
// false, NÃO seleciona "ordem" (evita erro de coluna ausente) e deriva a ordem
// pela sequência de leitura por fórmula.
//
// FASE 1d (money-path): TODA linha da filha é emitida — inclusive qtd inválida
// (o Guard 4 do banco decide e loga; antes o skip daqui fabricava payload
// "íntegro" com receita parcial). Na filha não existe "slot livre": linha que
// existe é DADO da fonte e o COUNT/expected têm de contá-la.
func ExtractFormulaChildItems(ctx context.Context, db querier, hasOrdem bool) (map[string][]map[string]any, error) {
	query := `SELECT id_formula::text, id_corante::text, qtd_ml FROM formula_item ORDER BY id_formula`
	if hasOrdem {
		query = `SELECT id_formula::text, id_corante::text, qtd_ml, ordem FROM formula_item ORDER BY id_formula, ordem`
	}

	rows, err := db.QueryContext(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("ExtractFormulaChildItems: %w", err)
	}
	defer rows.Close()

	out := make(map[string][]map[string]any)
	seq := make(map[string]int) // ordem derivada quando a coluna não existe
	for rows.Next() {
		var idFormula, idCorante string
		var qtdRaw any
		var ordem int
		if hasOrdem {
			if err := rows.Scan(&idFormula, &idCorante, &qtdRaw, &ordem); err != nil {
				return nil, err
			}
		} else {
			if err := rows.Scan(&idFormula, &idCorante, &qtdRaw); err != nil {
				return nil, err
			}
			seq[idFormula]++
			ordem = seq[idFormula]
		}
		out[idFormula] = append(out[idFormula], childItemRow(idCorante, qtdRaw, ordem))
	}
	return out, rows.Err()
}

// childItemRow monta o item de uma linha da tabela filha — transporte fiel:
// qtd_ml = número parseado (mesmo <=0) ou nil quando ausente/não-parseável
// (ausente ≠ zero; NUNCA fabricar 0 no caminho de receita). Função pura.
func childItemRow(idCorante string, qtdRaw any, ordem int) map[string]any {
	item := map[string]any{
		"id_corante": idCorante,
		"ordem":      ordem,
	}
	if qtd, ok := toFloat64OK(qtdRaw); ok {
		item["qtd_ml"] = qtd
	} else {
		item["qtd_ml"] = nil
	}
	return item
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

// toFloat64OK converte um valor retornado pelo driver pgx em float64.
//
// ⚠️ Crítico: o pgx (database/sql, stdlib) entrega `numeric` do Postgres como
// STRING (cai no default do switch de Rows.Next → scan em string), NÃO como
// float64. Sem tratar string/[]byte, todo custo/imposto/margem/volume/qtd_ml
// (colunas numeric) virava 0 SILENCIOSAMENTE (F1 do review adversário). float8
// vem como float64; int* como int64/etc.
//
// Retorna (valor, true) quando conversível; (0, false) quando ausente (nil) ou
// não-parseável. O caller decide o que "ausente" significa — NUNCA tratar uma
// falha de parse como 0 válido no caminho de preço (omitir a chave / dropar).
func toFloat64OK(v any) (float64, bool) {
	if v == nil {
		return 0, false
	}
	switch n := v.(type) {
	case float64:
		return finitoOK(n)
	case float32:
		return finitoOK(float64(n))
	case int64:
		return float64(n), true
	case int32:
		return float64(n), true
	case int16:
		return float64(n), true
	case int:
		return float64(n), true
	case string:
		return parseFloatStr(n)
	case []byte:
		return parseFloatStr(string(n))
	case pgtype.Numeric:
		// Defensivo: caso o driver/typemap entregue pgtype.Numeric (não acontece
		// no caminho stdlib atual, mas custa pouco blindar).
		f8, err := n.Float64Value()
		if err != nil || !f8.Valid {
			return 0, false
		}
		return finitoOK(f8.Float64)
	}
	return 0, false
}

// finitoOK aplica a MESMA promessa de finitude que parseFloatStr já fazia para
// string/[]byte: NaN/Inf não são dose válida. Sem isto, float64/float32/numeric
// nativos passavam direto (achado P2 do challenge Codex xhigh, 2026-07-21) e um
// NaN chegava ao json.Marshal do lote — que REJEITA O LOTE INTEIRO (api.go), não
// a fórmula. Falha de ciclo do balcão, não rejeição por-fórmula.
func finitoOK(f float64) (float64, bool) {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return 0, false
	}
	return f, true
}

// parseFloatStr converte uma string numérica (formato Postgres: ponto decimal,
// sem separador de milhar) em float64. Espaços ao redor são tolerados; valores
// vazios ou não-numéricos retornam (0, false). NaN/Inf são rejeitados (não são
// preço/volume válidos).
func parseFloatStr(s string) (float64, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
		return 0, false
	}
	return f, true
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
