const test = require('node:test');
const assert = require('node:assert/strict');

const ota = require('../api/lib/crowdin-ota-client.js');

function withOtaMode(testFn) {
  return async () => {
    const previousHash = process.env.CROWDIN_DISTRIBUTION_HASH;
    const previousToken = process.env.CROWDIN_API_TOKEN;
    process.env.CROWDIN_DISTRIBUTION_HASH = 'test-distribution-hash';
    delete process.env.CROWDIN_API_TOKEN;
    ota.__setOtaClientForTests(null);
    try {
      await testFn();
    } finally {
      ota.__setOtaClientForTests(null);
      if (previousHash === undefined) delete process.env.CROWDIN_DISTRIBUTION_HASH;
      else process.env.CROWDIN_DISTRIBUTION_HASH = previousHash;
      if (previousToken === undefined) delete process.env.CROWDIN_API_TOKEN;
      else process.env.CROWDIN_API_TOKEN = previousToken;
    }
  };
}

test('throws clear error when no translation source config exists', async () => {
  const previousHash = process.env.CROWDIN_DISTRIBUTION_HASH;
  const previousToken = process.env.CROWDIN_API_TOKEN;
  delete process.env.CROWDIN_DISTRIBUTION_HASH;
  delete process.env.CROWDIN_API_TOKEN;
  ota.__setOtaClientForTests(null);
  try {
    await assert.rejects(() => ota.listLanguages(), /CROWDIN_DISTRIBUTION_HASH|CROWDIN_API_TOKEN/);
  } finally {
    ota.__setOtaClientForTests(null);
    if (previousHash !== undefined) process.env.CROWDIN_DISTRIBUTION_HASH = previousHash;
    if (previousToken !== undefined) process.env.CROWDIN_API_TOKEN = previousToken;
  }
});

test('listFiles returns sorted union of manifest content files', withOtaMode(async () => {
  ota.__setOtaClientForTests({
    getContent: async () => ({
      'en-US': ['a.json', 'b.json'],
      'es-AR': ['b.json', 'c.json'],
    }),
  });
  const files = await ota.listFiles();
  assert.deepEqual(files, ['a.json', 'b.json', 'c.json']);
}));

test('getTranslations parses json string content when possible', withOtaMode(async () => {
  ota.__setOtaClientForTests({
    getLanguageTranslations: async () => ([
      { file: 'messages.json', content: '{"hello":"world"}' },
    ]),
  });
  const content = await ota.getTranslations('en-US', 'messages.json');
  assert.deepEqual(content, { hello: 'world' });
}));
