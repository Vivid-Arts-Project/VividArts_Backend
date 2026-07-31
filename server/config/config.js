require('dotenv').config();

const env = process.env.NODE_ENV || 'development';

// If explicit DB variables are provided, use them. Otherwise default to
// a lightweight SQLite DB for local development and testing.
const useSqlite = (!process.env.DB_DIALECT && env !== 'production') || process.env.DB_DIALECT === 'sqlite';

if (useSqlite) {
  module.exports = {
    development: {
      dialect: 'sqlite',
      storage: './database.sqlite'
    },
    test: {
      dialect: 'sqlite',
      storage: './database.sqlite'
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
