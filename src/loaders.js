import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { USDLoader } from 'three/addons/loaders/USDLoader.js';
import { unzipSync } from 'three/addons/libs/fflate.module.js';

export const USD_EXTENSIONS = [ 'usd', 'usda', 'usdc', 'usdz' ];
export const MODEL_EXTENSIONS = [ 'obj', ...USD_EXTENSIONS ];
export const ACCEPT = [ ...MODEL_EXTENSIONS, 'mtl', 'zip', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'tga', 'gif' ]
	.map( ( e ) => '.' + e ).join( ',' );

export function extensionOf( name ) {

	const clean = name.split( /[?#]/ )[ 0 ];
	const base = baseName( clean );
	const dot = base.lastIndexOf( '.' );
	return dot < 0 ? '' : base.slice( dot + 1 ).toLowerCase();

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
 * Turns a list of File objects into a flat asset map keyed by lower-case file name.
 * ZIP archives are expanded (USDZ files are kept as-is, they are read by the USD loader).
 */
export async function filesToAssets( files ) {

	const assets = new Map();

	for ( const file of files ) {

		const ext = extensionOf( file.name );

		if ( ext === 'zip' ) {

			const entries = unzipSync( new Uint8Array( await file.arrayBuffer() ) );

			for ( const [ path, bytes ] of Object.entries( entries ) ) {

				if ( path.endsWith( '/' ) || path.startsWith( '__MACOSX/' ) ) continue;
				const name = baseName( path );
				if ( name.startsWith( '.' ) ) continue;
				assets.set( name.toLowerCase(), { name, blob: new Blob( [ bytes ] ), size: bytes.byteLength } );

			}

		} else {

			assets.set( file.name.toLowerCase(), { name: file.name, blob: file, size: file.size } );

		}

	}

	return assets;

}

/** Picks the model file to open from an asset map. USD is preferred over OBJ. */
export function findMainAsset( assets ) {

	const rank = { usdz: 0, usd: 1, usda: 1, usdc: 1, obj: 2 };
	let best = null;

	for ( const asset of assets.values() ) {

		const r = rank[ extensionOf( asset.name ) ];
		if ( r === undefined ) continue;
		if ( ! best || r < best.rank ) best = { asset, rank: r };

	}

	return best ? best.asset : null;

}

/**
 * A LoadingManager that knows when every item it started has finished,
 * so we can wait for textures that loaders fetch in the background.
 */
function createTrackingManager() {

	const manager = new THREE.LoadingManager();
	let pending = 0;
	let waiters = [];
	const failed = new Set();

	const start = manager.itemStart.bind( manager );
	const end = manager.itemEnd.bind( manager );
	const error = manager.itemError.bind( manager );

	manager.itemStart = ( url ) => {

		pending ++;
		start( url );

	};

	manager.itemEnd = ( url ) => {

		end( url );
		pending = Math.max( 0, pending - 1 );
		if ( pending === 0 ) {

			waiters.forEach( ( w ) => w() );
			waiters = [];

		}

	};

	manager.itemError = ( url ) => {

		failed.add( url );
		error( url );

	};

	manager.idle = () => new Promise( ( resolve ) => {

		// Give loaders a tick to register their items before checking.
		setTimeout( () => {

			if ( pending === 0 ) resolve();
			else waiters.push( resolve );

		}, 0 );

	} );

	manager.failed = failed;
	return manager;

}

/** Removes texture maps whose images never arrived so the model does not render black. */
function stripBrokenTextures( object ) {

	const keys = [ 'map', 'normalMap', 'bumpMap', 'specularMap', 'emissiveMap', 'alphaMap', 'aoMap', 'roughnessMap', 'metalnessMap', 'displacementMap', 'lightMap' ];

	object.traverse( ( child ) => {

		if ( ! child.material ) return;
		const materials = Array.isArray( child.material ) ? child.material : [ child.material ];

		for ( const material of materials ) {

			for ( const key of keys ) {

				const tex = material[ key ];
				if ( tex && tex.isTexture && ! tex.image ) {

					material[ key ] = null;
					material.needsUpdate = true;

				}

			}

		}

	} );

}

/**
 * OBJ has no per-object transforms, so every part sits at the file origin.
 * Move each mesh's origin to its own center (the geometry stays where it is)
 * so selection, focus and the transform gizmo work per part.
 */
function centerMeshPivots( object ) {

	const center = new THREE.Vector3();

	object.traverse( ( child ) => {

		if ( ! child.isMesh || ! child.geometry.attributes.position ) return;
		child.geometry.computeBoundingBox();
		child.geometry.boundingBox.getCenter( center );
		if ( center.lengthSq() === 0 ) return;
		child.geometry.translate( - center.x, - center.y, - center.z );
		child.position.add( center );

	} );

}

function parseMtllibNames( objText ) {

	const names = [];
	const re = /^\s*mtllib\s+(.+?)\s*$/gm;
	let m;
	while ( ( m = re.exec( objText ) ) !== null ) names.push( m[ 1 ].trim() );
	return names;

}

async function buildOBJ( objText, getMtlText, manager, resourcePath ) {

	const warnings = [];
	const loader = new OBJLoader( manager );
	const mtlLoader = new MTLLoader( manager );
	mtlLoader.setResourcePath( resourcePath );

	const mtlTexts = await getMtlText( parseMtllibNames( objText ), warnings );

	if ( mtlTexts.length ) {

		// Merge all material libraries into one creator.
		const creator = mtlLoader.parse( mtlTexts.join( '\n' ), resourcePath );
		creator.preload();
		loader.setMaterials( creator );

	}

	const object = loader.parse( objText );
	centerMeshPivots( object );
	await manager.idle();
	stripBrokenTextures( object );

	return { object, warnings };

}

/** Loads a model from local files (picked or dropped). */
export async function loadFromFiles( fileList ) {

	const assets = await filesToAssets( fileList );
	const main = findMainAsset( assets );

	if ( ! main ) {

		throw new Error( 'No supported model found. Open an .obj, .usd, .usda, .usdc or .usdz file (or a .zip containing one).' );

	}

	const urls = new Map();
	const missing = new Set();
	const urlFor = ( asset ) => {

		if ( ! urls.has( asset.name ) ) urls.set( asset.name, URL.createObjectURL( asset.blob ) );
		return urls.get( asset.name );

	};

	const manager = createTrackingManager();
	manager.setURLModifier( ( url ) => {

		if ( /^(blob|data):/.test( url ) ) return url;
		const asset = assets.get( baseName( url ).toLowerCase() );
		if ( asset ) return urlFor( asset );
		missing.add( baseName( url ) );
		// An empty image so the request fails quietly instead of hitting the server.
		return 'data:,';

	} );

	const ext = extensionOf( main.name );
	let result;

	try {

		if ( ext === 'obj' ) {

			const text = await main.blob.text();
			result = await buildOBJ( text, async ( names, warnings ) => {

				const mtlAssets = [ ...assets.values() ].filter( ( a ) => extensionOf( a.name ) === 'mtl' );
				const chosen = [];

				for ( const name of names ) {

					const found = assets.get( baseName( name ).toLowerCase() );
					if ( found ) chosen.push( found );

				}

				// The OBJ may reference a library under another name (renamed on download).
				if ( chosen.length < names.length ) {

					for ( const a of mtlAssets ) if ( ! chosen.includes( a ) ) chosen.push( a );
					if ( ! chosen.length ) warnings.push( `Material library not provided (${ names.join( ', ' ) }). Add the .mtl file to see colors.` );

				}

				if ( ! names.length ) chosen.push( ...mtlAssets );
				return Promise.all( chosen.map( ( a ) => a.blob.text() ) );

			}, manager, '' );

		} else {

			const buffer = await main.blob.arrayBuffer();
			const object = await parseUSD( buffer, manager );
			await manager.idle();
			stripBrokenTextures( object );
			result = { object, warnings: [] };

		}

	} finally {

		urls.forEach( ( u ) => URL.revokeObjectURL( u ) );

	}

	if ( missing.size ) {

		result.warnings.push( `Missing files: ${ [ ...missing ].join( ', ' ) }. Select them together with the model (or use a .zip).` );

	}

	return {
		object: result.object,
		name: main.name,
		format: ext,
		size: main.size,
		warnings: result.warnings,
	};

}

function parseUSD( buffer, manager ) {

	return new Promise( ( resolve, reject ) => {

		try {

			new USDLoader( manager ).parse( buffer, '', resolve, reject );

		} catch ( e ) {

			reject( e );

		}

	} );

}

/** Loads a model from a URL (same-origin or CORS-enabled). */
export async function loadFromURL( url ) {

	const absolute = new URL( url, window.location.href ).href;
	const ext = extensionOf( absolute );

	if ( ! MODEL_EXTENSIONS.includes( ext ) ) {

		throw new Error( `Unsupported file type ".${ ext }". Use .obj, .usd, .usda, .usdc or .usdz.` );

	}

	const response = await fetch( absolute );
	if ( ! response.ok ) throw new Error( `Download failed (${ response.status } ${ response.statusText })` );

	const buffer = await response.arrayBuffer();
	const resourcePath = THREE.LoaderUtils.extractUrlBase( absolute );
	const manager = createTrackingManager();
	let result;

	if ( ext === 'obj' ) {

		const text = new TextDecoder().decode( buffer );
		result = await buildOBJ( text, async ( names, warnings ) => {

			const texts = [];

			for ( const name of names ) {

				const res = await fetch( new URL( name, resourcePath ) ).catch( () => null );
				if ( res && res.ok ) texts.push( await res.text() );
				else warnings.push( `Could not load material library ${ name }.` );

			}

			return texts;

		}, manager, resourcePath );

	} else {

		const object = await new Promise( ( resolve, reject ) => {

			try {

				new USDLoader( manager ).parse( buffer, resourcePath, resolve, reject );

			} catch ( e ) {

				reject( e );

			}

		} );

		await manager.idle();
		stripBrokenTextures( object );
		result = { object, warnings: [] };

	}

	if ( manager.failed.size ) {

		result.warnings.push( `Some files failed to load: ${ [ ...manager.failed ].map( baseName ).join( ', ' ) }` );

	}

	return {
		object: result.object,
		name: baseName( absolute ),
		format: ext,
		size: buffer.byteLength,
		warnings: result.warnings,
	};

}
