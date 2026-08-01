const http = require('http');
const payload = JSON.stringify({ username: 'testuser2', email: 'test2@example.com', password: 'Secret123!' });
const req = http.request({
  host: '127.0.0.1',
  port: 3001,
  path: '/api/customers/register',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  },
}, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    console.log('status', res.statusCode);
    console.log(body);
  });
});
req.on('error', (err) => {
  console.error(err);
  process.exit(1);
});
req.write(payload);
req.end();
