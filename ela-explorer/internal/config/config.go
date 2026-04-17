package config

import (
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
)

type Config struct {
	// ELA Node RPC
	NodeRPCURL  string
	NodeRPCUser string
	NodeRPCPass string

	// PostgreSQL
	DBHost     string
	DBPort     int
	DBName     string
	DBUser     string
	DBPassword string
	DBSSLMode  string

	// API read-only DB user (separate pool)
	DBAPIUser     string
	DBAPIPassword string

	// Server
	ListenAddr string
	CORSOrigins []string

	// Sync
	SyncWorkers   int
	SyncBatchSize int
	PollIntervalMs int

	// Cache
	UTXOCacheSize  int
	LRUCacheSize   int
	CacheTTLSecs   int

	// Pool sizes
	DBSyncerPoolSize int
	DBAPIPoolSize    int

	// WebSocket
	WSMaxClients int
	WSMaxPerIP   int

	// Security
	MetricsAuthToken string

	// Reference RPC nodes for cross-checking chain height
	ReferenceRPCURLs []string
}

func Load() (*Config, error) {
	c := &Config{
		NodeRPCURL:  envOr("ELA_NODE_RPC_URL", "http://127.0.0.1:20336"),
		NodeRPCUser: envOr("ELA_NODE_RPC_USER", ""),
		NodeRPCPass: envOr("ELA_NODE_RPC_PASS", ""),

		DBHost:     envOr("DB_HOST", "127.0.0.1"),
		DBPort:     envIntOr("DB_PORT", 5432),
		DBName:     envOr("DB_NAME", "ela_explorer"),
		DBUser:     envOr("DB_USER", "ela_indexer"),
		DBPassword: envOr("DB_PASSWORD", ""),
		DBSSLMode:  envOr("DB_SSLMODE", "disable"),

		DBAPIUser:     envOr("DB_API_USER", "ela_api"),
		DBAPIPassword: envOr("DB_API_PASSWORD", ""),

		ListenAddr:  envOr("LISTEN_ADDR", ":8338"),
		CORSOrigins: strings.Split(envOr("CORS_ORIGINS", "https://explorer.elastos.io"), ","),

		SyncWorkers:    envIntOr("SYNC_WORKERS", 8),
		SyncBatchSize:  envIntOr("SYNC_BATCH_SIZE", 100),
		PollIntervalMs: envIntOr("POLL_INTERVAL_MS", 500),

		UTXOCacheSize:  envIntOr("UTXO_CACHE_SIZE", 2000000),
		LRUCacheSize:   envIntOr("LRU_CACHE_SIZE", 10000),
		CacheTTLSecs:   envIntOr("CACHE_TTL_SECS", 30),

		DBSyncerPoolSize: envIntOr("DB_SYNCER_POOL_SIZE", 10),
		DBAPIPoolSize:    envIntOr("DB_API_POOL_SIZE", 100),

		WSMaxClients: envIntOr("WS_MAX_CLIENTS", 10000),
		WSMaxPerIP:   envIntOr("WS_MAX_PER_IP", 20),

		MetricsAuthToken: envOr("METRICS_AUTH_TOKEN", ""),

		ReferenceRPCURLs: envStringSlice("REFERENCE_RPC_URLS", nil),
	}

	if err := c.validate(); err != nil {
		return nil, err
	}
	return c, nil
}

func (c *Config) SyncerDSN() string {
	u := url.UserPassword(c.DBUser, c.DBPassword)
	return fmt.Sprintf(
		"postgres://%s@%s:%d/%s?sslmode=%s&pool_max_conns=%d",
		u.String(), c.DBHost, c.DBPort, c.DBName, c.DBSSLMode, c.DBSyncerPoolSize,
	)
}

func (c *Config) APIDSN() string {
	u := url.UserPassword(c.DBAPIUser, c.DBAPIPassword)
	return fmt.Sprintf(
		"postgres://%s@%s:%d/%s?sslmode=%s&pool_max_conns=%d&pool_min_conns=%d&pool_max_conn_lifetime=30m&pool_max_conn_idle_time=5m",
		u.String(), c.DBHost, c.DBPort, c.DBName, c.DBSSLMode, c.DBAPIPoolSize, c.DBAPIPoolSize/4,
	)
}

func (c *Config) validate() error {
	if c.DBPassword == "" {
		return fmt.Errorf("DB_PASSWORD is required")
	}
	if c.DBAPIPassword == "" {
		return fmt.Errorf("DB_API_PASSWORD is required")
	}
	if c.SyncWorkers < 1 || c.SyncWorkers > 32 {
		return fmt.Errorf("SYNC_WORKERS must be between 1 and 32, got %d", c.SyncWorkers)
	}
	if c.PollIntervalMs < 100 {
		return fmt.Errorf("POLL_INTERVAL_MS must be >= 100, got %d", c.PollIntervalMs)
	}
	return nil
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envIntOr(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}

func envStringSlice(key string, fallback []string) []string {
	if v := os.Getenv(key); v != "" {
		var result []string
		for _, s := range strings.Split(v, ",") {
			if s = strings.TrimSpace(s); s != "" {
				result = append(result, s)
			}
		}
		return result
	}
	return fallback
}
