import { Storage } from '@google-cloud/storage';
import NodeID3 from 'node-id3';

// Initialize GCS client
function getStorageClient() {
    try {
        if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
            const credentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
            return new Storage({ credentials });
        }
        return new Storage();
    } catch (error) {
        console.warn('Failed to initialize GCS client:', error.message);
        return null;
    }
}

// Download and read ID3 tags from GCS file
async function downloadAndReadID3Tags(bucket, file) {
    try {
        console.log('📥 Downloading file head to read ID3 tags...');
        const [headBuffer] = await file.download({ start: 0, end: 65535 });
        let tags = NodeID3.read(headBuffer);
        if (tags && (tags.title || tags.artist || tags.album)) return tags;

        // Try tail for ID3v1 or trailing tags
        try {
            const [meta] = await file.getMetadata();
            const size = Number(meta.size || 0);
            if (size > 0) {
                const tailStart = Math.max(0, size - 131072);
                console.log(`📥 Downloading file tail (${tailStart}-${size}) to read trailing ID3 tags...`);
                const [tailBuffer] = await file.download({ start: tailStart });
                const tailTags = NodeID3.read(tailBuffer);
                if (tailTags && (tailTags.title || tailTags.artist || tailTags.album)) return tailTags;
            }
        } catch (e) {
            console.warn('⚠️ Tail read for ID3 failed:', e.message);
        }
        return tags || null;
        
    } catch (error) {
        console.warn('⚠️ Could not read ID3 tags:', error.message);
        return null;
    }
}

// Get duration from ID3 tags or estimate from file size
function getDurationFromTags(tags, fileSize) {
    // Try to get duration from ID3 tags first
    if (tags && tags.length) {
        const lengthTag = tags.length;
        if (lengthTag && !isNaN(parseFloat(lengthTag))) {
            return parseFloat(lengthTag);
        }
    }
    
    // Fallback: estimate from file size (rough approximation)
    // Assume ~128kbps bitrate for MP3
    if (fileSize && fileSize > 0) {
        const estimatedBitrate = 128000; // 128 kbps in bits per second
        return (fileSize * 8) / estimatedBitrate;
    }
    
    return 0;
}

export default async function handler(req, res) {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const env = (req.query.env || 'dev').toString().toLowerCase();
        const bucketName = env === 'prod' ? 'levante-assets-prod' : 'levante-assets-dev';
        
        const storage = getStorageClient();
        if (!storage) {
            return res.status(503).json({
                success: false,
                error: 'GCS client not available',
                message: 'Google Cloud Storage credentials not configured',
                data: []
            });
        }

        const bucket = storage.bucket(bucketName);
        const bucketInfo = [];
        
        // Get all language directories under audio/ prefix
        const [files] = await bucket.getFiles({ prefix: 'audio/', autoPaginate: true });
        
        // Group files by language
        const filesByLanguage = {};
        for (const file of files) {
            if (file.name.endsWith('.mp3')) {
                const pathParts = file.name.split('/');
                if (pathParts.length >= 3) { // audio/lang/filename.mp3
                    const language = pathParts[1];
                    if (!filesByLanguage[language]) {
                        filesByLanguage[language] = [];
                    }
                    filesByLanguage[language].push(file);
                }
            }
        }
        
        // Process each language (limit to prevent timeout)
        const maxFilesPerLanguage = 50; // Limit files per language to prevent timeout
        for (const [language, languageFiles] of Object.entries(filesByLanguage)) {
            let totalDuration = 0;
            let fileCount = 0;
            
            // Limit files to prevent timeout
            const filesToProcess = languageFiles.slice(0, maxFilesPerLanguage);
            
            for (const file of filesToProcess) {
                try {
                    const [metadata] = await file.getMetadata();
                    const fileSize = Number(metadata.size || 0);
                    
                    // Get ID3 tags to extract duration
                    const id3Tags = await downloadAndReadID3Tags(bucket, file);
                    const duration = getDurationFromTags(id3Tags, fileSize);
                    
                    if (duration > 0) {
                        totalDuration += duration;
                        fileCount++;
                    }
                } catch (error) {
                    console.warn(`Error processing ${file.name}:`, error.message);
                }
            }
            
            if (fileCount > 0) {
                bucketInfo.push({
                    bucketName: `core-tasks-${language}`,
                    statName: 'End-to-End Play Time',
                    language: language,
                    number: Math.round(totalDuration),
                    unit: 'seconds',
                    fileCount: fileCount
                });
            }
        }
        
        // Sort by language
        bucketInfo.sort((a, b) => a.language.localeCompare(b.language));
        
        res.status(200).json({
            success: true,
            data: bucketInfo,
            totalLanguages: bucketInfo.length,
            totalFiles: bucketInfo.reduce((sum, item) => sum + item.fileCount, 0),
            totalDuration: bucketInfo.reduce((sum, item) => sum + item.number, 0),
            source: 'gcs',
            bucket: bucketName
        });
        
    } catch (error) {
        console.error('Error fetching bucket info:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            data: []
        });
    }
}
