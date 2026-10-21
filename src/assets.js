import { unzipSync } from 'three/addons/libs/fflate.module.js';

export const USD_EXTENSIONS = [ 'usd', 'usda', 'usdc', 'usdz' ];
export const MODEL_EXTENSIONS = [ 'obj', ...USD_EXTENSIONS ];
export const ACCEPT = [ ...MODEL_EXTENSIONS, 'mtl', 'zip', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'tga', 'gif' ]
	.map( ( e ) => '.' + e ).join( ',' );

export function extensionOf( name ) {

	const clean = name.split( /[?#]/ )[ 0 ];
	const base = baseName( clean );
	const parts = base.toLowerCase().split( '.' );
	if ( parts.length < 2 ) return '';
	const ext = parts.pop();
	// Browsers sometimes save text models as "scene.usda.txt" or "model.obj.txt".
	if ( ext === 'txt' && parts.length > 1 && [ 'obj', 'mtl', 'usd', 'usda' ].includes( parts[ parts.length - 1 ] ) ) return parts.pop();
	return ext;

}

export function baseName( path ) {

	let name = path.split( /[?#]/ )[ 0 ].split( /[\\/]/ ).pop();
	try {

		name = decodeURIComponent( name );

	} catch {

		// keep the raw name if it is not valid URI encoding

	}

	return name;

}

/**
 * Turns a list of File objects into an asset map keyed by lower-case file name
 * (for OBJ/MTL lookups). `map.all` lists every file with its relative path,
 * since USD packages reuse names like "albedo.png" in different folders.
 * ZIP archives are expanded (USDZ files are kept as-is, they are read by the USD loader).
 */
export async function filesToAssets( files ) {

	const assets = new Map();
	assets.all = [];

	const add = ( path, blob, size ) => {

		const name = baseName( path );
		const entry = { name, path: path.replace( /^\/+/, '' ), blob, size };
		assets.set( name.toLowerCase(), entry );
		assets.all.push( entry );

	};

	for ( const file of files ) {

		const ext = extensionOf( file.name );
		const path = file.relativePath || file.webkitRelativePath || file.name;

		if ( ext === 'zip' ) {

			// Index the archive, then unpack each file only when it is used:
			// USD packages can be hundreds of MB and a scene rarely needs every file.
			const zip = new Uint8Array( await file.arrayBuffer() );
			const listed = [];
			unzipSync( zip, { filter: ( f ) => {

				listed.push( f );
				return false;

			} } );

			for ( const f of listed ) {

				if ( f.name.endsWith( '/' ) || f.name.startsWith( '__MACOSX/' ) ) continue;
				if ( baseName( f.name ).startsWith( '.' ) ) continue;
				let blob = null;
				const entry = { name: baseName( f.name ), path: f.name, size: f.originalSize };
				Object.defineProperty( entry, 'blob', {
					get() {

						blob ||= new Blob( [ unzipSync( zip, { filter: ( x ) => x.name === f.name } )[ f.name ] ] );
						return blob;

					},
				} );
				assets.set( entry.name.toLowerCase(), entry );
				assets.all.push( entry );

			}

		} else {

			add( path, file, file.size );

		}

	}

	return assets;

}
