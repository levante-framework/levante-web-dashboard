interface Credentials {
    playht_api_key?: string;
    playht_user_id?: string;
    elevenlabs_api_key?: string;
    google_translate_api_key?: string;
}
/**
 * Formats a byte count into human-readable file size
 * @param {number | null | undefined} bytes - The number of bytes
 * @returns {string} Formatted size string (e.g., "1.5 MB") or "N/A"
 */
declare function formatFileSize(bytes: number | null | undefined): string;
/**
 * Formats a date string into localized date/time representation
 * @param {string | null | undefined} dateString - ISO date string or similar
 * @returns {string} Formatted date string or "N/A" if invalid
 */
declare function formatDate(dateString: string | null | undefined): string;
/**
 * Clears the translation cache and reloads the page after user confirmation
 */
declare function clearCacheAndReload(): void;
//# sourceMappingURL=utils.d.ts.map