type LatLonSource = 'gps' | 'h3_center' | 'approximate';

interface H3PopulationSource {
    name: 'kontur' | 'worldpop' | 'unknown' | string;
    getPopulation: (cellId: string, resolution: number) => Promise<number | null> | number | null;
}

interface PopulationSourceComparisonResult {
    kontur: LocationBuildResult;
    worldpop: LocationBuildResult;
    comparison: {
        confidence: 'high' | 'medium' | 'low';
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

const DEFAULT_POP_THRESHOLD = 50000;
const DEFAULT_BASELINE_RESOLUTION = 5;
const DEFAULT_MAX_RESOLUTION = 9;

function getH3Api(): any {
    const h3 = (window as any)?.h3;
    if (!h3 || typeof h3.latLngToCell !== 'function' || typeof h3.cellToLatLng !== 'function') {
        throw new Error(
            'H3 API is not available on window.h3. Load h3-js in the client before calling buildObfuscatedLocationFromLatLon.'
        );
    }
    return h3;
}

function createKonturPopulationSource(
    cacheByResolution: Record<string, Record<string, number | null | undefined>>
): H3PopulationSource {
    return createMapPopulationSource('kontur', cacheByResolution);
}

function createWorldpopPopulationSource(
    cacheByResolution: Record<string, Record<string, number | null | undefined>>
): H3PopulationSource {
    return createMapPopulationSource('worldpop', cacheByResolution);
}

function createMapPopulationSource(
    sourceName: 'kontur' | 'worldpop' | string,
    cacheByResolution: Record<string, Record<string, number | null | undefined>>
): H3PopulationSource {
    const h3 = getH3Api();
    const cache = cacheByResolution || {};
    const availableRes = Object.keys(cache)
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value))
        .sort((a, b) => a - b);

    const getPopulation = (cellId: string, resolution: number): number | null => {
        const exact = cache[String(resolution)]?.[cellId];
        if (typeof exact === 'number' && Number.isFinite(exact) && exact >= 0) {
            return Math.round(exact);
        }

        // Geostrategy-compatible fallback:
        // If we only have finer cached cells, aggregate descendants.
        const finerRes = availableRes.find((r) => r > resolution);
        if (!Number.isInteger(finerRes)) return null;
        const finerMap = cache[String(finerRes)];
        if (!finerMap) return null;
        if (typeof h3.cellToChildren !== 'function') return null;

        let sum = 0;
        let seen = 0;
        try {
            const children = h3.cellToChildren(cellId, finerRes);
            for (const child of children) {
                const value = finerMap[child];
                if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
                    sum += value;
                    seen += 1;
                }
            }
        } catch {
            return null;
        }
        return seen ? Math.round(sum) : null;
    };

    return {
        name: sourceName,
        getPopulation,
    };
}

