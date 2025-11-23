#!/usr/bin/env ts-node

import fs from 'fs';
import path from 'path';
import { Storage } from '@google-cloud/storage';

// Attempt to import dashboard CONFIG (CommonJS export supported in config.js)
let CONFIG: any = {};
try {
	// Resolve relative to this file: ../public/config.js
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	CONFIG = require(path.resolve(__dirname, '../public/config.js')).CONFIG;
} catch (e) {
	CONFIG = {};
}

// Helpers
function getEnv(name: string, fallback?: string): string | undefined {
	return process.env[name] || fallback;
}

function hasGlobalFetch(): boolean {
	return typeof (global as any).fetch === 'function';
}

async function fetchText(url: string): Promise<string> {
	if (hasGlobalFetch()) {
		const res = await fetch(url);
		if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
		return await res.text();
	}
	// Fallback to https if fetch is not available
	const https = await import('node:https');
	return new Promise<string>((resolve, reject) => {
		https.get(url, (res: any) => {
			if (res.statusCode !== 200) {
				reject(new Error(`HTTP ${res.statusCode} for ${url}`));
				return;
			}
			const chunks: Buffer[] = [];
			res.on('data', (d: Buffer) => chunks.push(d));
			res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
		}).on('error', reject);
	});
}

function parseCSVWithEmbeddedNewlines(csvText: string): string[][] {
	const rows: string[][] = [];
	let currentRow: string[] = [];
	let currentField = '';
	let inQuotes = false;
	let i = 0;
	while (i < csvText.length) {
		const char = csvText[i];
		const nextChar = i + 1 < csvText.length ? csvText[i + 1] : '';
		if (char === '"') {
			if (inQuotes && nextChar === '"') {
				currentField += '"';
				i += 2;
			} else {
				inQuotes = !inQuotes;
				i++;
			}
		} else if (char === ',' && !inQuotes) {
			currentRow.push(currentField.trim());
			currentField = '';
			i++;
		} else if ((char === '\n' || char === '\r') && !inQuotes) {
			if (currentField.trim() || currentRow.length > 0) {
				currentRow.push(currentField.trim());
				if (currentRow.some(f => f.length > 0)) rows.push(currentRow);
				currentRow = [];
				currentField = '';
			}
			if (char === '\r' && nextChar === '\n') i += 2; else i++;
		} else {
			currentField += char;
			i++;
		}
	}
	if (currentField.trim() || currentRow.length > 0) {
		currentRow.push(currentField.trim());
		if (currentRow.some(f => f.length > 0)) rows.push(currentRow);
	}
	return rows.filter(r => r.length > 0 && r.some(f => f && f.trim().length > 0));
}

function csvToObjects(csvText: string): Array<Record<string, string>> {
	const rows = parseCSVWithEmbeddedNewlines(csvText);
	if (rows.length === 0) return [];
	const headers = rows[0];
	const data: Array<Record<string, string>> = [];
	for (let i = 1; i < rows.length; i++) {
		const row = rows[i];
		if (row.length < headers.length) continue;
		const obj: Record<string, string> = {};
		headers.forEach((h, idx) => {
			obj[h] = (row[idx] ?? '').trim();
		});
		data.push(obj);
	}
	return data;
}

function countNonEmpty(values: Array<string | undefined>): number {
	return values.reduce((acc, v) => acc + (v && v.trim().length > 0 ? 1 : 0), 0);
}

function toBaseLang(langCode: string): string {
	return langCode.includes('-') ? langCode.split('-')[0] : langCode;
}

type ReadinessReport = {
	languageCode: string;
	itemBank: { totalItems: number; translatedExact: number; translatedWithBaseFallback: number; coverageExactPct: number; coverageWithFallbackPct: number; source: string };
	surveys: { filesChecked: number; filesWithLang: number; filesWithBaseFallback: number; details: Array<{ file: string; hasExact: boolean; hasBase: boolean }>; bucket: string };
	dashboard: { totalKeys: number; translatedExact: number; translatedWithBaseFallback: number; coverageExactPct: number; coverageWithFallbackPct: number; source: string };
	audio: { bucket: string; prefix: string; files: number };
};

