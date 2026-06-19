import { Storage } from '@google-cloud/storage';

const DEV_BUCKET = process.env.ASSETS_DEV_BUCKET || 'levante-assets-dev';

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

function stripExtension(fileName = '') {
    return fileName.replace(/\.[^/.]+$/u, '');
}

function removeVersionSuffix(base = '') {
    return base.replace(/([_-]v?\d{3,})$/iu, '');
}

function buildApprovalKey(language = '', baseId = '') {
    if (!language || !baseId) return '';
    return `${language}/${baseId}`.toLowerCase();
}

function parseTimestamp(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function getCustomMetadataValue(metadata, key) {
    return String(metadata?.metadata?.[key] || '').trim();
}

function getLogicalUpdated(metadata) {
    return getCustomMetadataValue(metadata, 'logical_updated_at')
        || getCustomMetadataValue(metadata, 'original_updated_at')
        || metadata?.updated
        || metadata?.timeCreated
        || null;
}

function getLogicalApprovedAt(metadata) {
    return getCustomMetadataValue(metadata, 'logical_approved_at')
        || getCustomMetadataValue(metadata, 'approved_at')
        || getLogicalUpdated(metadata)
        || null;
}

function normalizePath(value = '') {
    return value
        .replace(/\\/g, '/')
        .split('/')
        .filter((segment) => segment && segment !== '.' && segment !== '..')
        .join('/');
}

function parseVersionFromPath(path = '') {
    const match = path.match(/_v(\d{3})/i);
    if (!match) return null;
    const version = parseInt(match[1], 10);
    return Number.isFinite(version) ? version : null;
}

function coerceVersion(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    const cleaned = String(value).trim();
    if (!cleaned) return null;
    const digits = cleaned.replace(/[^0-9]/g, '');
    if (!digits) return null;
    const parsed = parseInt(digits, 10);
    return Number.isFinite(parsed) ? parsed : null;
}

async function listAllFiles(bucket, prefix, requestedLimit, maxPerPage) {
    const collected = [];
    let pageToken;
    let remaining = requestedLimit;
    do {
        const maxResults = Number.isFinite(remaining)
            ? Math.min(maxPerPage, Math.max(1, remaining))
            : maxPerPage;
        const [files, nextQuery] = await bucket.getFiles({
            prefix,
            maxResults,
            autoPaginate: false,
            pageToken
        });
        collected.push(...files);
        if (Number.isFinite(remaining)) {
            remaining -= files.length;
            if (remaining <= 0) {
                break;
            }
        }
        pageToken = nextQuery && typeof nextQuery.pageToken === 'string' && nextQuery.pageToken.length
            ? nextQuery.pageToken
            : null;
    } while (pageToken);
    return collected;
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ success: false, error: 'method_not_allowed' });

    try {
        const storage = getStorage();
        if (!storage) {
            return res.status(500).json({ success: false, error: 'gcs_unavailable', message: 'Could not initialize Google Cloud Storage client.' });
        }

        const bucketName = (req.query.bucket && String(req.query.bucket)) || process.env.ASSETS_DRAFT_BUCKET || 'levante-assets-draft';
        const prefix = (req.query.prefix && String(req.query.prefix)) || 'audio/';
        const limitRaw = req.query.limit ? Number(req.query.limit) : Infinity;
        const requestedLimit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : Infinity;
        const pageSizeRaw = req.query.pageSize ? Number(req.query.pageSize) : 500;
        const maxPerPage = Number.isFinite(pageSizeRaw) ? Math.min(Math.max(pageSizeRaw, 1), 1000) : 500;

        const bucket = storage.bucket(bucketName);
        const files = await listAllFiles(bucket, prefix, requestedLimit, maxPerPage);

        const isDevBucket = bucketName === DEV_BUCKET;
        const shouldLoadDevInfo = !isDevBucket && prefix.startsWith('audio/');
        const approvalInfo = new Map();

        if (isDevBucket) {
            // The files we're listing are already the approved versions.
            files.forEach((file) => {
                const parts = (file.name || '').split('/').filter(Boolean);
                if (parts.length < 3) return;
                const language = parts[1] || '';
                const fileBase = removeVersionSuffix(stripExtension(parts[parts.length - 1] || ''));
                const key = buildApprovalKey(language, fileBase);
                if (!key) return;
                approvalInfo.set(key, {
                    path: file.name,
                    bucket: DEV_BUCKET,
                    updated: getLogicalUpdated(file.metadata),
                    generation: file.metadata?.generation || null,
                    approvedVersion: parseVersionFromPath(file.name),
                    approvedAt: getLogicalApprovedAt(file.metadata)
                });
            });
        } else if (shouldLoadDevInfo) {
            const devBucket = storage.bucket(DEV_BUCKET);
            const devFiles = await listAllFiles(devBucket, prefix, Infinity, maxPerPage);
            devFiles.forEach((file) => {
                const parts = (file.name || '').split('/').filter(Boolean);
                if (parts.length < 3) return;
                const language = parts[1] || '';
                const fileBase = removeVersionSuffix(stripExtension(parts[parts.length - 1] || ''));
                const key = buildApprovalKey(language, fileBase);
                if (!key) return;
                approvalInfo.set(key, {
                    path: file.name,
                    bucket: DEV_BUCKET,
                    updated: getLogicalUpdated(file.metadata),
                    generation: file.metadata?.generation || null,
                    approvedVersion: parseVersionFromPath(file.name),
                    approvedAt: getLogicalApprovedAt(file.metadata)
                });
            });
        }

        const items = files
            .filter(file => file.name && file.name.toLowerCase().endsWith('.mp3'))
            .map(file => {
                const metadata = file.metadata || {};
                const name = file.name;
                const parts = name ? name.split('/') : [];
                const language = parts.length >= 2 ? parts[1] : '';
                const filename = parts.length ? parts[parts.length - 1] : name;
                const itemIdRaw = filename ? filename.replace(/\.mp3$/i, '') : '';
                const versionMatch = itemIdRaw.match(/_v(\d{3})$/);
                const version = versionMatch ? parseInt(versionMatch[1], 10) : null;
                const baseItemId = versionMatch ? itemIdRaw.replace(/_v\d{3}$/, '') : itemIdRaw;
                const approvalKey = buildApprovalKey(language, baseItemId);

                const draftUpdated = getLogicalUpdated(metadata);
                const draftUpdatedDate = parseTimestamp(draftUpdated);
                const approvalEntry = approvalKey ? approvalInfo.get(approvalKey) : null;

                let approvedBySite = false;
                let approvalStatus = 'not_approved';

                if (isDevBucket) {
                    approvedBySite = true;
                    approvalStatus = 'approved';
                } else if (approvalEntry) {
                    approvedBySite = true;
                    const approvalUpdatedDate = parseTimestamp(approvalEntry.updated);
                    if (!draftUpdatedDate || !approvalUpdatedDate || approvalUpdatedDate >= draftUpdatedDate) {
                        approvalStatus = 'approved';
                    } else {
                        approvalStatus = 'stale';
                    }
                }

                const derivedVersion = (() => {
                    if (version !== null) return version;
                    if (approvalEntry && approvalEntry.approvedVersion !== null) return approvalEntry.approvedVersion;
                    return null;
                })();

                return {
                    name,
                    language,
                    itemId: baseItemId,
                    version: derivedVersion,
                    path: name,
                    size: Number(metadata.size || 0),
                    updated: getLogicalUpdated(metadata),
                    generation: metadata.generation || null,
                    contentType: metadata.contentType || null,
                    approvedBySite,
                    siteApproval: {
                        status: approvalStatus,
                        deployPath: approvalEntry ? approvalEntry.path : (isDevBucket ? name : null),
                        deployBucket: approvalEntry ? approvalEntry.bucket : (isDevBucket ? bucketName : null),
                        deployUpdated: approvalEntry ? approvalEntry.updated : (isDevBucket ? getLogicalUpdated(metadata) : null),
                        deployGeneration: approvalEntry ? approvalEntry.generation : (isDevBucket ? (metadata.generation || null) : null),
                        draftUpdated,
                        approvedSource: approvalEntry ? approvalEntry.path : (isDevBucket ? name : null),
                        approvedVersion: approvalEntry && approvalEntry.approvedVersion !== null
                            ? approvalEntry.approvedVersion
                            : (isDevBucket && derivedVersion !== null ? derivedVersion : null),
                        approvedAt: approvalEntry ? approvalEntry.approvedAt : (isDevBucket ? getLogicalApprovedAt(metadata) : null)
                    }
                };
            });

        return res.status(200).json({
            success: true,
            bucket: bucketName,
            prefix,
            count: items.length,
            items
        });
    } catch (error) {
        console.error('Error listing draft audio files', error);
        return res.status(500).json({ success: false, error: 'internal_error', message: error.message });
    }
}
