// update.go — auto-atualização diária do conector sayersync.
//
// Fluxo:
//  1. Busca o manifesto JSON em Config.UpdateManifestURL (bucket público do Supabase Storage)
//  2. Compara a versão do manifesto com a versão atual (semver, anti-downgrade)
//  3. Baixa o novo binário e verifica o sha256
//  4. Instala Windows-safe: MOVE o exe em execução para <exe>.prev (backup) e MOVE
//     o <exe>.new para <exe> — nessa ordem, porque a imagem em uso no Windows pode
//     ser renomeada mas não sobrescrita (ver installBinary)
//  5. Reinicia o serviço (os.Exit → SCM OnFailure=restart) para ativar o novo binário
//  6. Guarda um crash-loop guard: se ≥3 falhas de update em 24h → restaura o .prev e pausa
//
// Chamado uma vez por RunCycle quando a data mudou desde a última verificação.
//
// Segurança:
//   - UpdateManifestURL fica num bucket PÚBLICO read-only do Supabase; escrita = service_role apenas.
//   - sha256 verificado antes de instalar (falha → descarta o download, conta como falha).
//   - Anti-downgrade: só atualiza se manifest.version > current (semver estrito).
//   - Crash-loop guard: 3 falhas em 24h → restaura .prev + pausa tentativas; a janela
//     ancora na última FALHA (LastUpdateFailure) e expira 24h depois (NÃO trava para sempre).
//
// Spec: docs/superpowers/specs/2026-06-09-tint-sync-sayersystem-design.md §6.4
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// UpdateManifest é o JSON lido do bucket público de releases.
type UpdateManifest struct {
	Version string `json:"version"` // semver sem prefixo "v": "0.2.0"
	SHA256  string `json:"sha256"`  // hex lowercase do binário Windows
	URL     string `json:"url"`     // URL pública do binário .exe
}

// crashLoopWindow é a janela de tempo para contagem de falhas do crash-loop guard.
const crashLoopWindow = 24 * time.Hour

// crashLoopThreshold é o número máximo de falhas antes de restaurar o .prev.
const crashLoopThreshold = 3

// exitCodeUpdateRestart é o código de saída após instalar um novo binário. O
// processo encerra com FALHA de propósito: o SCM do Windows (OnFailure=restart,
// ver svcConfig em main.go) relança o serviço a partir do exePath — agora o
// binário novo. Sem o relançamento o serviço continuaria executando a imagem
// antiga (movida para .prev) e a PRÓXIMA atualização falharia ao tentar
// substituir o .prev em uso.
const exitCodeUpdateRestart = 90

// restartService reinicia o serviço para ativar o binário recém-instalado.
// É uma variável para permitir override em testes; em produção NÃO retorna
// (os.Exit → SCM relança). Verificação ponta-a-ponta exige um balcão Windows real.
var restartService = func() {
	logger.Infof("update: reiniciando o serviço para ativar o novo binário (exit %d → SCM OnFailure=restart)", exitCodeUpdateRestart)
	os.Exit(exitCodeUpdateRestart)
}

// autoUpdateEnabled controla se o auto-update roda neste processo. Default true
// (modo serviço). O subcomando `once` (debug/manual) o desliga: um run de debug
// NÃO deve trocar o binário em produção nem os.Exit(90) fora do modelo de recovery
// do SCM — e evita corrida de arquivos com o serviço rodando em paralelo. (Codex F6/F7)
var autoUpdateEnabled = true

// ─────────────────────────────────────────────────────────────
// CheckAndApplyUpdate — ponto de entrada
// ─────────────────────────────────────────────────────────────

