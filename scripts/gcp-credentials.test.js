import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  getStorageClientFromEnv,
  parseGcpCredentialsFromEnv,
} from '../api/lib/gcp-credentials.js';

function mockStorage() {
  return function Storage(opts = {}) {
    this.credentials = opts.credentials || null;
    this.projectId = opts.projectId || null;
    this.mode = opts.credentials ? 'explicit' : 'adc';
  };
}

function withEnv(overrides, fn) {
  const saved = {
    GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    GCP_SERVICE_ACCOUNT_JSON: process.env.GCP_SERVICE_ACCOUNT_JSON,
    GOOGLE_APPLICATION_CREDENTIALS_JSON: process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON,
  };
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  delete process.env.GCP_SERVICE_ACCOUNT_JSON;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  Object.assign(process.env, overrides);
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('parseGcpCredentialsFromEnv reads credentials from a file path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gcp-cred-'));
  const keyPath = join(dir, 'key.json');
  writeFileSync(keyPath, JSON.stringify({ type: 'service_account', project_id: 'file-proj' }));
  try {
    withEnv({ GCP_SERVICE_ACCOUNT_JSON: keyPath }, () => {
      const credentials = parseGcpCredentialsFromEnv();
      assert.equal(credentials.project_id, 'file-proj');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getStorageClientFromEnv uses explicit credentials from inline JSON', () => {
  withEnv({
    GCP_SERVICE_ACCOUNT_JSON: '{"type":"service_account","project_id":"inline-proj"}',
  }, () => {
    const Storage = mockStorage();
    const client = getStorageClientFromEnv(Storage);
    assert.ok(client);
    assert.equal(client.mode, 'explicit');
    assert.equal(client.projectId, 'inline-proj');
  });
});

test('getStorageClientFromEnv falls back to ADC when credential env vars are unset', () => {
  withEnv({}, () => {
    const Storage = mockStorage();
    const client = getStorageClientFromEnv(Storage);
    assert.ok(client);
    assert.equal(client.mode, 'adc');
  });
});

test('getStorageClientFromEnv returns null when configured credentials are invalid', () => {
  withEnv({
    GCP_SERVICE_ACCOUNT_JSON: '{not-valid-json',
  }, () => {
    const Storage = mockStorage();
    const client = getStorageClientFromEnv(Storage);
    assert.equal(client, null);
  });
});
