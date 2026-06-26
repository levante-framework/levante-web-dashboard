import { Storage } from '@google-cloud/storage';
import NodeID3 from 'node-id3';

// Use the assets bucket and the audio/ folder for coverage and metadata reads
const ASSETS_BUCKET = process.env.ASSETS_DEV_BUCKET || 'levante-assets-dev';

// Initialize Google Cloud Storage client
let storageClient = null;

function hasUsefulTags(tags) {
    try {
        if (!tags) return false;
        const keys = Object.keys(tags);
        if (keys.length === 0) return false;
        // If only raw header or trivial fields, consider empty
        const meaningful = ['title','artist','album','genre','comment','userDefinedText','text','date','copyright'];
        return keys.some(k => meaningful.includes(k));
    } catch { return false; }
}

function getUserDefinedTagValue(tags, description) {
    if (!tags || !Array.isArray(tags.userDefinedText)) return '';
    const normalizedDescription = String(description || '').trim();
    if (!normalizedDescription) return '';
    const match = tags.userDefinedText.find((entry) => String(entry?.description || '').trim() === normalizedDescription);
    return String(match?.value || '').trim();
}

async function initializeGCS() {
    if (storageClient) return storageClient;
    
    try {
        const credentials = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
        if (credentials) {
            const credentialsObj = JSON.parse(credentials);
            storageClient = new Storage({
                credentials: credentialsObj,
                projectId: credentialsObj.project_id
            });
            console.log('✅ GCS client initialized successfully');
        } else {
            console.warn('⚠️ No GCS credentials found - using default auth');
            storageClient = new Storage();
        }
        return storageClient;
    } catch (error) {
        console.error('❌ Failed to initialize GCS client:', error);
        throw error;
    }
}

async function downloadAndReadID3Tags(bucket, file) {
    try {
        console.log('📥 Downloading file head to read ID3 tags...');
        const [headBuffer] = await file.download({ start: 0, end: 65535 });
        let tags = NodeID3.read(headBuffer);
        if (hasUsefulTags(tags)) return tags;

        // Try tail for ID3v1 or trailing tags
        try {
            const [meta] = await file.getMetadata();
            const size = Number(meta.size || 0);
            if (size > 0) {
                const tailStart = Math.max(0, size - 131072);
                console.log(`📥 Downloading file tail (${tailStart}-${size}) to read trailing ID3 tags...`);
                const [tailBuffer] = await file.download({ start: tailStart });
                const tailTags = NodeID3.read(tailBuffer);
                if (hasUsefulTags(tailTags)) return tailTags;
            }
        } catch (e) {
            console.warn('⚠️ Tail read for ID3 failed:', e.message);
        }
        return tags || null;
        
    } catch (error) {
        console.warn('⚠️ Could not read ID3 tags (head/tail):', error.message);
        return null;
    }
}

// Fallback: read ID3 via public HTTP Range request without GCS SDK/auth
async function httpReadID3Tags(audioUrl) {
    try {
        // Try head first
        let ok = false; let status = 0; let tags = null;
        try {
            const respHead = await fetch(audioUrl, { headers: { Range: 'bytes=0-65535' } });
            status = respHead.status;
            if (respHead.ok) {
                ok = true;
                const bufHead = Buffer.from(await respHead.arrayBuffer());
                const headTags = NodeID3.read(bufHead);
                if (hasUsefulTags(headTags)) return { ok: true, tags: headTags, status };
            }
        } catch (e) {
            console.warn('⚠️ HTTP head range fetch failed:', e.message);
        }
        // Try tail next
        try {
            const respTail = await fetch(audioUrl, { headers: { Range: 'bytes=-131072' } });
            status = respTail.status;
            if (respTail.ok) {
                ok = true;
                const bufTail = Buffer.from(await respTail.arrayBuffer());
                const tailTags = NodeID3.read(bufTail);
                if (hasUsefulTags(tailTags)) return { ok: true, tags: tailTags, status };
            }
        } catch (e) {
            console.warn('⚠️ HTTP tail range fetch failed:', e.message);
        }
        return { ok, tags: null, status };
    } catch (err) {
        console.warn('⚠️ HTTP ID3 fallback failed:', err.message);
        return { ok: false, tags: null, status: 0 };
    }
}

