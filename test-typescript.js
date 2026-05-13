#!/usr/bin/env node

/**
 * TypeScript Build Integrity Test Suite
 * Tests compile health, build artifacts, and parseability
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Test configuration
const TEST_CONFIG = {
    publicDir: 'public',
    tsDir: 'public/ts',
    jsCompiledDir: 'public/js-compiled',
    jsOriginalDir: 'public/js'
};

// ANSI color codes for pretty output
const colors = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m'
};

/**
 * Logger with colors
 */
class TestLogger {
    static success(message) {
        console.log(`${colors.green}✅ ${message}${colors.reset}`);
    }
    
    static error(message) {
        console.log(`${colors.red}❌ ${message}${colors.reset}`);
    }
    
    static warning(message) {
        console.log(`${colors.yellow}⚠️  ${message}${colors.reset}`);
    }
    
    static info(message) {
        console.log(`${colors.blue}ℹ️  ${message}${colors.reset}`);
    }
    
    static section(message) {
        console.log(`\n${colors.cyan}📋 ${message}${colors.reset}`);
        console.log(`${colors.cyan}${'='.repeat(message.length + 3)}${colors.reset}`);
    }
}

/**
 * Test result tracking
 */
class TestResults {
    constructor() {
        this.tests = [];
        this.passed = 0;
        this.failed = 0;
    }
    
    addTest(name, passed, details = '') {
        this.tests.push({ name, passed, details });
        if (passed) {
            this.passed++;
            TestLogger.success(`${name}${details ? ` - ${details}` : ''}`);
        } else {
            this.failed++;
            TestLogger.error(`${name}${details ? ` - ${details}` : ''}`);
        }
    }
    
    summary() {
        TestLogger.section('Test Summary');
        console.log(`Total tests: ${this.tests.length}`);
        console.log(`${colors.green}Passed: ${this.passed}${colors.reset}`);
        console.log(`${colors.red}Failed: ${this.failed}${colors.reset}`);
        console.log(`Success rate: ${((this.passed / this.tests.length) * 100).toFixed(1)}%`);
        
        if (this.failed > 0) {
            TestLogger.section('Failed Tests');
            this.tests.filter(t => !t.passed).forEach(test => {
                TestLogger.error(`${test.name}: ${test.details}`);
            });
        }
        
        return this.failed === 0;
    }
}

/**
 * File system utilities
 */
class FileUtils {
    static exists(filePath) {
        return fs.existsSync(filePath);
    }
    
    static readFile(filePath) {
        return fs.readFileSync(filePath, 'utf8');
    }
    
    static getFileSize(filePath) {
        return fs.statSync(filePath).size;
    }
    
    static listFiles(dirPath, extension = '') {
        if (!this.exists(dirPath)) return [];
        return fs.readdirSync(dirPath)
            .filter(file => extension ? file.endsWith(extension) : true)
            .map(file => path.join(dirPath, file));
    }
}

/**
 * TypeScript compilation tests
 */
