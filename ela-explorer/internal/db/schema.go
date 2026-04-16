package db

import (
	"context"
	_ "embed"
	"fmt"
	"log/slog"

	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed sql/schema.sql
var schemaDDL string

func InitSchema(ctx context.Context, pool *pgxpool.Pool) error {
	slog.Info("initializing database schema")

	_, err := pool.Exec(ctx, schemaDDL)
	if err != nil {
		return fmt.Errorf("failed to execute schema DDL: %w", err)
	}

	slog.Info("database schema initialized successfully")
	return nil
}
