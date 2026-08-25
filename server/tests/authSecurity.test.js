const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { createCustomerLoginLimiter } = require('../middleware/customerLoginLimiter');
const { createAdminLoginLimiter } = require('../middleware/adminLoginLimiter');
const { createAdminRegistrationLimiter } = require('../middleware/adminRegistrationLimiter');
const { createVerificationRequestLimiter } = require('../middleware/verificationRequestLimiter');
const { decodedTokenVersion, tokenVersionMatches } = require('../middleware/authMiddleware');
const {
  MIN_BCRYPT_ROUNDS,
  CUSTOMER_BCRYPT_ROUNDS,
  resolveBcryptRounds,
  hashCustomerPassword,
  customerPasswordNeedsRehash,
} = require('../utils/passwordHash');

function responseStub() {
  return {
    statusCode: 200,
    headers: {},
    set(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

function invoke(limiter, { username = 'customer', ip = '127.0.0.1' } = {}) {
  const req = { body: { username }, ip };
  const res = responseStub();
  let continued = false;
  limiter(req, res, () => { continued = true; });
  return { req, res, continued };
}

test('customer password hashes use at least bcrypt cost 12', async () => {
  const hash = await hashCustomerPassword('correct horse battery staple');
  assert.ok(CUSTOMER_BCRYPT_ROUNDS >= MIN_BCRYPT_ROUNDS);
  assert.ok(bcrypt.getRounds(hash) >= MIN_BCRYPT_ROUNDS);
  assert.equal(customerPasswordNeedsRehash(hash), false);
  assert.equal(customerPasswordNeedsRehash(await bcrypt.hash('old password', 4)), true);
});

test('unsafe production bcrypt configuration is rejected and development is clamped', () => {
  assert.throws(
    () => resolveBcryptRounds({ nodeEnv: 'production', configuredRounds: '4' }),
    /at least 12/,
  );
  assert.equal(resolveBcryptRounds({ nodeEnv: 'development', configuredRounds: '4' }), 12);
});

test('customer token versions revoke old tokens while accepting legacy version zero', () => {
  assert.equal(decodedTokenVersion({}), 0);
  assert.equal(tokenVersionMatches({}, { token_version: 0 }), true);
  assert.equal(tokenVersionMatches({ tokenVersion: 0 }, { token_version: 1 }), false);
  assert.equal(tokenVersionMatches({ tokenVersion: 2 }, { token_version: 2 }), true);
});

test('customer account is locked after repeated failed logins across IP addresses', () => {
  let timestamp = 1_000;
  const limiter = createCustomerLoginLimiter({
    now: () => timestamp,
    maxAccountFailures: 3,
    maxIpFailures: 50,
    lockMs: 60_000,
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = invoke(limiter, { username: 'person@example.com', ip: `10.0.0.${attempt + 1}` });
    assert.equal(result.continued, true);
    result.req.customerLoginAttempt.failed();
    timestamp += 10;
  }

  const blocked = invoke(limiter, { username: 'PERSON@example.com', ip: '10.0.0.99' });
  assert.equal(blocked.continued, false);
  assert.equal(blocked.res.statusCode, 429);
  assert.ok(Number(blocked.res.headers['Retry-After']) > 0);
});

test('customer IP is locked after failures against multiple accounts', () => {
  const limiter = createCustomerLoginLimiter({ maxAccountFailures: 50, maxIpFailures: 2 });
  for (const username of ['first@example.com', 'second@example.com']) {
    const result = invoke(limiter, { username, ip: '10.10.10.10' });
    result.req.customerLoginAttempt.failed();
  }
  const blocked = invoke(limiter, { username: 'third@example.com', ip: '10.10.10.10' });
  assert.equal(blocked.res.statusCode, 429);
  assert.equal(blocked.continued, false);
});

test('admin account is locked after failures distributed across IP addresses', () => {
  const limiter = createAdminLoginLimiter({ maxAccountFailures: 3, maxIpFailures: 50 });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = invoke(limiter, { username: 'studio-admin', ip: `10.20.0.${attempt + 1}` });
    result.req.adminLoginAttempt.failed();
  }
  const blocked = invoke(limiter, { username: 'STUDIO-ADMIN', ip: '10.20.0.99' });
  assert.equal(blocked.res.statusCode, 429);
  assert.equal(blocked.continued, false);
});

test('admin IP is locked when usernames are rotated', () => {
  const limiter = createAdminLoginLimiter({ maxAccountFailures: 50, maxIpFailures: 2 });
  for (const username of ['unknown-1', 'unknown-2']) {
    const result = invoke(limiter, { username, ip: '10.30.0.1' });
    result.req.adminLoginAttempt.failed();
  }
  const blocked = invoke(limiter, { username: 'unknown-3', ip: '10.30.0.1' });
  assert.equal(blocked.res.statusCode, 429);
  assert.equal(blocked.continued, false);
});

test('admin login limiter keeps its in-memory key maps bounded', () => {
  const limiter = createAdminLoginLimiter({
    maxAccountFailures: 50,
    maxIpFailures: 50,
    maxTrackedKeys: 3,
  });
  for (let index = 0; index < 12; index += 1) {
    const result = invoke(limiter, { username: `rotated-${index}`, ip: `192.0.2.${index}` });
    result.req.adminLoginAttempt.failed();
  }
  assert.deepEqual(limiter.trackedKeyCounts(), { accounts: 3, ips: 3 });
});

test('admin registration limiter blocks identity rotation from one IP', () => {
  const limiter = createAdminRegistrationLimiter({ maxIpRequests: 2, maxIdentityRequests: 20 });
  for (const username of ['applicant-1', 'applicant-2']) {
    assert.equal(invoke(limiter, { username, ip: '198.51.100.8' }).continued, true);
  }
  const blocked = invoke(limiter, { username: 'applicant-3', ip: '198.51.100.8' });
  assert.equal(blocked.continued, false);
  assert.equal(blocked.res.statusCode, 429);
});

test('admin registration limiter blocks reuse of an email across usernames', () => {
  const limiter = createAdminRegistrationLimiter({ maxIpRequests: 20, maxIdentityRequests: 2 });
  const call = username => {
    const req = { body: { username, email: 'same@example.com' }, ip: `203.0.113.${username.at(-1)}` };
    const res = responseStub();
    let continued = false;
    limiter(req, res, () => { continued = true; });
    return { res, continued };
  };
  assert.equal(call('applicant-1').continued, true);
  assert.equal(call('applicant-2').continued, true);
  const blocked = call('applicant-3');
  assert.equal(blocked.continued, false);
  assert.equal(blocked.res.statusCode, 429);
});

test('admin registration limiter keeps request tracking bounded', () => {
  const limiter = createAdminRegistrationLimiter({
    maxIpRequests: 50,
    maxIdentityRequests: 50,
    maxTrackedKeys: 4,
  });
  for (let index = 0; index < 12; index += 1) {
    const req = { body: { username: `user-${index}`, email: `user-${index}@example.com` }, ip: `192.0.2.${index}` };
    limiter(req, responseStub(), () => {});
  }
  const counts = limiter.trackedKeyCounts();
  assert.ok(counts.ips <= 4);
  assert.ok(counts.identities <= 4);
});

test('verification email requests are rate limited by IP across email addresses', () => {
  const limiter = createVerificationRequestLimiter({ maxIpRequests: 2 });
  assert.equal(invoke(limiter, { username: 'first@example.com', ip: '203.0.113.20' }).continued, true);
  assert.equal(invoke(limiter, { username: 'second@example.com', ip: '203.0.113.20' }).continued, true);
  const blocked = invoke(limiter, { username: 'third@example.com', ip: '203.0.113.20' });
  assert.equal(blocked.continued, false);
  assert.equal(blocked.res.statusCode, 429);
});