async function checkItemBank(langCode: string): Promise<ReadinessReport['itemBank']> {
	const primaryUrl = CONFIG?.dataSources?.remoteCSV || 'https://raw.githubusercontent.com/levante-framework/levante_translations/l10n_pending/item-bank-translations.csv';
	const localPath = path.resolve(__dirname, '../translation_text/complete_translations.csv');
	let csvText: string | null = null;
	let source = '';
	// Prefer remote first
	try {
		csvText = await fetchText(primaryUrl);
		source = primaryUrl;
	} catch (e) {
		// Fallback to local
		if (fs.existsSync(localPath)) {
			csvText = fs.readFileSync(localPath, 'utf-8');
			source = 'local complete_translations.csv';
		}
	}
	if (!csvText) return { totalItems: 0, translatedExact: 0, translatedWithBaseFallback: 0, coverageExactPct: 0, coverageWithFallbackPct: 0, source };
	const rows = csvToObjects(csvText);
	const exactCol = langCode;
	const baseCol = toBaseLang(langCode);
	const totalItems = rows.length;
	const translatedExact = countNonEmpty(rows.map(r => r[exactCol]));
	const translatedWithBaseFallback = countNonEmpty(rows.map(r => r[exactCol] || r[baseCol]));
	return {
		totalItems,
		translatedExact,
		translatedWithBaseFallback,
		coverageExactPct: totalItems ? Math.round((translatedExact / totalItems) * 10000) / 100 : 0,
		coverageWithFallbackPct: totalItems ? Math.round((translatedWithBaseFallback / totalItems) * 10000) / 100 : 0,
		source
	};
}

async function checkDashboardTranslations(langCode: string): Promise<ReadinessReport['dashboard']> {
	const dashboardCsvPath = path.resolve(__dirname, '../public/translation_master.csv');
	let csvText: string | null = null;
	let source = dashboardCsvPath;
	if (fs.existsSync(dashboardCsvPath)) {
		csvText = fs.readFileSync(dashboardCsvPath, 'utf-8');
	} else {
		return { totalKeys: 0, translatedExact: 0, translatedWithBaseFallback: 0, coverageExactPct: 0, coverageWithFallbackPct: 0, source: 'not found' };
	}
	const rows = csvToObjects(csvText);
	if (rows.length === 0) return { totalKeys: 0, translatedExact: 0, translatedWithBaseFallback: 0, coverageExactPct: 0, coverageWithFallbackPct: 0, source };
	const exactCol = langCode;
	const baseCol = toBaseLang(langCode);
	const totalKeys = rows.length;
	const translatedExact = countNonEmpty(rows.map(r => r[exactCol]));
	const translatedWithBaseFallback = countNonEmpty(rows.map(r => r[exactCol] || r[baseCol]));
	return {
		totalKeys,
		translatedExact,
		translatedWithBaseFallback,
		coverageExactPct: totalKeys ? Math.round((translatedExact / totalKeys) * 10000) / 100 : 0,
		coverageWithFallbackPct: totalKeys ? Math.round((translatedWithBaseFallback / totalKeys) * 10000) / 100 : 0,
		source
	};
}

async function checkSurveyTranslations(langCode: string, env: 'dev' | 'prod'): Promise<ReadinessReport['surveys']> {
	const bucketName = env === 'prod' ? 'levante-dashboard-prod' : 'levante-dashboard-dev';
	const storage = new Storage();
	const bucket = storage.bucket(bucketName);
	// List JSON survey files at the bucket root
	const [files] = await bucket.getFiles({ prefix: '', autoPaginate: true });
	const surveyFiles = files.filter(f => f.name.endsWith('.json'));
	let filesWithLang = 0;
	let filesWithBase = 0;
	const details: Array<{ file: string; hasExact: boolean; hasBase: boolean }> = [];
	const base = toBaseLang(langCode);
	for (const file of surveyFiles) {
		let jsonText = '';
		try {
			const [buf] = await file.download();
			jsonText = buf.toString('utf-8');
			let hasExact = jsonText.includes(`"${langCode}"`) || jsonText.includes(`'${langCode}'`);
			let hasBase = !hasExact && (jsonText.includes(`"${base}"`) || jsonText.includes(`'${base}'`));
			// Treat implicit English as coverage when no explicit locale keys are present
			// - exact for 'en'
			// - base for any 'en-*' variant
			if (!hasExact && !hasBase && base === 'en') {
				if (langCode === 'en') { hasExact = true; } else { hasBase = true; }
			}
			if (hasExact) filesWithLang++;
			if (hasBase) filesWithBase++;
			details.push({ file: file.name, hasExact, hasBase });
		} catch (e) {
			// Skip unreadable files
		}
	}
	return { filesChecked: surveyFiles.length, filesWithLang, filesWithBaseFallback: filesWithBase, details, bucket: bucketName };
}

