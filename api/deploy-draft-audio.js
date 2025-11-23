import { Storage } from '@google-cloud/storage';

const DEFAULT_BUCKET = 'levante-assets-draft';

let storageClient = null;
function getStorage() {
    if (storageClient) return storageClient;
    try {
        const json = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || process.env.GCP_SERVICE_ACCOUNT_JSON;
        if (!json) throw new Error('Missing GOOGLE_APPLICATION_CREDENTIALS_JSON');
        const credentials = JSON.parse(json);
        storageClient = new Storage({ credentials, projectId: credentials.project_id });
        return storageClient;
    } catch (error) {
        console.warn('GCS init failed', error);
        return null;
    }
}

function sanitizeBucketName(value) {
    const trimmed = String(value || '').trim();
    if (!trimmed) return '';
    return trimmed.toLowerCase().replace(/[\s]/g, '-');
}

function sanitizePath(value) {
    if (!value) return '';
    return String(value)
        .replace(/\\/g, '/')
        .split('/')
        .filter(segment => segment && segment !== '.' && segment !== '..')
        .join('/');
}

function sanitizeSegment(segment) {
    if (!segment) return '';
    return segment.toString().trim().replace(/[^A-Za-z0-9_.-]/g, '-');
}

function splitFileName(fileName) {
    const lastDot = fileName.lastIndexOf('.');
    if (lastDot === -1) {
        return { base: fileName, extension: '' };
    }
    return {
        base: fileName.slice(0, lastDot),
        extension: fileName.slice(lastDot)
    };
}

function removeVersionSuffix(baseName) {
    if (!baseName) return baseName;
    let current = baseName;
    const versionRegex = /(?:[_-](?:v)?\d{3,})$/i;
    while (versionRegex.test(current)) {
        const next = current.replace(versionRegex, '');
        if (!next.trim()) break;
        current = next;
    }
    return current || baseName;
}

function computeRootFromFileName(fileName) {
    const { base } = splitFileName(fileName || '');
    return removeVersionSuffix(base) || base;
}

function buildDeployTarget(entry, sanitizedPath) {
    const segments = sanitizedPath.split('/');
    const fileName = segments.pop() || '';
    const { base, extension } = splitFileName(fileName);
    const rootName = removeVersionSuffix(base) || base || 'audio';

    let language = sanitizeSegment(entry.language || '');
    if (!language && segments.length >= 2 && segments[0] === 'audio') {
        language = sanitizeSegment(segments[1]);
    }
    if (!language && segments.length >= 1) {
        language = sanitizeSegment(segments[segments.length - 1]);
    }
    if (!language) {
        language = 'unknown';
    }

    const ext = extension || '.mp3';
    const destinationPath = sanitizePath(`deploy/${language}/${rootName}${ext}`);

    return {
        language,
        rootName,
        extension: ext,
        destinationPath
    };
}

function parseSelectedFiles(files, bucketOverride) {
    const bucketsMap = new Map();

    files.forEach((entry) => {
        const bucketName = sanitizeBucketName(entry.bucket || bucketOverride || DEFAULT_BUCKET);
        const path = sanitizePath(entry.path);
        if (!bucketName || !path) return;

        const target = buildDeployTarget(entry, path);
        const key = `${target.language}:::${target.rootName}`;

        if (!bucketsMap.has(bucketName)) {
            bucketsMap.set(bucketName, new Map());
        }
        const bucketEntries = bucketsMap.get(bucketName);

        if (!bucketEntries.has(key)) {
            bucketEntries.set(key, {
                bucket: bucketName,
                sourcePath: path,
                language: target.language,
                rootName: target.rootName,
                destinationPath: target.destinationPath
            });
        } else {
            // Overwrite with the most recent selection (assumed to be the desired version)
            bucketEntries.set(key, {
                bucket: bucketName,
                sourcePath: path,
                language: target.language,
                rootName: target.rootName,
                destinationPath: target.destinationPath
            });
        }
    });

    return bucketsMap;
}

