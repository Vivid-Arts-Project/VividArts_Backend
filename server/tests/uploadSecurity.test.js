const test = require('node:test');
const assert = require('node:assert/strict');
const { detectImageType } = require('../middleware/upload');

test('profile image content is detected from trusted file signatures', () => {
  assert.deepEqual(detectImageType(Buffer.from([0xFF, 0xD8, 0xFF, 0x00])), { mimeType: 'image/jpeg', extension: '.jpg' });
  assert.deepEqual(detectImageType(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])), { mimeType: 'image/png', extension: '.png' });
  assert.deepEqual(detectImageType(Buffer.from('RIFF0000WEBP')), { mimeType: 'image/webp', extension: '.webp' });
});

test('spoofed and executable profile files are rejected by signature detection', () => {
  assert.equal(detectImageType(Buffer.from('<html><script>alert(1)</script></html>')), null);
  assert.equal(detectImageType(Buffer.from('not an image')), null);
});
