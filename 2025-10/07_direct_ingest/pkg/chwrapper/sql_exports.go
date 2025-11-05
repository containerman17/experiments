package chwrapper

import (
	"embed"
	"io/fs"
)

//go:embed tables/*.sql
var tablesFS embed.FS

//go:embed backfill/*.sql
var backfillFS embed.FS

// GetTablesSQLFiles returns all SQL files from the tables directory
func GetTablesSQLFiles() (map[string]string, error) {
	files := make(map[string]string)

	sqlFiles, err := fs.Glob(tablesFS, "tables/*.sql")
	if err != nil {
		return nil, err
	}

	for _, filePath := range sqlFiles {
		content, err := tablesFS.ReadFile(filePath)
		if err != nil {
			return nil, err
		}
		files[filePath] = string(content)
	}

	return files, nil
}

// GetBackfillSQLFiles returns all SQL files from the backfill directory
func GetBackfillSQLFiles() (map[string]string, error) {
	files := make(map[string]string)

	sqlFiles, err := fs.Glob(backfillFS, "backfill/*.sql")
	if err != nil {
		return nil, err
	}

	for _, filePath := range sqlFiles {
		content, err := backfillFS.ReadFile(filePath)
		if err != nil {
			return nil, err
		}
		files[filePath] = string(content)
	}

	return files, nil
}
