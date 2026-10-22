import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { defineConfig } from 'vite';

const { version } = JSON.parse( readFileSync( new URL( './package.json', import.meta.url ), 'utf8' ) );

// glTF files can be Draco-compressed; the decoder is loaded at run time from <base>/draco/.
const DRACO_FILES = [ 'draco_decoder.js', 'draco_decoder.wasm', 'draco_wasm_wrapper.js' ];
const DRACO_DIR = new URL( './node_modules/three/examples/jsm/libs/draco/', import.meta.url ).pathname;

const dracoDecoder = () => ( {
	name: 'draco-decoder',
	configureServer( server ) {

		server.middlewares.use( '/draco', ( req, res, next ) => {

			const name = ( req.url || '' ).split( '?' )[ 0 ].replace( /^\//, '' );
			if ( ! DRACO_FILES.includes( name ) ) return next();
			res.setHeader( 'Content-Type', extname( name ) === '.wasm' ? 'application/wasm' : 'text/javascript' );
			res.end( readFileSync( join( DRACO_DIR, name ) ) );

		} );

	},
	generateBundle() {

		for ( const name of DRACO_FILES ) this.emitFile( { type: 'asset', fileName: `draco/${ name }`, source: readFileSync( join( DRACO_DIR, name ) ) } );

	},
} );

export default defineConfig( {
	plugins: [ dracoDecoder() ],
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
