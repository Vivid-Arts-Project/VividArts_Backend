const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeMessage } = require('../utils/messageRules');
const { normalizeCustomerProfileUpdate } = require('../utils/customerProfileRules');

test('messages are trimmed and limited to 2000 characters', () => {
  assert.equal(normalizeMessage('  Hello  '), 'Hello');
  assert.throws(() => normalizeMessage('   '), { code: 'MESSAGE_REQUIRED' });
  assert.throws(() => normalizeMessage('x'.repeat(2001)), { code: 'MESSAGE_TOO_LONG' });
});

test('profile updates normalize editable contact details', () => {
  assert.deepEqual(normalizeCustomerProfileUpdate({ fullName: '  Jane   Doe ', phoneNumber: '+94 77 123 4567' }, {
    full_name: 'Jane', phone_number: '', username: 'jane', email: 'jane@example.com',
  }), { full_name: 'Jane Doe', phone_number: '+94 77 123 4567' });
});

test('profile updates cannot change unverified identity fields', () => {
  const current = { full_name: 'Jane', phone_number: '', username: 'jane', email: 'jane@example.com' };
  assert.throws(() => normalizeCustomerProfileUpdate({ username: 'other' }, current), { code: 'USERNAME_CHANGE_NOT_ALLOWED' });
  assert.throws(() => normalizeCustomerProfileUpdate({ email: 'other@example.com' }, current), { code: 'EMAIL_VERIFICATION_REQUIRED' });
});
