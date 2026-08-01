require('dotenv').config();
const path = require('path');

const env = process.env.NODE_ENV || 'development';

// If explicit DB variables are provided, use them. Otherwise default to
// a lightweight SQLite DB for local development and testing.
const useSqlite = (!process.env.DB_DIALECT && env !== 'production') || process.env.DB_DIALECT === 'sqlite';

// Always resolve this relative to the backend folder, not the command prompt.
// This prevents Node from accidentally opening the older database.sqlite in the
// project root when the server is launched from a different directory.
const localDatabasePath = path.resolve(__dirname, '..', 'database.sqlite');

if (useSqlite) {
  module.exports = {
    development: {
      dialect: 'sqlite',
      storage: localDatabasePath
    },
    test: {
      dialect: 'sqlite',
      storage: localDatabasePath
    },
    production: {
      username: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || null,
      database: process.env.DB_NAME || 'production_db',
      host: process.env.DB_HOST || '127.0.0.1',
      dialect: process.env.DB_DIALECT || 'mysql'
    }
  };
} else {
  const base = {
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    host: process.env.DB_HOST,
    dialect: process.env.DB_DIALECT || 'mysql'
  };

  module.exports = {
    development: base,
    test: base,
    production: base
  };
}
