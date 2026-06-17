// sayersync — conector Go do SayerSystem (PostgreSQL local) para o app Colacor.
// Roda como serviço Windows (kardianos/service). Comportamento: delta por
// data_atualizacao com high-water mark da origem → POST lotes para tint-sync-agent.
//
// Subcomandos:
//
//	install    — configura interativamente e registra o serviço Windows SayerSync
//	uninstall  — remove o serviço Windows
//	run        — entry-point do serviço (chamado pelo SCM do Windows)
//	once       — executa 1 ciclo de sync no console (dev/debug)
//	discovery  — despeja schema do SayerSystem em sayersystem-schema.txt
//	version    — imprime a versão do binário
//
// Spec: docs/superpowers/specs/2026-06-09-tint-sync-sayersystem-design.md §5
package main

import (
	"bufio"
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib" // driver database/sql via pgx
	"github.com/kardianos/service"
)

// Version é injetado via -ldflags no build de release.
// Ex: go build -ldflags "-X main.Version=1.0.0"
var Version = "dev"

// ──────────────────────────────────────────────
// Serviço Windows via kardianos/service
// ──────────────────────────────────────────────

// program implementa service.Interface.
type program struct {
	cfg    *Config
	cancel context.CancelFunc
	done   chan struct{}
}

func (p *program) Start(s service.Service) error {
	p.done = make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	p.cancel = cancel
	go p.run(ctx)
	return nil
}

func (p *program) Stop(_ service.Service) error {
	if p.cancel != nil {
		p.cancel()
	}
	select {
	case <-p.done:
	case <-time.After(30 * time.Second):
	}
	return nil
}

func (p *program) run(ctx context.Context) {
	defer close(p.done)
	logger.Infof("sayersync %s iniciado (loop a cada %d min)", Version, p.cfg.IntervaloMin)
	// O ciclo de sync é implementado em sync.go (Task 9).
	// Aqui: ticker básico + placeholder para RunCycle.
	interval := time.Duration(p.cfg.IntervaloMin) * time.Minute
	for {
		select {
		case <-ctx.Done():
			logger.Info("sayersync encerrando")
			return
		default:
		}
		runOneCycle(ctx, p.cfg)
		select {
		case <-ctx.Done():
			return
		case <-time.After(interval):
		}
	}
}

// ──────────────────────────────────────────────
// main
// ──────────────────────────────────────────────

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(1)
	}

	cmd := strings.ToLower(os.Args[1])

	switch cmd {
	case "version":
		fmt.Printf("sayersync %s (%s/%s)\n", Version, runtime.GOOS, runtime.GOARCH)
		return

	case "install":
		cmdInstall()

	case "uninstall":
		cmdUninstall()

	case "run":
		cmdRun()

	case "once":
		cmdOnce()

	case "discovery":
		cmdDiscovery()

	default:
		fmt.Fprintf(os.Stderr, "Subcomando desconhecido: %q\n\n", cmd)
		printUsage()
		os.Exit(1)
	}
}

func printUsage() {
	fmt.Fprintf(os.Stderr, `sayersync %s — conector SayerSystem → Colacor app

Uso: sayersync <comando>

Comandos:
  install    Configurar e registrar o serviço Windows SayerSync
  uninstall  Remover o serviço Windows SayerSync
  run        Entry-point do serviço (chamado pelo Windows SCM)
  once       Executar 1 ciclo de sync no console (teste/debug)
  discovery  Despejar o schema do SayerSystem em sayersystem-schema.txt
  version    Mostrar a versão do binário
`, Version)
}

// ──────────────────────────────────────────────
// install
// ──────────────────────────────────────────────

