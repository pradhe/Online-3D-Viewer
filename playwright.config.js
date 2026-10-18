import { defineConfig } from '@playwright/test';

// PLAYWRIGHT_CHROMIUM lets a machine with a preinstalled browser (like a CI image or a cloud
// sandbox) skip the download; software WebGL is enough for these smoke tests.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM || undefined;

export default defineConfig( {
	testDir: 'tests/e2e',
	timeout: 120_000,
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? [ [ 'github' ], [ 'list' ] ] : 'list',
	use: {
		baseURL: 'http://localhost:4173/',
		launchOptions: {
			executablePath,
			args: [ '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist' ],
		},
	},
	webServer: {
		command: 'npm run build && npm run preview -- --port 4173 --strictPort',
		url: 'http://localhost:4173/',
		reuseExistingServer: ! process.env.CI,
		timeout: 180_000,
	},
} );