class CompilationTests {
    static async runAll(results) {
        TestLogger.section('TypeScript Build Health');
        
        // Test 1: TypeScript files exist
        const expectedTSFiles = [
            'utils.ts', 'credentials.ts', 'audio.ts', 
            'language-config.ts', 'bootstrap.ts', 'types.ts'
        ];
        
        for (const file of expectedTSFiles) {
            const filePath = path.join(TEST_CONFIG.tsDir, file);
            results.addTest(
                `TypeScript file exists: ${file}`,
                FileUtils.exists(filePath)
            );
        }
        
        // Test 2: TypeScript compilation
        try {
            execSync('npm run type-check', { stdio: 'pipe' });
            results.addTest('TypeScript type checking', true, 'No type errors');
        } catch (error) {
            results.addTest('TypeScript type checking', false, error.message);
        }
        
        // Test 3: JavaScript compilation
        try {
            execSync('npm run build:ts', { stdio: 'pipe' });
            results.addTest('TypeScript to JavaScript compilation', true, 'Build successful');
        } catch (error) {
            results.addTest('TypeScript to JavaScript compilation', false, error.message);
        }
        
        // Test 4: Compiled JavaScript files exist
        for (const file of expectedTSFiles) {
            const jsFile = file.replace('.ts', '.js');
            const filePath = path.join(TEST_CONFIG.jsCompiledDir, jsFile);
            results.addTest(
                `Compiled JavaScript exists: ${jsFile}`,
                FileUtils.exists(filePath)
            );
        }
        
        // Test 5: Declaration files exist
        for (const file of expectedTSFiles) {
            const dtsFile = file.replace('.ts', '.d.ts');
            const filePath = path.join(TEST_CONFIG.jsCompiledDir, dtsFile);
            results.addTest(
                `Type declaration exists: ${dtsFile}`,
                FileUtils.exists(filePath)
            );
        }
        
        // Test 6: Source maps exist
        for (const file of expectedTSFiles) {
            const mapFile = file.replace('.ts', '.js.map');
            const filePath = path.join(TEST_CONFIG.jsCompiledDir, mapFile);
            results.addTest(
                `Source map exists: ${mapFile}`,
                FileUtils.exists(filePath)
            );
        }
    }
}

/**
 * Code quality tests
 */
class CodeQualityTests {
    static async runAll(results) {
        TestLogger.section('Source and Syntax Integrity');
        
        // Test 1: TypeScript source files are non-empty
        const tsFiles = FileUtils.listFiles(TEST_CONFIG.tsDir, '.ts');
        
        for (const filePath of tsFiles) {
            const content = FileUtils.readFile(filePath);
            const fileName = path.basename(filePath);
            results.addTest(
                `${fileName} is non-empty`,
                content.trim().length > 0
            );
        }
        
        // Test 2: Compiled JavaScript parses successfully
        const vm = require('vm');
        for (const filePath of FileUtils.listFiles(TEST_CONFIG.jsCompiledDir, '.js')) {
            const content = FileUtils.readFile(filePath);
            const fileName = path.basename(filePath);
            try {
                new vm.Script(content);
                results.addTest(`${fileName} has valid syntax`, true);
            } catch (error) {
                results.addTest(`${fileName} has valid syntax`, false, error.message.substring(0, 100));
            }
        }
        
        // Test 3: Type definitions are comprehensive
        const typesFile = path.join(TEST_CONFIG.jsCompiledDir, 'types.d.ts');
        if (FileUtils.exists(typesFile)) {
            const content = FileUtils.readFile(typesFile);
            const hasInterfaces = content.includes('interface');
            const hasTypes = content.includes('type');
            const hasExports = content.includes('export');
            
            results.addTest(
                'Type definitions are comprehensive',
                hasInterfaces && hasTypes && hasExports,
                `Interfaces: ${hasInterfaces}, Types: ${hasTypes}, Exports: ${hasExports}`
            );
        }
    }
}

/**
 * Integration tests
 */
class IntegrationTests {
    static async runAll(results) {
        TestLogger.section('Compiled Artifact Integrity');
        
        // Test 1: Required compiled files exist and are non-empty
        const expectedSizes = {
            'utils.js': { min: 1000, max: 15000 },
            'credentials.js': { min: 1000, max: 20000 },
            'audio.js': { min: 1000, max: 25000 },
            'language-config.js': { min: 1000, max: 20000 },
            'bootstrap.js': { min: 500, max: 15000 }
        };
        
        for (const [file, sizes] of Object.entries(expectedSizes)) {
            const filePath = path.join(TEST_CONFIG.jsCompiledDir, file);
            const exists = FileUtils.exists(filePath);
            results.addTest(`${file} exists`, exists);
            if (exists) {
                const size = FileUtils.getFileSize(filePath);
                const isValidSize = size >= sizes.min && size <= sizes.max;
                results.addTest(
                    `${file} has reasonable size`,
                    isValidSize,
                    `${size} bytes (expected ${sizes.min}-${sizes.max})`
                );
            }
        }
    }
}

