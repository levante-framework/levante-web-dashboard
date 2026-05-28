const test = require('node:test');
const assert = require('node:assert/strict');

const ota = require('../api/lib/crowdin-ota-client.js');

test('throws clear error when distribution hash is missing', () => {
  const previousHash = process.env.CROWDIN_DISTRIBUTION_HASH;
  delete process.env.CROWDIN_DISTRIBUTION_HASH;
  ota.__setOtaClientForTests(null);
  try {
    assert.throws(() => ota.getOtaClient(), /CROWDIN_DISTRIBUTION_HASH/);
  } finally {
    ota.__setOtaClientForTests(null);
    if (previousHash !== undefined) process.env.CROWDIN_DISTRIBUTION_HASH = previousHash;
  }
});

test('listFiles returns sorted union of manifest content files', async () => {
  ota.__setOtaClientForTests({
    getContent: async () => ({
      'en-US': ['a.json', 'b.json'],
      'es-AR': ['b.json', 'c.json'],
    }),
  });
  try {
    const files = await ota.listFiles();
    assert.deepEqual(files, ['a.json', 'b.json', 'c.json']);
  } finally {
    ota.__setOtaClientForTests(null);
  }
});

test('getTranslations parses json string content when possible', async () => {
  ota.__setOtaClientForTests({
    getLanguageTranslations: async () => ([
      { file: 'messages.json', content: '{"hello":"world"}' },
    ]),
  });
  try {
    const content = await ota.getTranslations('en-US', 'messages.json');
    assert.deepEqual(content, { hello: 'world' });
  } finally {
    ota.__setOtaClientForTests(null);
  }
});