function asFiniteNumber(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${field} must be a finite number`);
    }
    return value;
}

function asLatitude(value: unknown): number {
    const lat = asFiniteNumber(value, 'lat');
    if (lat < -90 || lat > 90) throw new Error('lat must be between -90 and 90');
    return lat;
}

function asLongitude(value: unknown): number {
    const lon = asFiniteNumber(value, 'lon');
    if (lon < -180 || lon > 180) throw new Error('lon must be between -180 and 180');
    return lon;
}

function asResolution(value: unknown, fallback: number): number {
    const raw = value == null ? fallback : asFiniteNumber(value, 'resolution');
    if (!Number.isInteger(raw) || raw < 0 || raw > 15) {
        throw new Error('resolution must be an integer between 0 and 15');
    }
    return raw;
}

async function resolvePopulation(
    options: LocationBuildOptions,
    cellId: string,
    resolution: number
): Promise<number | null> {
    const provided = options.populationByResolution?.[String(resolution)];
    if (typeof provided === 'number' && Number.isFinite(provided) && provided >= 0) {
        return Math.round(provided);
    }
    if (typeof options.estimatePopulationForCell === 'function') {
        const estimated = await options.estimatePopulationForCell(cellId, resolution);
        if (typeof estimated === 'number' && Number.isFinite(estimated) && estimated >= 0) {
            return Math.round(estimated);
        }
    }
    return null;
}

async function resolvePopulationFromSource(
    populationSource: H3PopulationSource,
    cellId: string,
    resolution: number
): Promise<number | null> {
    const value = await populationSource.getPopulation(cellId, resolution);
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        return Math.round(value);
    }
    return null;
}

/**
 * Builds a privacy-safe Location object on-device.
 *
 * Important privacy behavior:
 * - Uses raw input lat/lon ONLY to choose H3 cells.
 * - Writes returned location.latLon from the selected H3 effective cell center.
 * - Never copies raw precise lat/lon into the returned object.
 */
async function buildObfuscatedLocationFromLatLon(
    lat: number,
    lon: number,
    options: LocationBuildOptions = {}
): Promise<LocationBuildResult> {
    const h3 = getH3Api();
    const safeLat = asLatitude(lat);
    const safeLon = asLongitude(lon);
    const baselineResolution = asResolution(options.baselineResolution, DEFAULT_BASELINE_RESOLUTION);
    const maxResolution = asResolution(options.maxResolution, DEFAULT_MAX_RESOLUTION);
    if (maxResolution < baselineResolution) {
        throw new Error('maxResolution must be >= baselineResolution');
    }

    const thresholdRaw = options.populationThreshold ?? DEFAULT_POP_THRESHOLD;
    const populationThreshold = asFiniteNumber(thresholdRaw, 'populationThreshold');
    if (!Number.isInteger(populationThreshold) || populationThreshold <= 0) {
        throw new Error('populationThreshold must be a positive integer');
    }

    const candidates: LocationBuildResult['analysis']['candidates'] = [];
    let effectiveCandidate: LocationBuildResult['analysis']['candidates'][number] | null = null;
    for (let resolution = baselineResolution; resolution <= maxResolution; resolution += 1) {
        const cellId = h3.latLngToCell(safeLat, safeLon, resolution);
        const population = await resolvePopulation(options, cellId, resolution);
        const candidate = {
            resolution,
            cellId,
            population,
            privacyMet: typeof population === 'number' ? population >= populationThreshold : false,
        };
        candidates.push(candidate);

        if (candidate.privacyMet) {
            effectiveCandidate = candidate;
            continue;
        }
        if (effectiveCandidate) break;
    }

    const baseline = candidates.find((c) => c.resolution === baselineResolution)!;
    const effective = effectiveCandidate || baseline;
    const center = h3.cellToLatLng(effective.cellId);
    const source: LatLonSource = options.latLonSource || 'h3_center';

    const latLon = {
        lat: center[0],
        lon: center[1],
        source,
        ...(source === 'approximate' && options.blurRadiusMeters
            ? { blurRadiusMeters: options.blurRadiusMeters }
            : {}),
    };

    const location: LocationBuildResult['location'] = {
        schemaVersion: 'location_v1',
        latLon,
        h3: {
            scheme: 'h3_v1',
            baseline: {
                cellId: baseline.cellId,
                resolution: baseline.resolution,
            },
            effective: {
                cellId: effective.cellId,
                resolution: effective.resolution,
            },
            populationThreshold,
        },
        computedAt: options.computedAt || new Date().toISOString(),
        populationSource: 'unknown',
    };

    return {
        location,
        analysis: {
            thresholdMet: effective.privacyMet,
            populationDataAvailable: candidates.some((candidate) => typeof candidate.population === 'number'),
            candidates,
        },
    };
}

async function compareKonturAndWorldpopLocationBuild(
    lat: number,
    lon: number,
    konturSource: H3PopulationSource,
    worldpopSource: H3PopulationSource,
    options: LocationBuildOptions = {}
): Promise<PopulationSourceComparisonResult> {
    const [kontur, worldpop] = await Promise.all([
        buildObfuscatedLocationFromLatLonWithPopulationSource(lat, lon, konturSource, options),
        buildObfuscatedLocationFromLatLonWithPopulationSource(lat, lon, worldpopSource, options),
    ]);

    const konturEffectiveCell = kontur.location.h3.effective.cellId;
    const worldpopEffectiveCell = worldpop.location.h3.effective.cellId;
    const konturEffectiveRes = kontur.location.h3.effective.resolution;
    const worldpopEffectiveRes = worldpop.location.h3.effective.resolution;
    const konturEffectiveCandidate =
        kontur.analysis.candidates.find((c) => c.resolution === konturEffectiveRes) || null;
    const worldpopEffectiveCandidate =
        worldpop.analysis.candidates.find((c) => c.resolution === worldpopEffectiveRes) || null;
    const sameEffectiveCell = konturEffectiveCell === worldpopEffectiveCell;
    const sameEffectiveResolution = konturEffectiveRes === worldpopEffectiveRes;
    const confidence: 'high' | 'medium' | 'low' = sameEffectiveCell
        ? 'high'
        : sameEffectiveResolution
            ? 'medium'
            : 'low';

    return {
        kontur,
        worldpop,
        comparison: {
            confidence,
            sameEffectiveCell,
            sameEffectiveResolution,
            konturEffective: {
                cellId: konturEffectiveCell,
                resolution: konturEffectiveRes,
                population: konturEffectiveCandidate?.population ?? null,
                thresholdMet: Boolean(konturEffectiveCandidate?.privacyMet),
            },
            worldpopEffective: {
                cellId: worldpopEffectiveCell,
                resolution: worldpopEffectiveRes,
                population: worldpopEffectiveCandidate?.population ?? null,
                thresholdMet: Boolean(worldpopEffectiveCandidate?.privacyMet),
            },
        },
    };
}

/**
 * Geostrategy-style variant:
 * - Requires a population source.
 * - Scans from baseline -> finer resolutions (privacy-first).
 * - Promotes effective while population stays >= threshold.
 * - Stops probing finer cells after first threshold failure once a valid effective exists.
 * - Uses baseline when no candidate meets threshold.
 */
async function buildObfuscatedLocationFromLatLonWithPopulationSource(
    lat: number,
    lon: number,
    populationSource: H3PopulationSource,
    options: LocationBuildOptions = {}
): Promise<LocationBuildResult> {
    const h3 = getH3Api();
    const safeLat = asLatitude(lat);
    const safeLon = asLongitude(lon);
    const baselineResolution = asResolution(options.baselineResolution, DEFAULT_BASELINE_RESOLUTION);
    const maxResolution = asResolution(options.maxResolution, DEFAULT_MAX_RESOLUTION);
    if (maxResolution < baselineResolution) {
        throw new Error('maxResolution must be >= baselineResolution');
    }
    if (!populationSource || typeof populationSource.getPopulation !== 'function') {
        throw new Error('populationSource with getPopulation(cellId, resolution) is required');
    }

    const thresholdRaw = options.populationThreshold ?? DEFAULT_POP_THRESHOLD;
    const populationThreshold = asFiniteNumber(thresholdRaw, 'populationThreshold');
    if (!Number.isInteger(populationThreshold) || populationThreshold <= 0) {
        throw new Error('populationThreshold must be a positive integer');
    }

    const candidates: LocationBuildResult['analysis']['candidates'] = [];
    let effectiveCandidate: LocationBuildResult['analysis']['candidates'][number] | null = null;
    for (let resolution = baselineResolution; resolution <= maxResolution; resolution += 1) {
        const cellId = h3.latLngToCell(safeLat, safeLon, resolution);
        const population = await resolvePopulationFromSource(populationSource, cellId, resolution);
        const candidate = {
            resolution,
            cellId,
            population,
            privacyMet: typeof population === 'number' ? population >= populationThreshold : false,
        };
        candidates.push(candidate);

        if (candidate.privacyMet) {
            effectiveCandidate = candidate;
            continue;
        }

        // Privacy-first: once threshold fails after we had a valid effective,
        // stop scanning to avoid probing unnecessarily precise cells.
        if (effectiveCandidate) {
            break;
        }
    }

    const baseline = candidates.find((candidate) => candidate.resolution === baselineResolution)!;
    const effective = effectiveCandidate || baseline;
    const center = h3.cellToLatLng(effective.cellId);
    const source: LatLonSource = options.latLonSource || 'h3_center';
    const latLon = {
        lat: center[0],
        lon: center[1],
        source,
        ...(source === 'approximate' && options.blurRadiusMeters
            ? { blurRadiusMeters: options.blurRadiusMeters }
            : {}),
    };

    const location: LocationBuildResult['location'] = {
        schemaVersion: 'location_v1',
        latLon,
        h3: {
            scheme: 'h3_v1',
            baseline: {
                cellId: baseline.cellId,
                resolution: baseline.resolution,
            },
            effective: {
                cellId: effective.cellId,
                resolution: effective.resolution,
            },
            populationThreshold,
        },
        computedAt: options.computedAt || new Date().toISOString(),
        populationSource: String(populationSource.name || 'unknown'),
    };

    return {
        location,
        analysis: {
            thresholdMet: effective.privacyMet,
            populationDataAvailable: candidates.some((candidate) => typeof candidate.population === 'number'),
            candidates,
        },
    };
}

(window as any).buildObfuscatedLocationFromLatLon = buildObfuscatedLocationFromLatLon;
(window as any).buildObfuscatedLocationFromLatLonWithPopulationSource = buildObfuscatedLocationFromLatLonWithPopulationSource;
(window as any).createKonturPopulationSource = createKonturPopulationSource;
(window as any).createWorldpopPopulationSource = createWorldpopPopulationSource;
(window as any).compareKonturAndWorldpopLocationBuild = compareKonturAndWorldpopLocationBuild;