async function ensureFileExists(file, description) {
    const [exists] = await file.exists();
    if (!exists) {
        throw new Error(`${description} not found: gs://${file.bucket.name}/${file.name}`);
    }
}

async function copyIntoDeploy(bucket, record) {
    const sourceFile = bucket.file(record.sourcePath);
    const destinationFile = bucket.file(record.destinationPath);

    if (record.sourcePath === record.destinationPath) {
        await ensureFileExists(destinationFile, 'Approved audio');
        return { copied: false };
    }

    await ensureFileExists(sourceFile, 'Source audio');
    await sourceFile.copy(destinationFile);
    return { copied: true };
}

async function collectVersionedFiles(bucket, prefixPath, rootName) {
    const sanitizedPrefix = sanitizePath(prefixPath);
    if (!sanitizedPrefix) return [];

    const [files] = await bucket.getFiles({ prefix: sanitizedPrefix });
    return files.filter((file) => {
        const name = file.name || '';
        const fileName = name.split('/').pop() || '';
        const candidateRoot = computeRootFromFileName(fileName);
        return candidateRoot === rootName;
    });
}

async function moveDraftsWithinBucket(bucket, record) {
    const deleteSet = new Set();
    const { copied } = await copyIntoDeploy(bucket, record);

    if (copied && record.sourcePath) {
        deleteSet.add(record.sourcePath);
    }

    const audioPrefix = `audio/${record.language}/${record.rootName}`;
    const deployPrefix = `deploy/${record.language}/${record.rootName}`;

    const audioFiles = await collectVersionedFiles(bucket, audioPrefix, record.rootName);
    audioFiles.forEach((file) => {
        const name = sanitizePath(file.name);
        if (name && name !== record.destinationPath) {
            deleteSet.add(name);
        }
    });

    const deployFiles = await collectVersionedFiles(bucket, deployPrefix, record.rootName);
    deployFiles.forEach((file) => {
        const name = sanitizePath(file.name);
        if (name && name !== record.destinationPath) {
            deleteSet.add(name);
        }
    });

    const deleted = [];
    for (const path of deleteSet) {
        if (!path || path === record.destinationPath) continue;
        try {
            await bucket.file(path).delete({ ignoreNotFound: true });
            deleted.push(path);
        } catch (error) {
            if (error && error.code === 404) {
                continue;
            }
            throw error;
        }
    }

    return {
        bucket: bucket.name,
        language: record.language,
        root: record.rootName,
        source: record.sourcePath,
        destination: record.destinationPath,
        deleted
    };
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'method_not_allowed' });

    try {
        const storage = getStorage();
        if (!storage) {
            return res.status(500).json({ success: false, error: 'gcs_unavailable', message: 'Could not initialize Google Cloud Storage client.' });
        }

        const body = req.body || {};
        const files = Array.isArray(body.files) ? body.files : [];
        if (!files.length) {
            return res.status(400).json({ success: false, error: 'no_files', message: 'No files provided for deployment.' });
        }

        const bucketOverride = body.bucket || '';
        const bucketsMap = parseSelectedFiles(files, bucketOverride);
        if (!bucketsMap.size) {
            return res.status(400).json({ success: false, error: 'invalid_selection', message: 'No valid files were provided for deployment.' });
        }

        const results = [];

        for (const [bucketName, entries] of bucketsMap.entries()) {
            const bucket = storage.bucket(bucketName);
            for (const record of entries.values()) {
                const operationResult = await moveDraftsWithinBucket(bucket, record);
                results.push(operationResult);
            }
        }

        const movedCount = results.length;
        const deletedCount = results.reduce((sum, item) => sum + item.deleted.length, 0);

        return res.status(200).json({
            success: true,
            buckets: [...bucketsMap.keys()],
            moved: movedCount,
            deleted: deletedCount,
            results
        });
    } catch (error) {
        console.error('Error deploying draft audio within GCS:', error);
        const status = error.status && Number.isInteger(error.status) ? error.status : 500;
        return res.status(status).json({
            success: false,
            error: 'deployment_failed',
            message: error.message || 'Unknown deployment failure'
        });
    }
}
