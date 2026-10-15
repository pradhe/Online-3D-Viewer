import { defineConfig } from 'vite';

export default defineConfig( {
	// Relative paths so the built site works from any folder (GitHub Pages, S3, etc.).
	base: './',
	build: {
		chunkSizeWarningLimit: 1500,
	},
} );
