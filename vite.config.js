import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const { version } = JSON.parse( readFileSync( new URL( './package.json', import.meta.url ), 'utf8' ) );

export default defineConfig( {
	// Relative paths so the built site works from any folder or host.
	base: './',
	define: { 'import.meta.env.VITE_APP_VERSION': JSON.stringify( version ) },
	// Unit tests only; tests/e2e belongs to Playwright.
	test: { include: [ 'tests/unit/**/*.test.js' ] },
	build: {
		chunkSizeWarningLimit: 1500,
		// The repository is private: never publish source maps that would expose the original source.
		sourcemap: false,
	},
} );