// CheckAndApplyUpdate verifica se há uma nova versão disponível e aplica a atualização.
// É idempotente e seguro chamar em cada ciclo: verifica uma vez por dia.
// Retorna nil se não há atualização necessária ou se a atualização foi bem-sucedida.
// Erros são logados mas não propagam para não interromper o ciclo de sync.
func CheckAndApplyUpdate(ctx context.Context, cfg *Config, st *State) {
	if !autoUpdateEnabled {
		return // desligado neste processo (ex.: subcomando `once`)
	}
	if cfg.UpdateManifestURL == "" {
		return // auto-update desativado
	}

	// Verifica uma vez por dia.
	if !shouldCheckUpdate(st) {
		return
	}

	// Registra a tentativa (independente de sucesso/falha).
	st.LastUpdateAttempt = time.Now().UTC().Format(time.RFC3339)

	// Verifica crash-loop guard antes de tentar.
	if isCrashLoopGuardActive(st) {
		logger.Warnf("update: crash-loop guard ativo (%d falhas em 24h) — pulando auto-update", st.UpdateFailCount)
		return
	}

	installed, err := doUpdate(ctx, cfg, st)
	if err != nil {
		logger.Errorf("update: falha na atualização: %v", err)
		st.UpdateFailCount++
		// Âncora da janela do crash-loop guard na FALHA real (não no throttle).
		st.LastUpdateFailure = time.Now().UTC().Format(time.RFC3339)

		// Crash-loop guard: 3 falhas → restaura .prev.
		if st.UpdateFailCount >= crashLoopThreshold {
			logger.Errorf("update: %d falhas acumuladas — restaurando binário .prev", st.UpdateFailCount)
			if restErr := restorePrev(); restErr != nil {
				logger.Errorf("update: falha ao restaurar .prev: %v", restErr)
			} else {
				logger.Infof("update: .prev restaurado com sucesso")
			}
		}
		return
	}

	// Sucesso: reseta o contador de falhas e a âncora da janela.
	st.UpdateFailCount = 0
	st.LastUpdateFailure = ""

	// Se um binário novo foi instalado, reinicia para ativá-lo. O processo atual
	// ainda executa a imagem antiga (movida para .prev), então só o relançamento
	// ativa o novo binário; além disso, sem ele a próxima atualização falharia ao
	// tentar substituir o .prev em uso. Em produção restartService não retorna.
	if installed {
		// Persiste ANTES de reiniciar: o os.Exit pula o SaveState gated do RunCycle.
		// Sem isso, após o restart o throttle ainda apontaria para ontem e um binário
		// publicado com versão errada (ex.: build sem ldflag → "dev") viraria loop
		// install→restart. Persistido, shouldCheckUpdate=false no mesmo dia → no
		// máximo 1 tentativa/dia. (Codex F1)
		if saveErr := SaveState(st); saveErr != nil {
			logger.Errorf("update: falha ao persistir state antes do restart: %v", saveErr)
		}
		restartService()
	}
}

// ─────────────────────────────────────────────────────────────
// shouldCheckUpdate — verifica se deve tentar update hoje
// ─────────────────────────────────────────────────────────────

func shouldCheckUpdate(st *State) bool {
	if st.LastUpdateAttempt == "" {
		return true
	}
	last, err := time.Parse(time.RFC3339, st.LastUpdateAttempt)
	if err != nil {
		return true
	}
	// Verifica uma vez por dia (UTC).
	now := time.Now().UTC()
	return last.UTC().Format("2006-01-02") != now.Format("2006-01-02")
}

// isCrashLoopGuardActive retorna true se o guard de crash-loop está ativo.
// O guard ativa quando UpdateFailCount >= crashLoopThreshold E a última FALHA
// foi dentro da janela de 24h.
//
// A janela ancora em LastUpdateFailure (não LastUpdateAttempt): o throttle diário
// renova LastUpdateAttempt para "agora" em TODA passagem — inclusive quando o guard
// pula a tentativa — então usá-lo como âncora fazia a janela nunca envelhecer e o
// guard travar para sempre (P2). Ancorando na última falha real, a janela expira
// 24h após a 3ª falha e uma nova tentativa volta a rodar.
func isCrashLoopGuardActive(st *State) bool {
	if st.UpdateFailCount < crashLoopThreshold {
		return false
	}
	if st.LastUpdateFailure == "" {
		return false
	}
	last, err := time.Parse(time.RFC3339, st.LastUpdateFailure)
	if err != nil {
		return false
	}
	elapsed := time.Since(last)
	if elapsed < 0 {
		// Timestamp no futuro (clock skew / state corrompido): time.Since negativo
		// manteria o guard ativo até "futuro + 24h", pausando updates por tempo
		// indefinido. Fail-open — não confiar na âncora corrompida. (Codex F8)
		return false
	}
	return elapsed < crashLoopWindow
}

// ─────────────────────────────────────────────────────────────
// doUpdate — baixa e instala a nova versão
// ─────────────────────────────────────────────────────────────

