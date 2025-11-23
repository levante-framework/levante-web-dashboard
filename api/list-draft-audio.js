import { Storage } from '@google-cloud/storage';

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

        async function listAllFiles() {
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

        const files = await listAllFiles();

        const [deployFiles] = await bucket.getFiles({ prefix: 'deploy/', maxResults: 2000 });
        const deployInfo = new Map();
        deployFiles.forEach((file) => {
            const name = file.name || '';
            const segments = name.split('/');
            if (segments.length < 3) return;
            const language = segments[1] || '';
            const fileBase = removeVersionSuffix(stripExtension(segments[segments.length - 1] || ''));
            const key = buildApprovalKey(language, fileBase);
            if (!key) return;

            const metadata = file.metadata || {};
            const customMetadata = metadata.metadata || {};
            const approvedSourceRaw = customMetadata.siteApprovedSource
                || customMetadata['site-approved-source']
                || null;
            const approvedSource = approvedSourceRaw ? normalizePath(approvedSourceRaw) : null;
            const approvedVersionRaw = customMetadata.siteApprovedVersion
                || customMetadata['site-approved-version']
                || null;
            const approvedVersion = (() => {
                const coerced = coerceVersion(approvedVersionRaw);
                if (coerced !== null) return coerced;
                if (approvedSourceRaw) {
                    const parsed = parseVersionFromPath(approvedSourceRaw);
                    if (parsed !== null) return parsed;
                }
                return null;
            })();
            const approvedAt = customMetadata.siteApprovedAt
                || customMetadata['site-approved-at']
                || metadata.updated
                || metadata.timeCreated
                || null;

            const updatedRaw = metadata.updated || metadata.timeCreated || null;
            const updatedDate = parseTimestamp(updatedRaw);
            const current = deployInfo.get(key);

            if (!current || (updatedDate && (!current.updatedDate || updatedDate > current.updatedDate))) {
                deployInfo.set(key, {
                    path: name,
                    bucket: bucketName,
                    updated: updatedRaw,
                    updatedDate,
                    generation: metadata.generation || null,
                    size: Number(metadata.size || 0),
                    approvedSource,
                    approvedSourceRaw,
                    approvedVersion,
                    approvedAt
                });
            }
        });

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

                const draftUpdated = metadata.updated || metadata.timeCreated || null;
                const draftUpdatedDate = parseTimestamp(draftUpdated);
                const deployEntry = approvalKey ? deployInfo.get(approvalKey) : null;
                const normalizedPath = normalizePath(name);
                const isDeployObject = normalizedPath.startsWith('deploy/');

                let approvedBySite = false;
                let approvalStatus = 'not_approved';

                if (deployEntry) {
                    const matchesApprovedSource = deployEntry.approvedSource
                        ? (!isDeployObject && deployEntry.approvedSource === normalizedPath)
                        : false;

                    if (isDeployObject) {
                        approvedBySite = true;
                        approvalStatus = 'approved';
                    } else if (deployEntry.approvedSource) {
                        if (matchesApprovedSource) {
                            approvedBySite = true;
                            approvalStatus = 'approved';
                        } else {
                            approvedBySite = false;
                            approvalStatus = 'stale';
                        }
                    } else {
                        const deployUpdatedDate = deployEntry.updatedDate;
                        if (!draftUpdatedDate || !deployUpdatedDate) {
                            approvedBySite = true;
                            approvalStatus = 'approved';
                        } else if (deployUpdatedDate >= draftUpdatedDate) {
                            approvedBySite = true;
                            approvalStatus = 'approved';
                        } else {
                            approvedBySite = false;
                            approvalStatus = 'stale';
                        }
                    }
                }

                const derivedVersion = version !== null
                    ? version
                    : (deployEntry && deployEntry.approvedVersion !== null ? deployEntry.approvedVersion : null);

                return {
                    name,
                    language,
                    itemId: baseItemId,
                    version: derivedVersion,
                    path: name,
                    size: Number(metadata.size || 0),
                    updated: metadata.updated || metadata.timeCreated || null,
                    generation: metadata.generation || null,
                    contentType: metadata.contentType || null,
                    approvedBySite,
                    siteApproval: {
                        status: approvalStatus,
                        deployPath: deployEntry ? deployEntry.path : null,
                        deployUpdated: deployEntry ? deployEntry.updated : null,
                        deployGeneration: deployEntry ? deployEntry.generation : null,
                        draftUpdated,
                        approvedSource: deployEntry ? deployEntry.approvedSourceRaw || deployEntry.approvedSource : null,
                        approvedVersion: deployEntry && deployEntry.approvedVersion !== null ? deployEntry.approvedVersion : null,
                        approvedAt: deployEntry ? deployEntry.approvedAt : null
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
