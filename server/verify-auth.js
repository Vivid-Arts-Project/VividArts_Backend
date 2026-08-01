const http = require('http');
const sqlite3 = require('sqlite3').verbose();

const payload = JSON.stringify({ username: 'testuser7', email: 'test7@example.com', password: 'Secret123!' });

const req = http.request({
  hostname: '127.0.0.1',
  port: 3001,
  path: '/api/customers/register',
  method: 'POST',
  headers: { 'Content-Type': 'application/json' }
}, (res) => {
  let body = '';
  res.on('data', (chunk) => { body += chunk; });
  res.on('end', () => {
    console.log('REGISTER_RESPONSE=' + body);
    const db = new sqlite3.Database('./database.sqlite', (err) => {
      if (err) {
        console.error('DB_OPEN_ERROR=' + err.message);
        process.exit(1);
      }
      db.all(
        'SELECT username, email, password_hash FROM Customers WHERE username=? OR email=? ORDER BY customer_id DESC LIMIT 5',
        ['testuser7', 'test7@example.com'],
        (dbErr, rows) => {
          if (dbErr) {
            console.error('DB_QUERY_ERROR=' + dbErr.message);
            process.exit(1);
          }
          console.log('DB_ROWS=' + JSON.stringify(rows));
          db.close();
        }
      );
    });
  });
});

req.on('error', (err) => {
  console.error('REQUEST_ERROR=' + err.message);
  process.exit(1);
});

req.write(payload);
req.end();