async function checkAudioFiles(langCode: string, env: 'dev' | 'prod'): Promise<ReadinessReport['audio']> {
	const bucketName = env === 'prod' ? 'levante-audio-prod' : 'levante-audio-dev';
	const storage = new Storage();
	const bucket = storage.bucket(bucketName);
	const prefix = `${langCode}/`;
	let total = 0;
	try {
		const [files] = await bucket.getFiles({ prefix, autoPaginate: true });
		total = files.filter(f => f.name.toLowerCase().endsWith('.mp3')).length;
	} catch (e) {
		// leave total at 0
	}
	return { bucket: bucketName, prefix, files: total };
}

function printReport(report: ReadinessReport) {
	console.log(`\n=== Preflight Report for ${report.languageCode} ===`);
	console.log(`\nItem Bank Translations [source: ${report.itemBank.source}]`);
	console.log(`- Total items: ${report.itemBank.totalItems}`);
	console.log(`- Exact translations: ${report.itemBank.translatedExact} (${report.itemBank.coverageExactPct}%)`);
	console.log(`- With base fallback: ${report.itemBank.translatedWithBaseFallback} (${report.itemBank.coverageWithFallbackPct}%)`);

	console.log(`\nSurvey Translations [bucket: ${report.surveys.bucket}]`);
	console.log(`- Survey files checked: ${report.surveys.filesChecked}`);
	console.log(`- Files with exact locale: ${report.surveys.filesWithLang}`);
	console.log(`- Files with base fallback: ${report.surveys.filesWithBaseFallback}`);

	console.log(`\nDashboard Translations [source: ${report.dashboard.source}]`);
	console.log(`- Total keys: ${report.dashboard.totalKeys}`);
	console.log(`- Exact translations: ${report.dashboard.translatedExact} (${report.dashboard.coverageExactPct}%)`);
	console.log(`- With base fallback: ${report.dashboard.translatedWithBaseFallback} (${report.dashboard.coverageWithFallbackPct}%)`);

	console.log(`\nAudio Files [bucket: ${report.audio.bucket}]`);
	console.log(`- Prefix: ${report.audio.prefix}`);
	console.log(`- MP3 files: ${report.audio.files}`);
	console.log(`\n============================================\n`);
}

async function main() {
	const args = process.argv.slice(2);
	if (args.length < 1) {
		console.error('Usage: ts-node preflight/preflight-locale.ts <langCode> [--env dev|prod]');
		process.exit(1);
	}
	const langCode = args[0];
	const envFlagIndex = args.findIndex(a => a === '--env');
	let env: 'dev' | 'prod' = 'dev';
	if (envFlagIndex !== -1 && args[envFlagIndex + 1]) {
		const val = args[envFlagIndex + 1].toLowerCase();
		if (val === 'prod' || val === 'production') env = 'prod';
	}

	const [itemBank, surveys, dashboard, audio] = await Promise.all([
		checkItemBank(langCode),
		checkSurveyTranslations(langCode, env),
		checkDashboardTranslations(langCode),
		checkAudioFiles(langCode, env),
	]);

	const report: ReadinessReport = { languageCode: langCode, itemBank, surveys, dashboard, audio };
	printReport(report);

	// Exit non-zero if any critical area has 0 coverage (exact + fallback) to aid CI gates
	const ibOk = itemBank.translatedWithBaseFallback > 0;
	const dashOk = dashboard.translatedWithBaseFallback > 0;
	const surveyOk = surveys.filesChecked === 0 || (surveys.filesWithLang + surveys.filesWithBaseFallback) > 0; // tolerate no survey files
	const audioOk = audio.files > 0;
	if (!ibOk || !dashOk || !surveyOk || !audioOk) {
		process.exitCode = 2;
	}
}

main().catch(err => {
	console.error('Preflight failed:', err);
	process.exit(1);
});