async function readAudioMetadata(audioUrl) {
    try {
        // Extract bucket and file path from URL
        // URL format: https://storage.googleapis.com/levante-assets-dev/audio/es-AR/itemid.mp3
        const urlParts = audioUrl.replace('https://storage.googleapis.com/', '').split('/');
        const bucketName = urlParts[0];
        const filePath = urlParts.slice(1).join('/');
        
        console.log(`📁 Reading metadata from: ${bucketName}/${filePath}`);
        
        let metadata = null;
        let id3Tags = null;
        let fileExists = false;

        // Try GCS SDK first (if credentials available or default works)
        try {
            const storage = await initializeGCS();
            const bucket = storage.bucket(bucketName);
            const file = bucket.file(filePath);
            const [exists] = await file.exists();
            if (exists) {
                fileExists = true;
                [metadata] = await file.getMetadata();
                id3Tags = await downloadAndReadID3Tags(bucket, file);
            } else {
                console.warn(`⚠️ GCS reports missing file: ${filePath}`);
            }
        } catch (gcsErr) {
            console.warn('⚠️ GCS access failed, will try HTTP fallback:', gcsErr.message);
        }

        // If GCS path failed or tags not found, try HTTP fallback
        if (!id3Tags) {
            const httpResult = await httpReadID3Tags(audioUrl);
            if (httpResult.ok) {
                fileExists = true;
                id3Tags = httpResult.tags;
            }
        }

        // If neither GCS nor HTTP located the file, return error
        if (!fileExists) {
            return { error: 'File not accessible', details: `Unable to access: ${filePath}` };
        }

        if (!metadata) {
            // Minimal metadata from path when GCS metadata not available
            metadata = { name: filePath, size: undefined, contentType: 'audio/mpeg', timeCreated: undefined, updated: undefined };
        }
        
        // Build comprehensive metadata combining GCS and ID3 tag data
        const pathParts = filePath.split('/');
        const itemId = pathParts[pathParts.length - 1].replace('.mp3', '');
        // Expect audio/<lang>/<file>
        const languageCode = pathParts[0] === 'audio' ? pathParts[1] : pathParts[0];
        
        const basicMetadata = {
            // GCS metadata
            fileName: metadata.name,
            size: metadata.size,
            contentType: metadata.contentType,
            created: metadata.timeCreated,
            updated: metadata.updated,
            
            // Audio file info (extracted from file name and path)
            itemId: itemId,
            language: languageCode,
            
            // Enhanced ID3 tags with actual embedded data
            id3Tags: {
                // Standard ID3 tags (from embedded ID3 or fallback)
                title: id3Tags?.title || itemId,
                artist: id3Tags?.artist || 'Levante Project',
                album: id3Tags?.album || languageCode || 'Levante Audio',
                genre: id3Tags?.genre || 'Speech Synthesis',
                
                // Custom Levante fields (check both TXXX custom frames and standard fields)
                service: id3Tags?.userDefinedText?.find(t => t.description === 'service')?.value || 
                        id3Tags?.service || 'Not available',
                voice: id3Tags?.userDefinedText?.find(t => t.description === 'voice')?.value || 
                      id3Tags?.voice || 'Not available',
                lang_code: id3Tags?.userDefinedText?.find(t => t.description === 'lang_code')?.value || 
                          id3Tags?.lang_code || languageCode,
                text: id3Tags?.userDefinedText?.find(t => t.description === 'text')?.value || 
                     id3Tags?.text || 'Original text not available',
                audio_enhanced_text: getUserDefinedTagValue(id3Tags, 'audio_enhanced_text'),
                original_translation_text: getUserDefinedTagValue(id3Tags, 'original_translation_text'),
                approved_by: getUserDefinedTagValue(id3Tags, 'approved_by'),
                approved_at: getUserDefinedTagValue(id3Tags, 'approved_at'),
                created: id3Tags?.userDefinedText?.find(t => t.description === 'created')?.value || 
                        id3Tags?.date || metadata.timeCreated || null,
                copyright: id3Tags?.copyright || 'This file was created for the LEVANTE project and is released under a Creative Commons BY-NC-SA 4.0 license',
                comment: id3Tags?.comment?.text || id3Tags?.comment || `Generated audio for item: ${itemId}`,
                
                // Metadata about the reading process
                note: id3Tags ? 
                    `ID3 tags successfully read from embedded metadata. Found ${Object.keys(id3Tags).length} fields.` :
                    'Could not read embedded ID3 tags. Showing fallback values.',
                
                // Raw ID3 data for debugging (first 10 fields)
                debug_raw_tags: id3Tags ? 
                    Object.fromEntries(Object.entries(id3Tags).slice(0, 10)) : 
                    null
            }
        };
        
        return basicMetadata;
        
    } catch (error) {
        console.error('❌ Error reading audio metadata:', error);
        return {
            error: 'Metadata read failed',
            details: error.message
        };
    }
}