// doUpdate retorna (installed, err): installed=true só quando um binário novo foi
// de fato colocado no lugar (dispara o restart em CheckAndApplyUpdate). "Já é a
// versão mais recente" retorna (false, nil).
func doUpdate(ctx context.Context, cfg *Config, st *State) (bool, error) {
	// 1. Busca o manifesto.
	manifest, err := fetchManifest(ctx, cfg.UpdateManifestURL)
	if err != nil {
		return false, fmt.Errorf("doUpdate: buscar manifesto: %w", err)
	}

	// 2. Compara versões (anti-downgrade: só atualiza se manifest.version > current).
	if !isNewerVersion(manifest.Version, Version) {
		logger.Infof("update: versão atual %q já é a mais recente (manifesto: %q)", Version, manifest.Version)
		return false, nil
	}
	logger.Infof("update: nova versão disponível %q (atual: %q) — baixando", manifest.Version, Version)

	// 3. Baixa o binário.
	binData, err := downloadBinary(ctx, manifest.URL)
	if err != nil {
		return false, fmt.Errorf("doUpdate: baixar binário: %w", err)
	}

	// 4. Verifica sha256.
	if err := verifySHA256(binData, manifest.SHA256); err != nil {
		return false, fmt.Errorf("doUpdate: sha256 inválido: %w", err)
	}

	// 5. Instala (move-aside-then-place Windows-safe).
	if err := installBinary(binData); err != nil {
		return false, fmt.Errorf("doUpdate: instalar binário: %w", err)
	}

	logger.Infof("update: versão %q instalada — reiniciando o serviço para ativar", manifest.Version)
	return true, nil
}

// ─────────────────────────────────────────────────────────────
// fetchManifest
// ─────────────────────────────────────────────────────────────

func fetchManifest(ctx context.Context, manifestURL string) (*UpdateManifest, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, manifestURL, nil)
	if err != nil {
		return nil, fmt.Errorf("criar request: %w", err)
	}

	cli := &http.Client{Timeout: 30 * time.Second}
	resp, err := cli.Do(req)
	if err != nil {
		return nil, fmt.Errorf("GET manifesto: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET manifesto: HTTP %d", resp.StatusCode)
	}

	var manifest UpdateManifest
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64*1024)).Decode(&manifest); err != nil {
		return nil, fmt.Errorf("decodificar manifesto: %w", err)
	}
	if manifest.Version == "" || manifest.SHA256 == "" || manifest.URL == "" {
		return nil, fmt.Errorf("manifesto incompleto: version=%q sha256=%q url=%q",
			manifest.Version, manifest.SHA256, manifest.URL)
	}
	return &manifest, nil
}

// ─────────────────────────────────────────────────────────────
// downloadBinary
// ─────────────────────────────────────────────────────────────

func downloadBinary(ctx context.Context, binURL string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, binURL, nil)
	if err != nil {
		return nil, fmt.Errorf("criar request de download: %w", err)
	}

	cli := &http.Client{Timeout: 5 * time.Minute}
	resp, err := cli.Do(req)
	if err != nil {
		return nil, fmt.Errorf("GET binário: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET binário: HTTP %d", resp.StatusCode)
	}

	// Limita a 100 MB para evitar download malicioso.
	const maxBinarySize = 100 * 1024 * 1024
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxBinarySize+1))
	if err != nil {
		return nil, fmt.Errorf("ler binário: %w", err)
	}
	if int64(len(data)) > maxBinarySize {
		return nil, fmt.Errorf("binário muito grande (> 100 MB)")
	}
	return data, nil
}

// ─────────────────────────────────────────────────────────────
// verifySHA256
// ─────────────────────────────────────────────────────────────

func verifySHA256(data []byte, expectedHex string) error {
	sum := sha256.Sum256(data)
	got := hex.EncodeToString(sum[:])
	// Compara em lowercase para evitar falha por case.
	if strings.ToLower(got) != strings.ToLower(expectedHex) {
		return fmt.Errorf("sha256 esperado %q, calculado %q", expectedHex, got)
	}
	return nil
}

// ─────────────────────────────────────────────────────────────
// installBinary
// ─────────────────────────────────────────────────────────────

// executablePath resolve o caminho real (symlinks resolvidos) do executável em
// execução. É uma variável para permitir override em testes (mesmo padrão de
// `var stateDir` em state.go), já que installBinary/restorePrev operam sobre ele.
var executablePath = func() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("determinar caminho do executável: %w", err)
	}
	exe, err = filepath.EvalSymlinks(exe)
	if err != nil {
		return "", fmt.Errorf("resolver symlinks do executável: %w", err)
	}
	return exe, nil
}

// renameFile é os.Rename isolado em variável para permitir simular falha do passo
// de "colocar o novo binário" em testes (cobertura do rollback).
var renameFile = os.Rename

