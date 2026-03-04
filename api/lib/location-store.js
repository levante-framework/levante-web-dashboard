/**
 * Cloud-friendly Location storage helpers for Firestore (REST API).
 *
 * Requires @levante-framework/levante-zod version that exports:
 * - LocationSchema
 * - locationDocId
 */

const DEFAULT_COLLECTION = 'locations';

function assertString(value, fieldName) {
  if (!value || typeof value !== 'string') {
    throw new Error(`${fieldName} is required`);
  }
  return value;
}

function convertJsToFirestoreValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Cannot serialize non-finite number to Firestore');
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return {
      arrayValue: {
        values: value.map((entry) => convertJsToFirestoreValue(entry)),
      },
    };
  }
  if (typeof value === 'object') {
    const fields = {};
    Object.entries(value).forEach(([key, entry]) => {
      if (entry !== undefined) {
        fields[key] = convertJsToFirestoreValue(entry);
      }
    });
    return { mapValue: { fields } };
  }
  throw new Error(`Unsupported Firestore value type: ${typeof value}`);
}

function convertFirestoreToJs(value) {
  if (!value || typeof value !== 'object') return value;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.integerValue !== undefined) return parseInt(value.integerValue, 10);
  if (value.doubleValue !== undefined) return Number(value.doubleValue);
  if (value.booleanValue !== undefined) return value.booleanValue;
  if (value.timestampValue !== undefined) return value.timestampValue;
  if (value.nullValue !== undefined) return null;
  if (value.arrayValue) {
    const values = Array.isArray(value.arrayValue.values) ? value.arrayValue.values : [];
    return values.map((entry) => convertFirestoreToJs(entry));
  }
  if (value.mapValue) {
    const fields = value.mapValue.fields || {};
    const out = {};
    Object.entries(fields).forEach(([key, entry]) => {
      out[key] = convertFirestoreToJs(entry);
    });
    return out;
  }
  return value;
}

function toFirestoreFields(documentData) {
  const fieldMap = {};
  Object.entries(documentData).forEach(([key, value]) => {
    if (value !== undefined) {
      fieldMap[key] = convertJsToFirestoreValue(value);
    }
  });
  return fieldMap;
}

function fromFirestoreFields(fields) {
  const out = {};
  Object.entries(fields || {}).forEach(([key, value]) => {
    out[key] = convertFirestoreToJs(value);
  });
  return out;
}

async function getServiceAccountAccessToken() {
  const serviceAccountJson = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!serviceAccountJson) {
    throw new Error('Missing service account JSON in GCP_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS_JSON');
  }

  const credentials = JSON.parse(serviceAccountJson);
  const { GoogleAuth } = await import('google-auth-library');
  const auth = new GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/datastore'],
  });
  const client = await auth.getClient();
  const accessToken = await client.getAccessToken();
  if (!accessToken || !accessToken.token) {
    throw new Error('Failed to obtain Firestore access token');
  }
  return accessToken.token;
}

async function loadLocationValidators() {
  let sdk;
  try {
    sdk = await import('@levante-framework/levante-zod');
  } catch (error) {
    throw new Error(
      'Could not load @levante-framework/levante-zod. Install a version that exports LocationSchema and locationDocId.'
    );
  }
  const { LocationSchema, locationDocId } = sdk;
  if (!LocationSchema || typeof locationDocId !== 'function') {
    throw new Error('Installed @levante-framework/levante-zod does not export LocationSchema/locationDocId');
  }
  return { LocationSchema, locationDocId };
}

function buildDocUrl(projectId, collection, docId) {
  const safeProjectId = assertString(projectId, 'projectId');
  const safeCollection = assertString(collection || DEFAULT_COLLECTION, 'collection');
  const safeDocId = assertString(docId, 'docId');
  return `https://firestore.googleapis.com/v1/projects/${safeProjectId}/databases/(default)/documents/${safeCollection}/${encodeURIComponent(safeDocId)}`;
}

async function saveLocation({
  projectId,
  location,
  collection = DEFAULT_COLLECTION,
  accessToken,
}) {
  const { LocationSchema, locationDocId } = await loadLocationValidators();
  const parsed = LocationSchema.parse(location);
  const docId = locationDocId(parsed);
  const url = buildDocUrl(projectId, collection, docId);
  const token = accessToken || await getServiceAccountAccessToken();

  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      fields: toFirestoreFields(parsed),
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Firestore saveLocation failed (${response.status}): ${body}`);
  }

  return {
    id: docId,
    path: `${collection}/${docId}`,
    location: parsed,
  };
}

async function getLocation({
  projectId,
  docId,
  collection = DEFAULT_COLLECTION,
  accessToken,
}) {
  const { LocationSchema } = await loadLocationValidators();
  const url = buildDocUrl(projectId, collection, docId);
  const token = accessToken || await getServiceAccountAccessToken();

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (response.status === 404) return null;
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Firestore getLocation failed (${response.status}): ${body}`);
  }

  const payload = await response.json();
  const parsed = LocationSchema.parse(fromFirestoreFields(payload.fields || {}));
  return parsed;
}

module.exports = {
  saveLocation,
  getLocation,
  getServiceAccountAccessToken,
};
