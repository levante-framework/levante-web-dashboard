import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const DEFAULT_PUBLIC_URL = 'https://storage.googleapis.com/levante-assets-dev/language_config.json';

test('dev bucket language_config.json is publicly readable', async () => {
  const response = await fetch(DEFAULT_PUBLIC_URL, { cache: 'no-store' });
  assert.equal(response.ok, true, `expected 200 from ${DEFAULT_PUBLIC_URL}`);
  const payload = await response.json();
  assert.ok(payload && typeof payload === 'object');
  assert.ok(payload.languages && typeof payload.languages === 'object');
  assert.ok(Object.keys(payload.languages).length > 0);
});

test('language-config GET falls back to public URL without GCP credentials', () => {
  const script = `
    import handler from './api/language-config.js';
    const resState = { statusCode: 0, headers: {} };
    const res = {
      setHeader(k, v) { resState.headers[k] = v; },
      status(code) { resState.statusCode = code; return this; },
      json(body) {
        if (!body?.success || !body?.languages) {
          console.error(JSON.stringify(body));
          process.exit(2);
        }
        if (!body.languages['English (United Kingdom)'] && !Object.values(body.languages).some((cfg) => String(cfg?.lang_code || '').toLowerCase() === 'en-gb')) {
          console.error('expected en-GB language entry in public config');
          process.exit(3);
        }
        process.exit(0);
      },
      end() { process.exit(1); },
    };
    await handler({ method: 'GET' }, res);
  `;

  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      PATH: process.env.PATH,
      AUDIO_DEV_BUCKET: 'levante-assets-dev',
      LANGUAGE_CONFIG_OBJECT: 'language_config.json',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout || 'handler fallback test failed');
});
