package db

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strconv"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type DB struct {
	Syncer *pgxpool.Pool // read-write, used by the syncer
	API    *pgxpool.Pool // read-only, used by the API layer
}

func Connect(ctx context.Context, syncerDSN, apiDSN string) (*DB, error) {
	syncerPool, err := pgxpool.New(ctx, syncerDSN)
	if err != nil {
		return nil, fmt.Errorf("connect syncer pool: %w", err)
	}
	if err := syncerPool.Ping(ctx); err != nil {
		syncerPool.Close()
		return nil, fmt.Errorf("ping syncer pool: %w", err)
	}
	slog.Info("syncer DB pool connected",
		"max_conns", syncerPool.Config().MaxConns,
	)

	apiPool, err := pgxpool.New(ctx, apiDSN)
	if err != nil {
		syncerPool.Close()
		return nil, fmt.Errorf("connect API pool: %w", err)
	}
	if err := apiPool.Ping(ctx); err != nil {
		syncerPool.Close()
		apiPool.Close()
		return nil, fmt.Errorf("ping API pool: %w", err)
	}
	slog.Info("API DB pool connected",
		"max_conns", apiPool.Config().MaxConns,
	)

	return &DB{Syncer: syncerPool, API: apiPool}, nil
}

func (db *DB) Close() {
	if db.Syncer != nil {
		db.Syncer.Close()
	}
	if db.API != nil {
		db.API.Close()
	}
}

// --- Sync State helpers ---

func (db *DB) GetSyncState(ctx context.Context, key string) (string, error) {
	var value string
	err := db.Syncer.QueryRow(ctx,
		"SELECT value FROM sync_state WHERE key = $1", key,
	).Scan(&value)
	if err != nil {
		return "", err
	}
	return value, nil
}

func (db *DB) SetSyncState(ctx context.Context, key, value string) error {
	_, err := db.Syncer.Exec(ctx,
		"INSERT INTO sync_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2",
		key, value,
	)
	return err
}

func (db *DB) GetLastSyncedHeight(ctx context.Context) (int64, error) {
	val, err := db.GetSyncState(ctx, "last_height")
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, nil
		}
		return 0, fmt.Errorf("get last synced height: %w", err)
	}
	h, err := strconv.ParseInt(val, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("parse last_height %q: %w", val, err)
	}
	return h, nil
}

func (db *DB) GetLastSyncedHash(ctx context.Context) (string, error) {
	return db.GetSyncState(ctx, "last_hash")
}

func (db *DB) IsInitialSync(ctx context.Context) (bool, error) {
	val, err := db.GetSyncState(ctx, "is_initial_sync")
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return true, nil
		}
		return false, fmt.Errorf("check initial sync: %w", err)
	}
	return val != "false", nil
}

// GetBlockHashAtHeight looks up the stored hash for a given height.
// Used during reorg detection.
func (db *DB) GetBlockHashAtHeight(ctx context.Context, height int64) (string, error) {
	var hash string
	err := db.Syncer.QueryRow(ctx,
		"SELECT hash FROM blocks WHERE height = $1", height,
	).Scan(&hash)
	if err != nil {
		return "", fmt.Errorf("get block hash at height %d: %w", height, err)
	}
	return hash, nil
}

// DeleteBlocksAbove removes all blocks (and cascaded data) above the given height.
// Used during reorg rollback.
func (db *DB) DeleteBlocksAbove(ctx context.Context, height int64) (int64, error) {
	tag, err := db.Syncer.Exec(ctx,
		"DELETE FROM blocks WHERE height > $1", height,
	)
	if err != nil {
		return 0, fmt.Errorf("delete blocks above %d: %w", height, err)
	}
	return tag.RowsAffected(), nil
}