/**
 * Runtime functionality tests
 */
class RuntimeTests {
    static async runAll(results) {
        TestLogger.section('JavaScript Parseability Checks');
        
        // Test 1: Compiled JavaScript can be parsed
        const jsFiles = FileUtils.listFiles(TEST_CONFIG.jsCompiledDir, '.js');
        const vm = require('vm');
        
        for (const filePath of jsFiles) {
            const fileName = path.basename(filePath);
            const content = FileUtils.readFile(filePath);
            
            try {
                new vm.Script(content);
                results.addTest(`${fileName} parses successfully`, true);
            } catch (error) {
                results.addTest(
                    `${fileName} parses successfully`, 
                    false, 
                    error.message.substring(0, 100)
                );
            }
        }
    }
}

/**
 * Performance tests
 */
class PerformanceTests {
    static async runAll(results) {
        TestLogger.section('Build Performance Checks');
        
        // Test 1: Compilation time
        const startTime = Date.now();
        try {
            execSync('npm run build:ts', { stdio: 'pipe' });
            const compilationTime = Date.now() - startTime;
            results.addTest(
                'Compilation time is reasonable',
                compilationTime < 10000,
                `${compilationTime}ms (should be < 10s)`
            );
        } catch (error) {
            results.addTest('Compilation time test', false, 'Compilation failed');
        }
        
        // Test 2: Total compiled size
        let totalSize = 0;
        const jsFiles = FileUtils.listFiles(TEST_CONFIG.jsCompiledDir, '.js');
        
        for (const filePath of jsFiles) {
            totalSize += FileUtils.getFileSize(filePath);
        }
        
        results.addTest(
            'Total compiled size is reasonable',
            totalSize < 100000, // Less than 100KB
            `${totalSize} bytes (should be < 100KB)`
        );
        
        // Test 3: Source map overhead
        let totalMapSize = 0;
        const mapFiles = FileUtils.listFiles(TEST_CONFIG.jsCompiledDir, '.js.map');
        
        for (const filePath of mapFiles) {
            totalMapSize += FileUtils.getFileSize(filePath);
        }
        
        const mapOverhead = totalMapSize / totalSize;
        results.addTest(
            'Source map overhead is reasonable',
            mapOverhead < 2, // Less than 2x the original size
            `${(mapOverhead * 100).toFixed(1)}% overhead (should be < 200%)`
        );
    }
}

/**
 * Main test runner
 */
async function runAllTests() {
    console.log(`${colors.magenta}🧪 TypeScript Build Integrity Test Suite${colors.reset}`);
    console.log(`${colors.magenta}=========================================${colors.reset}\n`);
    
    const results = new TestResults();
    
    try {
        // Change to web-dashboard directory if needed
        if (process.cwd().endsWith('levante_translations')) {
            process.chdir('web-dashboard');
        }
        
        // Run all test suites
        await CompilationTests.runAll(results);
        await CodeQualityTests.runAll(results);
        await IntegrationTests.runAll(results);
        await RuntimeTests.runAll(results);
        await PerformanceTests.runAll(results);
        
        // Print summary
        const success = results.summary();
        
        if (success) {
            TestLogger.section('🎉 All Tests Passed!');
            console.log('TypeScript build artifacts are healthy and test checks passed.');
        } else {
            TestLogger.section('❌ Some Tests Failed');
            console.log('Please review the failed tests above and fix the issues.');
            process.exit(1);
        }
        
    } catch (error) {
        TestLogger.error(`Test execution failed: ${error.message}`);
        process.exit(1);
    }
}

// Run tests if this script is executed directly
if (require.main === module) {
    runAllTests();
}

module.exports = {
    runAllTests,
    TestLogger,
    TestResults,
    CompilationTests,
    CodeQualityTests,
    IntegrationTests,
    RuntimeTests,
    PerformanceTests
};
