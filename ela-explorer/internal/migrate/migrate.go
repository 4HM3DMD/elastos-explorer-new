package migrate

import (
	"database/sql"
	"errors"
	"fmt"
	"log/slog"

	gomigrate "github.com/golang-migrate/migrate/v4"
	gomigratepostgres "github.com/golang-migrate/migrate/v4/database/postgres"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	_ "github.com/lib/pq"

	appmigrations "ela-explorer/migrations"
)

// RunMigrations applies all embedded SQL migrations to the database at dsn using golang-migrate
// and the PostgreSQL driver (database/sql + lib/pq).
func RunMigrations(dsn string) error {
	slog.Info("migrate: opening database for migrations")

	db, err := sql.Open("postgres", dsn)
	if err != nil {
		return fmt.Errorf("migrate: open db: %w", err)
	}
	defer db.Close()

	if err := db.Ping(); err != nil {
		return fmt.Errorf("migrate: ping: %w", err)
	}

	driver, err := gomigratepostgres.WithInstance(db, &gomigratepostgres.Config{})
	if err != nil {
		return fmt.Errorf("migrate: postgres driver: %w", err)
	}

	sourceDriver, err := iofs.New(appmigrations.FS, ".")
	if err != nil {
		return fmt.Errorf("migrate: iofs source: %w", err)
	}

	m, err := gomigrate.NewWithInstance("iofs", sourceDriver, "postgres", driver)
	if err != nil {
		return fmt.Errorf("migrate: new migrate instance: %w", err)
	}
	defer func() {
		srcErr, dbErr := m.Close()
		if srcErr != nil {
			slog.Error("migrate: close source", "error", srcErr)
		}
		if dbErr != nil {
			slog.Error("migrate: close database", "error", dbErr)
		}
	}()

	curVersion, dirty, verr := m.Version()
	switch {
	case verr == nil:
		slog.Info("migrate: current schema version", "version", curVersion, "dirty", dirty)
		if dirty {
			return fmt.Errorf("migrate: database is dirty at version %d", curVersion)
		}
	case errors.Is(verr, gomigrate.ErrNilVersion):
		slog.Info("migrate: no schema version yet (fresh database)")
	default:
		return fmt.Errorf("migrate: read version: %w", verr)
	}

	slog.Info("migrate: applying up migrations")
	if err := m.Up(); err != nil {
		if errors.Is(err, gomigrate.ErrNoChange) {
			slog.Info("migrate: already up to date")
			return nil
		}
		return fmt.Errorf("migrate: up: %w", err)
	}

	newVersion, dirtyAfter, err := m.Version()
	if err != nil {
		return fmt.Errorf("migrate: read version after up: %w", err)
	}
	if dirtyAfter {
		return fmt.Errorf("migrate: database marked dirty at version %d", newVersion)
	}

	slog.Info("migrate: migrations complete", "version", newVersion)
	return nil
}
