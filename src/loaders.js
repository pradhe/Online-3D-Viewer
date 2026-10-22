import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import './usdFixes.js';
import { gunzipSync } from 'three/addons/libs/fflate.module.js';
import { USD_EXTENSIONS, MODEL_EXTENSIONS, baseName, extensionOf, filesToAssets, isGzipped } from './assets.js';
import { ViewerError, assertHasGeometry } from './errors.js';
import { loadUsdScene } from './workerClient.js';

export * from './assets.js';

/**
 * USD packages hold many .usd files (the scene plus the assets it references).
 * The scene is normally the one nearest the top of the folder.
 */
export function usdRootCandidates( assets ) {

	const usd = assets.all.filter( ( a ) => USD_EXTENSIONS.includes( extensionOf( a.name ) ) );
	if ( ! usd.length ) return [];
	const depth = ( a ) => a.path.split( '/' ).length;
	const min = Math.min( ...usd.map( depth ) );
	return usd.filter( ( a ) => depth( a ) === min ).sort( ( a, b ) => b.size - a.size );

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

/**
 * MTL files describe old Phong materials, which ignore image-based lighting.
 * Convert them to physically based materials so OBJ models are lit like USD ones.
 */
function usePhysicalMaterials( object ) {

	const converted = new Map();
	const convert = ( m ) => {

		if ( ! m.isMeshPhongMaterial && ! m.isMeshLambertMaterial ) return m;
		if ( converted.has( m ) ) return converted.get( m );
		const shininess = m.shininess ?? 30;
		const std = new THREE.MeshStandardMaterial( {
			name: m.name,
			color: m.color.clone(),
			map: m.map,
			normalMap: m.normalMap,
			bumpMap: m.bumpMap,
			bumpScale: m.bumpScale,
			alphaMap: m.alphaMap,
			emissive: m.emissive ? m.emissive.clone() : new THREE.Color( 0 ),
			emissiveMap: m.emissiveMap,
			opacity: m.opacity,
			transparent: m.transparent,
			side: m.side,
			vertexColors: m.vertexColors,
			flatShading: m.flatShading,
			// Blinn-Phong exponent → GGX roughness.
			roughness: THREE.MathUtils.clamp( Math.sqrt( 2 / ( shininess + 2 ) ), 0.05, 1 ),
			metalness: 0,
		} );
		converted.set( m, std );
		return std;

	};

	object.traverse( ( o ) => {

		if ( o.isMesh ) o.material = Array.isArray( o.material ) ? o.material.map( convert ) : convert( o.material );

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
	usePhysicalMaterials( object );
	await manager.idle();
	stripBrokenTextures( object );

	return { object, warnings };

}

/** Loads a model from local files (picked or dropped). */
export async function loadFromFiles( fileList, { chooseRoot, onProgress, signal } = {} ) {

	const assets = await filesToAssets( fileList );
	let main = findMainAsset( assets );

	if ( main && USD_EXTENSIONS.includes( extensionOf( main.name ) ) ) {

		const candidates = usdRootCandidates( assets );
		main = candidates.length > 1 && chooseRoot ? await chooseRoot( candidates ) : candidates[ 0 ] || main;
		if ( ! main ) throw new ViewerError( 'No file was chosen.' );

	}


	if ( ! main ) {

		throw new ViewerError( 'No supported model found.', 'Open an .obj, .usd, .usda, .usdc or .usdz file (or a .zip containing one).' );

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

			const loaded = await loadUsdScene( {
				kind: 'files',
				files: [ ...fileList ].map( ( file ) => ( { file, path: file.relativePath || file.webkitRelativePath || file.name } ) ),
				rootPath: main.path,
			}, { onProgress, signal } );

			result = { object: loaded.object, warnings: usdWarnings( loaded ), usd: loaded.usd, layers: loaded.layerCount, missing: loaded.missing };

		}

	} finally {

		urls.forEach( ( u ) => URL.revokeObjectURL( u ) );

	}

	if ( missing.size ) {

		result.warnings.push( `Missing files: ${ [ ...missing ].join( ', ' ) }. Select them together with the model (or use a .zip).` );

	}

	assertHasGeometry( result.object, { format: ext, missing: result.missing } );

	return {
		object: result.object,
		name: main.name,
		format: ext,
		size: main.size,
		warnings: result.warnings,
		usd: result.usd || null,
		layers: result.layers || 0,
		missing: result.missing || [],
	};

}

function usdWarnings( stage ) {

	if ( ! stage.missing.length ) return [];
	const list = stage.missing.slice( 0, 6 ).join( ', ' ) + ( stage.missing.length > 6 ? ` and ${ stage.missing.length - 6 } more` : '' );
	return [ `${ stage.missing.length } linked file${ stage.missing.length === 1 ? ' was' : 's were' } not found: ${ list }. The full list is in Model info. Open the whole folder (or a .zip of it) so referenced files load too.` ];

}

/** Downloads a file, reporting "n of m MB" while it arrives. */
async function downloadWithProgress( url, { signal, onProgress, label } ) {

	const response = await fetch( url, { signal } );

	if ( ! response.ok ) {

		throw new ViewerError( `Download failed (${ response.status }${ response.statusText ? ' ' + response.statusText : '' }).`, response.status === 404 ? 'Check the address.' : '' );

	}

	const total = Number( response.headers.get( 'content-length' ) ) || 0;
	if ( ! response.body || ! onProgress ) return response.arrayBuffer();

	const mb = ( n ) => ( n / 1048576 ).toFixed( 1 );
	const chunks = [];
	let received = 0;
	const reader = response.body.getReader();

	for ( ;; ) {

		const { done, value } = await reader.read();
		if ( done ) break;
		chunks.push( value );
		received += value.length;
		onProgress( total ? `Downloading ${ label }… ${ mb( received ) } of ${ mb( total ) } MB` : `Downloading ${ label }… ${ mb( received ) } MB` );

	}

	const bytes = new Uint8Array( received );
	let at = 0;
	for ( const c of chunks ) {

		bytes.set( c, at );
		at += c.length;

	}

	return bytes.buffer;

}

/** Loads a model from a URL (same-origin or CORS-enabled). */
export async function loadFromURL( url, { onProgress, signal } = {} ) {

	const absolute = new URL( url, window.location.href ).href;
	const ext = extensionOf( absolute );

	if ( ! MODEL_EXTENSIONS.includes( ext ) ) {

		throw new ViewerError( `Unsupported file type ".${ ext }".`, 'Use .obj, .usd, .usda, .usdc or .usdz.' );

	}

	if ( ext !== 'obj' ) {

		if ( isGzipped( absolute ) ) throw new ViewerError( 'Compressed USD (.gz) is not supported.', 'Open the .usd/.usdc file itself, or a .usdz package.' );

		const loaded = await loadUsdScene( { kind: 'url', url: absolute }, { onProgress, signal } );
		assertHasGeometry( loaded.object, { format: ext, missing: loaded.missing } );

		return {
			object: loaded.object,
			name: baseName( absolute ),
			format: ext,
			size: loaded.size,
			warnings: usdWarnings( loaded ),
			usd: loaded.usd || null,
			layers: loaded.layerCount || 0,
			missing: loaded.missing || [],
		};

	}

	const name = baseName( absolute ).replace( /\.gz$/i, '' );
	let buffer = await downloadWithProgress( absolute, { signal, onProgress, label: baseName( absolute ) } );

	// A server may already have undone the compression (Content-Encoding: gzip), so check the header.
	const head = new Uint8Array( buffer, 0, 2 );

	if ( isGzipped( absolute ) && head[ 0 ] === 0x1f && head[ 1 ] === 0x8b ) {

		onProgress?.( 'Unpacking…' );
		const unpacked = gunzipSync( new Uint8Array( buffer ) );
		buffer = unpacked.buffer.slice( unpacked.byteOffset, unpacked.byteOffset + unpacked.byteLength );

	}

	const resourcePath = THREE.LoaderUtils.extractUrlBase( absolute );
	const manager = createTrackingManager();

	const text = new TextDecoder().decode( buffer );
	const result = await buildOBJ( text, async ( names, warnings ) => {

		const texts = [];

		for ( const name of names ) {

			const res = await fetch( new URL( name, resourcePath ) ).catch( () => null );
			if ( res && res.ok ) texts.push( await res.text() );
			else warnings.push( `Could not load material library ${ name }.` );

		}

		return texts;

	}, manager, resourcePath );

	if ( manager.failed.size ) {

		result.warnings.push( `Some files failed to load: ${ [ ...manager.failed ].map( baseName ).join( ', ' ) }` );

	}

	assertHasGeometry( result.object, { format: ext, missing: [] } );

	return {
		object: result.object,
		name,
		format: ext,
		size: buffer.byteLength,
		warnings: result.warnings,
		usd: null,
		layers: 0,
		missing: [],
	};

}
