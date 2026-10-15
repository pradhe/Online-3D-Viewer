import { defineConfig } from 'vite';

export default defineConfig( {
	// Relative paths so the built site works from any folder or host.
	base: './',
	build: {
		chunkSizeWarningLimit: 1500,
		// The repository is private: never publish source maps that would expose the original source.
		sourcemap: false,
	},
} );
