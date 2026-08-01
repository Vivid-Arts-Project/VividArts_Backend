const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('database.sqlite', sqlite3.OPEN_READONLY, (err) => {
  if (err) { console.error('OPEN_ERROR', err.message); process.exit(1); }
});

db.serialize(() => {
  db.all('SELECT customer_id, username, email FROM Customers ORDER BY customer_id DESC LIMIT 50', (err, rows) => {
    if (err) { console.error('QUERY_ERROR', err.message); db.close(); return; }
    console.log('ROWS:', rows);
    db.close();
  });
});
