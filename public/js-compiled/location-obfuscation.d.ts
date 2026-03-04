type LatLonSource = 'gps' | 'h3_center' | 'approximate';
interface H3PopulationSource {
    name: 'kontur' | 'worldpop' | 'unknown' | string;
    getPopulation: (cellId: string, resolution: number) => Promise<number | null> | number | null;
}
interface PopulationSourceComparisonResult {
    kontur: LocationBuildResult;
    worldpop: LocationBuildResult;
    comparison: {
        sameEffectiveCell: boolean;
        sameEffectiveResolution: boolean;
        konturEffective: {
            cellId: string;
            resolution: number;
            population: number | null;
            thresholdMet: boolean;
        };
        worldpopEffective: {
            cellId: string;
            resolution: number;
            population: number | null;
            thresholdMet: boolean;
        };
    };
}
interface LocationBuildOptions {
    populationThreshold?: number;
    baselineResolution?: number;
    maxResolution?: number;
    populationByResolution?: Record<string, number | null | undefined>;
    estimatePopulationForCell?: (cellId: string, resolution: number) => Promise<number | null>;
    latLonSource?: LatLonSource;
    blurRadiusMeters?: number;
    computedAt?: string;
}
interface LocationBuildResult {
    location: {
        schemaVersion: 'location_v1';
        latLon: {
            lat: number;
            lon: number;
            source: LatLonSource;
            blurRadiusMeters?: number;
        };
        h3: {
            scheme: 'h3_v1';
            baseline: {
                cellId: string;
                resolution: number;
            };
            effective: {
                cellId: string;
                resolution: number;
            };
            populationThreshold: number;
        };
        computedAt: string;
        populationSource: string;
    };
    analysis: {
        thresholdMet: boolean;
        populationDataAvailable: boolean;
        candidates: Array<{
            resolution: number;
            cellId: string;
            population: number | null;
            privacyMet: boolean;
        }>;
    };
}
declare const DEFAULT_POP_THRESHOLD = 50000;
declare const DEFAULT_BASELINE_RESOLUTION = 5;
declare const DEFAULT_MAX_RESOLUTION = 9;
declare function getH3Api(): any;
declare function createKonturPopulationSource(cacheByResolution: Record<string, Record<string, number | null | undefined>>): H3PopulationSource;
declare function createWorldpopPopulationSource(cacheByResolution: Record<string, Record<string, number | null | undefined>>): H3PopulationSource;
declare function createMapPopulationSource(sourceName: 'kontur' | 'worldpop' | string, cacheByResolution: Record<string, Record<string, number | null | undefined>>): H3PopulationSource;
declare function asFiniteNumber(value: unknown, field: string): number;
declare function asLatitude(value: unknown): number;
declare function asLongitude(value: unknown): number;
declare function asResolution(value: unknown, fallback: number): number;
declare function resolvePopulation(options: LocationBuildOptions, cellId: string, resolution: number): Promise<number | null>;
declare function resolvePopulationFromSource(populationSource: H3PopulationSource, cellId: string, resolution: number): Promise<number | null>;
/**
 * Builds a privacy-safe Location object on-device.
 *
 * Important privacy behavior:
 * - Uses raw input lat/lon ONLY to choose H3 cells.
 * - Writes returned location.latLon from the selected H3 effective cell center.
 * - Never copies raw precise lat/lon into the returned object.
 */
declare function buildObfuscatedLocationFromLatLon(lat: number, lon: number, options?: LocationBuildOptions): Promise<LocationBuildResult>;
declare function compareKonturAndWorldpopLocationBuild(lat: number, lon: number, konturSource: H3PopulationSource, worldpopSource: H3PopulationSource, options?: LocationBuildOptions): Promise<PopulationSourceComparisonResult>;
/**
 * Geostrategy-style variant:
 * - Requires a population source.
 * - Scans from baseline -> finer resolutions (privacy-first).
 * - Promotes effective while population stays >= threshold.
 * - Stops probing finer cells after first threshold failure once a valid effective exists.
 * - Uses baseline when no candidate meets threshold.
 */
declare function buildObfuscatedLocationFromLatLonWithPopulationSource(lat: number, lon: number, populationSource: H3PopulationSource, options?: LocationBuildOptions): Promise<LocationBuildResult>;
//# sourceMappingURL=location-obfuscation.d.ts.map