const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('database.sqlite', sqlite3.OPEN_READONLY, (err) => {
  if (err) {
    console.error('OPEN_ERROR', err.message);
    process.exit(1);
  }
});

db.serialize(() => {
  db.each('PRAGMA table_info(`Customers`)', (err, row) => {
    if (err) {
      console.error('ERROR', err.message);
      return;
    }
    console.log(JSON.stringify(row));
  }, () => {
    db.close();
  });
});