// Resolve the actual stored object path for an item, tolerating case
// differences and version suffixes (e.g. itemId "schoolhappy" -> SchoolHappy.mp3,
// "item" -> item_v003.mp3). Returns the storage.googleapis.com URL or null.
async function resolveCaseInsensitiveAudioUrl(bucketName, langCode, itemId, prefix) {
    try {
        const storage = await initializeGCS();
        const bucket = storage.bucket(bucketName);
        const folder = prefix ? `audio/${prefix}/${langCode}/` : `audio/${langCode}/`;
        const [files] = await bucket.getFiles({ prefix: folder });
        const target = String(itemId || '').trim().toLowerCase();
        if (!target) return null;
        const stripBase = (name) => String(name || '')
            .split('/').pop()
            .replace(/\.mp3$/i, '')
            .replace(/_v\d{3}$/i, '')
            .toLowerCase();
        // Prefer an exact (canonical, unversioned) match; otherwise newest versioned.
        let best = null;
        (files || []).forEach((file) => {
            const name = String(file?.name || '');
            if (!name.toLowerCase().endsWith('.mp3')) return;
            if (stripBase(name) !== target) return;
            const updated = Date.parse(file.metadata?.updated || file.metadata?.timeCreated || '') || 0;
            if (!best || updated >= best.updated) best = { name, updated };
        });
        if (!best) return null;
        return `https://storage.googleapis.com/${encodeURIComponent(bucketName)}/${best.name.split('/').map(encodeURIComponent).join('/')}`;
    } catch (err) {
        console.warn('⚠️ Case-insensitive audio resolution failed:', err.message);
        return null;
    }
}

