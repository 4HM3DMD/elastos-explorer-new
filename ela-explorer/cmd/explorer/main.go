package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"net/http"
	"time"

	"ela-explorer/internal/aggregator"
	"ela-explorer/internal/api"
	"ela-explorer/internal/config"
	"ela-explorer/internal/db"
	"ela-explorer/internal/node"
	"ela-explorer/internal/sync"
	"ela-explorer/internal/ws"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	})))

	slog.Info("ela-explorer starting")

	cfg, err := config.Load()
	if err != nil {
		slog.Error("failed to load config", "error", err)
		os.Exit(1)
	}

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	// Connect to PostgreSQL (two pools: syncer read-write, API read-only)
	database, err := db.Connect(ctx, cfg.SyncerDSN(), cfg.APIDSN())
	if err != nil {
		slog.Error("failed to connect to database", "error", err)
		os.Exit(1)
	}

	// Initialize schema (idempotent)
	if err := db.InitSchema(ctx, database.Syncer); err != nil {
		slog.Error("failed to initialize schema", "error", err)
		os.Exit(1)
	}

	// Create ELA node RPC client
	nodeClient := node.NewClient(cfg.NodeRPCURL, cfg.NodeRPCUser, cfg.NodeRPCPass)

	// Verify node connectivity
	height, err := nodeClient.GetBlockCount(ctx)
	if err != nil {
		slog.Error("failed to connect to ELA node", "error", err)
		os.Exit(1)
	}
	slog.Info("connected to ELA node", "chain_height", height)

	// Check sync state
	lastHeight, err := database.GetLastSyncedHeight(ctx)
	if err != nil {
		slog.Error("failed to get sync state", "error", err)
		os.Exit(1)
	}
	slog.Info("sync state",
		"last_synced_height", lastHeight,
		"chain_height", height,
		"blocks_behind", height-lastHeight,
	)

	// Start syncer in background goroutine
	syncer := sync.NewSyncer(
		nodeClient, database,
		cfg.UTXOCacheSize,
		cfg.SyncWorkers, cfg.SyncBatchSize, cfg.PollIntervalMs,
	)

	// WebSocket hub for real-time broadcasts
	wsHub := ws.NewHub(ws.HubConfig{
		CORSOrigins:     cfg.CORSOrigins,
		MaxTotalClients: cfg.WSMaxClients,
		MaxClientsPerIP: cfg.WSMaxPerIP,
	})
	syncer.OnNewBlock = func(height int64, hash string, txCount int, timestamp int64, size int, minerInfo, minerAddress string) {
		wsHub.BroadcastNewBlock(height, hash, txCount, timestamp, size, minerInfo, minerAddress)
	}

	go func() {
		if err := syncer.Run(ctx); err != nil && ctx.Err() == nil {
			slog.Error("syncer failed", "error", err)
			cancel()
		}
	}()

	// Load SEO HTML template (optional — skipped if file not found)
	seoPath := "/usr/share/nginx/html/index.html"
	if p := os.Getenv("SEO_HTML_PATH"); p != "" {
		seoPath = p
	}
	if err := api.InitSEOTemplate(seoPath); err != nil {
		slog.Warn("seo template not loaded, SEO injection disabled", "path", seoPath, "error", err)
	}

	// Start API server
	apiServer := api.NewServer(database, nodeClient, syncer, api.ServerConfig{
		CORSOrigins:      cfg.CORSOrigins,
		LRUSize:          cfg.LRUCacheSize,
		CacheTTL:         time.Duration(cfg.CacheTTLSecs) * time.Second,
		MetricsAuthToken: cfg.MetricsAuthToken,
	})
	apiServer.AttachWebSocket(wsHub)

	httpServer := &http.Server{
		Addr:         cfg.ListenAddr,
		Handler:      apiServer.Handler(),
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	go func() {
		slog.Info("API server starting", "listen", cfg.ListenAddr)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("API server failed", "error", err)
			cancel()
		}
	}()

	// Start aggregator (producer votes, CR members, daily stats, chain stats)
	agg := aggregator.New(database, nodeClient, wsHub)
	go agg.Run(ctx)

	slog.Info("ela-explorer ready", "listen", cfg.ListenAddr)

	<-ctx.Done()
	slog.Info("shutting down")

	// Graceful shutdown: HTTP server first, then wait for syncer/aggregator
	// goroutines to drain (they exit when ctx is cancelled), then close DB.
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		slog.Warn("http server shutdown error", "error", err)
	}

	// Give syncer and aggregator goroutines time to finish in-flight operations.
	// They watch ctx.Done() — allow a brief grace period for clean exit.
	time.Sleep(2 * time.Second)

	database.Close()
	slog.Info("database connections closed")
}
