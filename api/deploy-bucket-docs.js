import { Storage } from '@google-cloud/storage';

const LICENSE_TEMPLATES = {
    'Creative Commons': `Creative Commons Attribution 4.0 International License (CC BY 4.0)

Copyright (c) ${new Date().getFullYear()} Haskins Laboratories - LEVANTE Project

This work is licensed under the Creative Commons Attribution 4.0 International License.

You are free to:
- Share — copy and redistribute the material in any medium or format
- Adapt — remix, transform, and build upon the material for any purpose, even commercially

Under the following terms:
- Attribution — You must give appropriate credit, provide a link to the license, and indicate if changes were made. You may do so in any reasonable manner, but not in any way that suggests the licensor endorses you or your use.

No additional restrictions — You may not apply legal terms or technological measures that legally restrict others from doing anything the license permits.

Full license text: https://creativecommons.org/licenses/by/4.0/legalcode

---

LEVANTE (Learning Evaluation and Validation Across Networks Through Education) is a research project aimed at developing and validating educational assessment tools across multiple languages and cultural contexts.

For more information, visit: https://www.haskins.yale.edu/research/levante
`,

    'ROAR': `ROAR (Rapid Online Assessment of Reading) License

Copyright (c) ${new Date().getFullYear()} Haskins Laboratories - LEVANTE Project

This software and associated data are proprietary and confidential. All rights reserved.

RESTRICTIONS:
This material is provided for research and educational purposes only. Unauthorized copying, distribution, modification, public display, or public performance of this material is strictly prohibited.

PERMITTED USE:
- Internal research and development
- Educational assessment in authorized contexts
- Academic research with proper attribution

For licensing inquiries or permission requests, please contact:
LEVANTE Project Team
Haskins Laboratories
300 George Street, Suite 900
New Haven, CT 06511
Email: levante@haskins.yale.edu

---

LEVANTE (Learning Evaluation and Validation Across Networks Through Education) is a research project aimed at developing and validating educational assessment tools across multiple languages and cultural contexts.

For more information, visit: https://www.haskins.yale.edu/research/levante
`
};

let storage = null;

async function initializeGCS() {
    if (storage) return storage;
    
    try {
        const serviceAccountJson = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
        
        if (!serviceAccountJson) {
            console.error('❌ No GCS credentials found in environment variables');
            throw new Error('Missing GCP_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS_JSON environment variable');
        }
        
        let credentials;
        try {
            credentials = JSON.parse(serviceAccountJson);
        } catch (e) {
            console.error('❌ Failed to parse GCS credentials JSON:', e);
            throw new Error('Invalid JSON in GCS credentials environment variable');
        }
        
        storage = new Storage({ 
            credentials,
            projectId: credentials.project_id 
        });
        
        console.log('✅ GCS client initialized successfully with project:', credentials.project_id);
        return storage;
    } catch (error) {
        console.error('❌ Failed to initialize Google Cloud Storage:', error);
        throw error;
    }
}

export default async function handler(req, res) {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { bucket, license, description } = req.body;

        if (!bucket || !license || !description) {
            return res.status(400).json({ 
                error: 'Missing required fields: bucket, license, description' 
            });
        }

        if (!LICENSE_TEMPLATES[license]) {
            return res.status(400).json({ 
                error: `Invalid license type. Must be one of: ${Object.keys(LICENSE_TEMPLATES).join(', ')}` 
            });
        }

        const storage = await initializeGCS();
        const bucketObj = storage.bucket(bucket);

        // Skip bucket existence check - we'll catch errors during upload instead
        // (checking existence requires storage.buckets.get permission which some buckets may not have)

        // Create README content
        const readmeContent = `# ${bucket}

${description}

## License

This bucket is licensed under ${license === 'Creative Commons' ? 'Creative Commons Attribution 4.0 International License (CC BY 4.0)' : 'ROAR (Rapid Online Assessment of Reading) License'}.

See the LICENSE file in this bucket for full license text.

## About LEVANTE

LEVANTE (Learning Evaluation and Validation Across Networks Through Education) is a research project aimed at developing and validating educational assessment tools across multiple languages and cultural contexts.

For more information, visit: https://www.haskins.yale.edu/research/levante

---

*Last updated: ${new Date().toISOString().split('T')[0]}*
`;

        // Get LICENSE content from template
        const licenseContent = LICENSE_TEMPLATES[license];

        // Upload README
        const readmeFile = bucketObj.file('README.md');
        await readmeFile.save(readmeContent, {
            contentType: 'text/markdown',
            metadata: {
                cacheControl: 'public, max-age=3600',
            }
        });

        // Upload LICENSE
        const licenseFile = bucketObj.file('LICENSE');
        await licenseFile.save(licenseContent, {
            contentType: 'text/plain',
            metadata: {
                cacheControl: 'public, max-age=3600',
            }
        });

        console.log(`✓ Successfully deployed README and LICENSE to gs://${bucket}/`);

        return res.status(200).json({ 
            success: true,
            message: `Successfully deployed README and LICENSE to ${bucket}`,
            files: [
                `gs://${bucket}/README.md`,
                `gs://${bucket}/LICENSE`
            ]
        });

    } catch (error) {
        console.error('Error deploying bucket docs:', error);
        return res.status(500).json({ 
            error: error.message || 'Internal server error' 
        });
    }
}