// installBinary instala o novo binário de forma Windows-safe:
//  1. Grava o novo binário em <exe>.new
//  2. MOVE (rename) o exe atual em execução para <exe>.prev
//  3. MOVE (rename) o <exe>.new para <exe>
//
// Por que mover o exe em uso ANTES de colocar o novo (e não sobrescrevê-lo):
// no Windows a imagem em execução fica travada — não pode ser SOBRESCRITA nem
// APAGADA — mas PODE ser renomeada/movida. Movendo-a para .prev primeiro, o
// destino (exePath) deixa de existir e o passo 3 não esbarra em sharing violation.
// O processo continua executando a imagem antiga (agora em .prev) até reiniciar;
// o restart pós-install (ver CheckAndApplyUpdate) é o que ativa o novo binário.
//
// Se o passo 3 falhar depois do passo 2, faz rollback (devolve o exe original ao
// lugar) para nunca deixar o serviço sem binário no exePath.
func installBinary(data []byte) error {
	exePath, err := executablePath()
	if err != nil {
		return err
	}

	newPath := exePath + ".new"
	prevPath := exePath + ".prev"

	// 1. Grava o novo binário ao lado.
	if err := os.WriteFile(newPath, data, 0755); err != nil { //nolint:gosec
		return fmt.Errorf("gravar binário .new: %w", err)
	}

	// 2. Move o exe ATUAL (em execução) para .prev — backup É o move, não cópia.
	//    Substitui um .prev anterior se existir (os.Rename é REPLACE_EXISTING).
	if err := renameFile(exePath, prevPath); err != nil {
		_ = os.Remove(newPath)
		return fmt.Errorf("mover exe atual para .prev: %w", err)
	}

	// 3. Coloca o novo binário no lugar do exe (destino já não existe).
	if err := renameFile(newPath, exePath); err != nil {
		// Rollback: devolve o exe original ao lugar para não deixar o serviço sem binário.
		if rbErr := renameFile(prevPath, exePath); rbErr != nil {
			return fmt.Errorf("colocar .new no exe: %w; ROLLBACK FALHOU — exe ficou em %s: %v", err, prevPath, rbErr)
		}
		_ = os.Remove(newPath)
		return fmt.Errorf("colocar .new no exe (rollback ok): %w", err)
	}

	return nil
}

// ─────────────────────────────────────────────────────────────
// restorePrev — crash-loop guard
// ─────────────────────────────────────────────────────────────

// restorePrev restaura o binário anterior a partir de <exe>.prev.
func restorePrev() error {
	exePath, err := executablePath()
	if err != nil {
		return err
	}
	prevPath := exePath + ".prev"

	prevData, err := os.ReadFile(prevPath)
	if err != nil {
		return fmt.Errorf("ler .prev: %w", err)
	}
	if err := os.WriteFile(exePath, prevData, 0755); err != nil { //nolint:gosec
		return fmt.Errorf("restaurar .prev para exe: %w", err)
	}
	return nil
}

// ─────────────────────────────────────────────────────────────
// isNewerVersion — comparação semver simples (sem dep extra)
// ─────────────────────────────────────────────────────────────

// isNewerVersion retorna true se candidateVersion > currentVersion (semver).
// Aceita versões com ou sem prefixo "v".
// Compara os três componentes (major.minor.patch) numericamente.
// Anti-downgrade: retorna false se candidateVersion <= currentVersion.
// Exceção: se a versão atual for uma build de desenvolvimento (não parseável como semver,
// ex.: "dev"), qualquer versão de release válida é considerada "mais nova" — permite
// que builds de teste sejam substituídos por releases reais.
func isNewerVersion(candidate, current string) bool {
	cMaj, cMin, cPat, ok1 := parseSemver(candidate)
	curMaj, curMin, curPat, ok2 := parseSemver(current)
	if !ok1 {
		// Candidato não é semver válido → não atualiza (seguro por default).
		return false
	}
	if !ok2 {
		// Versão atual não é semver (ex.: "dev") → qualquer release válido é mais novo.
		return true
	}
	if cMaj != curMaj {
		return cMaj > curMaj
	}
	if cMin != curMin {
		return cMin > curMin
	}
	return cPat > curPat
}

// parseSemver extrai (major, minor, patch) de uma string semver.
// Aceita "1.2.3" ou "v1.2.3".
func parseSemver(v string) (major, minor, patch int, ok bool) {
	v = strings.TrimPrefix(v, "v")
	parts := strings.SplitN(v, ".", 3)
	if len(parts) != 3 {
		return 0, 0, 0, false
	}
	maj, err1 := strconv.Atoi(parts[0])
	min, err2 := strconv.Atoi(parts[1])
	// Remove sufixo de pre-release se presente (ex.: "0" de "0-beta").
	patStr := strings.SplitN(parts[2], "-", 2)[0]
	pat, err3 := strconv.Atoi(patStr)
	if err1 != nil || err2 != nil || err3 != nil {
		return 0, 0, 0, false
	}
	return maj, min, pat, true
}