func cmdInstall() {
	if runtime.GOOS != "windows" {
		fmt.Fprintln(os.Stderr, "ERRO: o subcomando 'install' funciona somente no Windows.")
		fmt.Fprintln(os.Stderr, "       Em outras plataformas, use 'once' ou 'discovery' para desenvolvimento.")
		os.Exit(1)
	}

	reader := bufio.NewReader(os.Stdin)

	fmt.Println("=== sayersync — configuração do serviço ===")
	fmt.Println()

	appURL := prompt(reader,
		"URL do app (Enter para usar o padrão)",
		"https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/tint-sync-agent",
	)

	storeCode := prompt(reader, "store_code (ex: colacor-divinopolis)", "")
	if storeCode == "" {
		fmt.Fprintln(os.Stderr, "ERRO: store_code é obrigatório.")
		os.Exit(1)
	}

	token := prompt(reader, "Token de sync (copiado de /tintometrico/integracao)", "")
	if token == "" {
		fmt.Fprintln(os.Stderr, "ERRO: token é obrigatório.")
		os.Exit(1)
	}

	pgConn := prompt(reader,
		"String de conexão PostgreSQL (Enter para usar o padrão)",
		"postgres://integra:integra@localhost:5986/client_industrial_sayerlack",
	)

	// Protege o token com DPAPI (escopo de máquina — LocalService consegue descriptografar).
	tokenEnc, err := encryptToken(token)
	if err != nil {
		fmt.Fprintf(os.Stderr, "ERRO ao proteger o token com DPAPI: %v\n", err)
		os.Exit(1)
	}

	cfg := &Config{
		AppURL:       appURL,
		StoreCode:    storeCode,
		TokenEnc:     tokenEnc,
		PGConn:       pgConn,
		IntervaloMin: 10,
		BuiltVersion: Version,
	}

	if err := SaveConfig(cfg); err != nil {
		fmt.Fprintf(os.Stderr, "ERRO ao salvar config.json: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("config.json salvo.")

	// Registra o serviço Windows.
	svcConfig := svcConfig(cfg)
	s, err := service.New(&program{cfg: cfg}, svcConfig)
	if err != nil {
		fmt.Fprintf(os.Stderr, "ERRO ao criar objeto de serviço: %v\n", err)
		os.Exit(1)
	}
	// Idempotente: remove registro anterior se existir (o INSTALACAO.md promete que
	// repetir o install é seguro; também conserta registro velho sem o argumento "run").
	_ = s.Stop()
	if err := s.Uninstall(); err == nil {
		// O SCM remove o serviço de forma assíncrona; dá tempo antes de recriar.
		time.Sleep(2 * time.Second)
	}
	var instErr error
	for i := 0; i < 3; i++ {
		if instErr = s.Install(); instErr == nil {
			break
		}
		time.Sleep(2 * time.Second)
	}
	if instErr != nil {
		fmt.Fprintf(os.Stderr, "ERRO ao instalar serviço: %v\n", instErr)
		os.Exit(1)
	}
	if err := s.Start(); err != nil {
		fmt.Fprintf(os.Stderr, "AVISO: serviço instalado mas não iniciou: %v\n", err)
		fmt.Fprintln(os.Stderr, "       Rode 'sayersync.exe once' para ver o erro no console.")
	} else {
		fmt.Println("Serviço SayerSync instalado e iniciado com sucesso.")
	}
	fmt.Println()
	fmt.Println("Próximo passo: verifique o heartbeat em /tintometrico/integracao → Integrações.")
}

// ──────────────────────────────────────────────
// uninstall
// ──────────────────────────────────────────────

func cmdUninstall() {
	if runtime.GOOS != "windows" {
		fmt.Fprintln(os.Stderr, "ERRO: o subcomando 'uninstall' funciona somente no Windows.")
		os.Exit(1)
	}

	cfg, err := LoadConfig()
	if err != nil {
		// Config pode não existir; ainda tenta remover com valores mínimos.
		cfg = &Config{}
	}

	svcCfg := svcConfig(cfg)
	s, err := service.New(&program{cfg: cfg}, svcCfg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "ERRO: %v\n", err)
		os.Exit(1)
	}
	_ = s.Stop()
	if err := s.Uninstall(); err != nil {
		fmt.Fprintf(os.Stderr, "ERRO ao remover serviço: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("Serviço SayerSync removido.")
}

// ──────────────────────────────────────────────
// run (entry-point do Windows SCM)
// ──────────────────────────────────────────────

func cmdRun() {
	cfg, err := LoadConfig()
	if err != nil {
		logger.Errorf("Falha ao carregar config.json: %v", err)
		os.Exit(1)
	}

	svcCfg := svcConfig(cfg)
	prg := &program{cfg: cfg}
	s, err := service.New(prg, svcCfg)
	if err != nil {
		logger.Errorf("Falha ao criar serviço: %v", err)
		os.Exit(1)
	}

	if err := s.Run(); err != nil {
		logger.Errorf("Serviço encerrou com erro: %v", err)
		os.Exit(1)
	}
}

// ──────────────────────────────────────────────
// once (1 ciclo, console)
// ──────────────────────────────────────────────

func cmdOnce() {
	// `once` é debug/manual: NÃO deve auto-atualizar (trocaria o binário de produção
	// e os.Exit(90) fora do recovery do SCM; evita corrida com o serviço). (Codex F6/F7)
	autoUpdateEnabled = false

	cfg, err := LoadConfig()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Falha ao carregar config.json: %v\n", err)
		os.Exit(1)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	fmt.Printf("sayersync %s — ciclo único\n", Version)
	ok := runOneCycle(ctx, cfg)
	if !ok {
		// F7: ciclo com qualquer falha → exit != 0 (CI/scripts/debug detectam).
		fmt.Fprintln(os.Stderr, "Ciclo concluído COM FALHAS (ver logs acima).")
		os.Exit(1)
	}
	fmt.Println("Ciclo concluído com sucesso.")
}

// ──────────────────────────────────────────────
// discovery
// ──────────────────────────────────────────────

func cmdDiscovery() {
	cfg, err := LoadConfig()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Falha ao carregar config.json: %v\nUse 'install' primeiro ou certifique-se de que config.json existe ao lado do exe.\n", err)
		os.Exit(1)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	db, err := Connect(ctx, cfg.PGConn)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Falha ao conectar ao PostgreSQL: %v\n", err)
		os.Exit(1)
	}
	defer db.Close()

	outPath := filepath.Join(exeDir(), "sayersystem-schema.txt")
	fp, err := RunDiscovery(ctx, db, outPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Falha no discovery: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("Schema salvo em: %s\nFingerprint: %s\n", outPath, fp)
}

// ──────────────────────────────────────────────
// svcConfig — configuração do serviço Windows
// ──────────────────────────────────────────────

func svcConfig(_ *Config) *service.Config {
	return &service.Config{
		Name:        "SayerSync",
		DisplayName: "SayerSync — Colacor Tintométrico",
		Description: "Sincroniza formulas e precos do SayerSystem com o app Colacor.",
		// O SCM do Windows executa o binário com ESTES argumentos. Sem o "run",
		// o main() imprime a ajuda e sai(1) → o SCM dá timeout 1053
		// ("não respondeu a requisição de início em tempo hábil"). Bug real em campo (12/06).
		Arguments: []string{"run"},
		// Roda como LocalService (least privilege; precisa só de localhost + HTTPS de saída).
		// No Windows, 'UserName: "NT AUTHORITY\\LocalService"' seria a config ideal;
		// por simplicidade v1 usamos o usuário do sistema (LocalSystem via kardianos default).
		// DPAPI machine-scope permite que qualquer conta do sistema descriptografe o token.
		Option: service.KeyValue{
			// Reinicia automaticamente em caso de falha (OnFailure = SERVICE_RECOVERY).
			"OnFailure": "restart",
		},
	}
}

// ──────────────────────────────────────────────
// runOneCycle — delega ao RunCycle de sync.go.
// Retorna true se o ciclo foi totalmente bem-sucedido (F7).
// ──────────────────────────────────────────────

func runOneCycle(ctx context.Context, cfg *Config) bool {
	return RunCycle(ctx, cfg)
}

// ──────────────────────────────────────────────
// helpers
// ──────────────────────────────────────────────

func prompt(r *bufio.Reader, question, defaultVal string) string {
	if defaultVal != "" {
		fmt.Printf("%s [%s]: ", question, defaultVal)
	} else {
		fmt.Printf("%s: ", question)
	}
	line, _ := r.ReadString('\n')
	line = strings.TrimSpace(line)
	if line == "" {
		return defaultVal
	}
	return line
}

// exeDir retorna o diretório do executável atual (para gravar config/state/schema).
func exeDir() string {
	exe, err := os.Executable()
	if err != nil {
		return "."
	}
	return filepath.Dir(exe)
}

// logger é o logger global (inicializado abaixo para evitar init circular).
var logger svcLogger

// svcLogger é um logger simples que vai para stdout (adequado para console/service).
type svcLogger struct{}

func (svcLogger) Infof(format string, args ...any) {
	fmt.Printf("[INFO]  "+format+"\n", args...)
}
func (svcLogger) Warnf(format string, args ...any) {
	fmt.Printf("[WARN]  "+format+"\n", args...)
}
func (svcLogger) Errorf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "[ERROR] "+format+"\n", args...)
}
func (svcLogger) Info(msg string)  { logger.Infof("%s", msg) }
func (svcLogger) Warn(msg string)  { logger.Warnf("%s", msg) }
func (svcLogger) Error(msg string) { logger.Errorf("%s", msg) }

// Importações usadas nos comandos mas declaradas em outros arquivos — evita erros de compile.
var _ = (*sql.DB)(nil)