// List language prefixes under audio/ in the assets bucket
async function listAudioLanguagesFromBucket(bucketName) {
    try {
        const storage = await initializeGCS();
        const bucket = storage.bucket(bucketName);
        // Only list languages under audio/ prefix (ignore root-level folders like corpus/, translations/)
        const [, , apiResp] = await bucket.getFiles({ delimiter: '/', prefix: 'audio/' });
        const prefixes = (apiResp && apiResp.prefixes) || [];
        const langs = prefixes
            .map(p => p.replace(/^audio\//, '').replace(/\/$/, ''))
            .filter(Boolean)
            .filter(code => code !== 'validations' && code !== '_gsdata_' && code !== 'child-survey' && code !== 'child_survey' && code !== 'shared');
        
        // Also check for languages inside audio/child-survey/
        try {
            const [, , childSurveyResp] = await bucket.getFiles({ delimiter: '/', prefix: 'audio/child-survey/' });
            const childSurveyPrefixes = (childSurveyResp && childSurveyResp.prefixes) || [];
            const childSurveyLangs = childSurveyPrefixes
                .map(p => p.replace(/^audio\/child-survey\//, '').replace(/\/$/, ''))
                .filter(Boolean);
            
            // Add child-survey languages to the main list if they're not already there
            childSurveyLangs.forEach(lang => {
                if (!langs.includes(lang)) {
                    langs.push(lang);
                }
            });
        } catch (err) {
            console.warn('⚠️ Failed to list child-survey languages:', err.message);
        }
        
        return langs;
    } catch (err) {
        console.warn('⚠️ Failed to list languages in bucket:', err.message);
        return [];
    }
}

// List files with a specific prefix in the bucket
async function listFilesWithPrefix(bucketName, prefix, includeMetadata = false) {
    try {
        const storage = await initializeGCS();
        const bucket = storage.bucket(bucketName);
        
        // List all files with the given prefix
        const [files] = await bucket.getFiles({ prefix: prefix });
        if (includeMetadata) {
            // Return lightweight metadata for faster downstream auditing
            return files.map(file => {
                const metadata = file.metadata || {};
                return {
                    name: file.name,
                    size: Number(metadata.size || file.size || 0),
                    updated: metadata.updated || metadata.timeCreated || null
                };
            });
        }

        // Return just the file paths
        return files.map(file => file.name);
    } catch (err) {
        console.warn('⚠️ Failed to list files with prefix:', err.message);
        return [];
    }
}

export default async function handler(req, res) {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'no-cache');
    
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }
    
    if (req.method !== 'GET' && req.method !== 'POST') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }
    
    try {
        const { itemId, langCode, list, prefix } = req.method === 'GET' ? req.query : req.body;
        // Optional bucket override (default to assets-dev)
        const requestedBucket = (req.method === 'GET' ? req.query.bucket : req.body?.bucket) || '';
        const bucketOverride = typeof requestedBucket === 'string' && requestedBucket.trim().length > 0 ? requestedBucket.trim() : null;
        // The legacy "repo" source (raw.githubusercontent audio_files) has been retired.
        // Audio is no longer committed to the levante_translations repo; everything
        // now resolves from the GCS assets bucket. A source=repo param is accepted
        // for backward compatibility but transparently routes to the bucket.
        const directUrl = ((req.method === 'GET' ? req.query.url : req.body?.url) || '').toString().trim();

        // If listing was requested, return languages found in the dev assets bucket
        if (list === '1' || list === 1 || list === true) {
            const bucketName = bucketOverride || ASSETS_BUCKET;
            const includeFiles = ((req.method === 'GET' ? req.query.files : req.body?.files) || '').toString().trim().toLowerCase();
            const includeMetadata = ((req.method === 'GET' ? req.query.meta : req.body?.meta) || '').toString().trim().toLowerCase();
            const listFilesRequested = includeFiles === '1' || includeFiles === 'true' || includeFiles === 'yes';
            const listMetadataRequested = includeMetadata === '1' || includeMetadata === 'true' || includeMetadata === 'yes';
            
            // Handle file listing (explicit files=1, optionally with prefix)
            if (listFilesRequested || prefix) {
                const listPrefix = typeof prefix === 'string' ? prefix : '';
                const files = await listFilesWithPrefix(bucketName, listPrefix, listMetadataRequested);
                res.status(200).json({ bucket: bucketName, prefix: prefix, files: files });
                return;
            }
            
            const languages = await listAudioLanguagesFromBucket(bucketName);
            res.status(200).json({ bucket: bucketName, languages });
            return;
        }
        const rawStrict = (req.method === 'GET' ? req.query.strict : req.body?.strict);
        const strict = typeof rawStrict === 'string'
            ? ['1','true','yes','on'].includes(rawStrict.toLowerCase())
            : Boolean(rawStrict);
        
        // Direct URL mode (no language or item required)
        if (directUrl) {
            const httpResult = await httpReadID3Tags(directUrl);
            if (!httpResult.ok) {
                res.status(404).json({ error: 'File not accessible', details: `Unable to access: ${directUrl}` });
                return;
            }
            const tags = httpResult.tags;
            const name = (()=>{ try{ const u=new URL(directUrl); const parts=u.pathname.split('/'); return parts[parts.length-1]; }catch{return directUrl; } })();
            res.status(200).json({
                fileName: name,
                itemId: name.replace(/\.mp3$/,'') || name,
                language: undefined,
                id3Tags: {
                    title: tags?.title || name,
                    artist: tags?.artist || 'Levante Project',
                    album: tags?.album || 'Levante Audio',
                    genre: tags?.genre || 'Speech Synthesis',
                    service: tags?.userDefinedText?.find(t => t.description === 'service')?.value || tags?.service || 'Not available',
                    voice: tags?.userDefinedText?.find(t => t.description === 'voice')?.value || tags?.voice || 'Not available',
                    lang_code: tags?.userDefinedText?.find(t => t.description === 'lang_code')?.value || tags?.lang_code || undefined,
                    text: tags?.userDefinedText?.find(t => t.description === 'text')?.value || tags?.text || 'Original text not available',
                    audio_enhanced_text: getUserDefinedTagValue(tags, 'audio_enhanced_text'),
                    original_translation_text: getUserDefinedTagValue(tags, 'original_translation_text'),
                    approved_by: getUserDefinedTagValue(tags, 'approved_by'),
                    approved_at: getUserDefinedTagValue(tags, 'approved_at'),
                    created: tags?.userDefinedText?.find(t => t.description === 'created')?.value || tags?.date || null,
                    comment: tags?.comment?.text || tags?.comment || `Generated audio for item: ${name}`,
                    debug_raw_tags: tags ? Object.fromEntries(Object.entries(tags).slice(0, 10)) : null
                }
            });
            return;
        }
        
        if (!itemId || !langCode) {
            res.status(400).json({ 
                error: 'Missing parameters', 
                details: 'itemId and langCode are required' 
            });
            return;
        }
        
        // Construct audio URL based on source
        let audioUrl = '';
        let targetBucket = bucketOverride || ASSETS_BUCKET;
        const encItemId = encodeURIComponent(itemId);
        const audioPrefix = prefix ? `${prefix}/` : '';
        audioUrl = `https://storage.googleapis.com/${encodeURIComponent(targetBucket)}/audio/${audioPrefix}${encodeURIComponent(langCode)}/${encItemId}.mp3`;
        
        console.log(`🔍 Reading metadata for: ${itemId} in ${langCode}`);
        
        let metadata = await readAudioMetadata(audioUrl);
        if (metadata && metadata.error) {
            // Backward-compat alternative path: top-level <lang>/<id>.mp3 (no audio/ prefix)
            const altUrl = `https://storage.googleapis.com/${encodeURIComponent(targetBucket)}/${encodeURIComponent(langCode)}/${encodeURIComponent(itemId)}.mp3`;
            const altMeta = await readAudioMetadata(altUrl);
            if (!altMeta.error) {
                altMeta.note = 'Using legacy top-level path';
                res.status(200).json(altMeta);
                return;
            }
        }

        if (metadata && metadata.error) {
            // Case-insensitive / versioned resolution: the requested itemId casing
            // may differ from the stored filename (e.g. schoolhappy vs SchoolHappy).
            const resolvedUrl = await resolveCaseInsensitiveAudioUrl(targetBucket, langCode, itemId, prefix);
            if (resolvedUrl) {
                const resolvedMeta = await readAudioMetadata(resolvedUrl);
                if (!resolvedMeta.error) {
                    resolvedMeta.note = 'Resolved by case-insensitive filename match';
                    res.status(200).json(resolvedMeta);
                    return;
                }
            }
        }
        
        if (metadata.error) {
            // In strict mode, do not attempt language fallbacks
            if (!strict) {
                // Try language fallbacks for known aliases
                const langFallbackMap = {
                    'es-CO': 'es',
                    'en-US': 'en',
                    'de-DE': 'de'
                };
                const fallbackLang = langFallbackMap[langCode];
                if (fallbackLang) {
                    console.log(`🔄 Trying ${fallbackLang} fallback for ${langCode}...`);
                    const encId = encodeURIComponent(itemId);
                    const fallbackUrl = `https://storage.googleapis.com/${encodeURIComponent(targetBucket)}/audio/${fallbackLang}/${encId}.mp3`;
                    const fallbackMetadata = await readAudioMetadata(fallbackUrl);
                    
                    if (!fallbackMetadata.error) {
                        fallbackMetadata.note = `Using ${fallbackLang} fallback for ${langCode}`;
                        res.status(200).json(fallbackMetadata);
                        return;
                    }
                }
            }
            res.status(404).json(metadata);
            return;
        }
        
        res.status(200).json(metadata);
        
    } catch (error) {
        console.error('❌ API Error:', error);
        res.status(500).json({ 
            error: 'Internal server error', 
            details: error.message 
        });
    }
}