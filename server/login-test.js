const http = require('http');
const payload = JSON.stringify({ username: 'testuserx', password: 'Secret123!' });

const req = http.request(
  {
    hostname: '127.0.0.1',
    port: 3001,
    path: '/api/customers/login',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
  },
  (res) => {
    let body = '';
    res.on('data', (chunk) => {
      body += chunk;
    });
    res.on('end', () => {
      console.log('STATUS', res.statusCode);
      console.log('BODY', body);
    });
  }
);

req.on('error', (err) => {
  console.error('ERROR', err);
});
req.write(payload);
req.end();
