import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import './usdFixes.js';
import { unzipSync } from 'three/addons/libs/fflate.module.js';
import { extractUsdMetadata } from './usdMetadata.js';
import { loadUsdStage, canonical, suffixMatch, BUNDLE_ROOT } from './usdStage.js';

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
export async function loadFromFiles( fileList, { chooseRoot, onProgress } = {} ) {

	const assets = await filesToAssets( fileList );
	let main = findMainAsset( assets );

	if ( main && USD_EXTENSIONS.includes( extensionOf( main.name ) ) ) {

		const candidates = usdRootCandidates( assets );
		main = candidates.length > 1 && chooseRoot ? await chooseRoot( candidates ) : candidates[ 0 ] || main;
		if ( ! main ) throw new Error( 'No file was chosen.' );

	}


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
			const byKey = new Map( assets.all.map( ( a ) => [ canonical( BUNDLE_ROOT + a.path ), a ] ) );
			const keys = [ ...byKey.keys() ];
			const stage = await loadUsdStage( {
				rootKey: canonical( BUNDLE_ROOT + main.path ),
				rootBytes: new Uint8Array( buffer ),
				manager,
				onProgress,
				fetchFile: async ( key ) => {

					const found = byKey.has( key ) ? key : suffixMatch( keys, key );
					if ( found ) return { key: found, bytes: new Uint8Array( await byKey.get( found ).blob.arrayBuffer() ) };
					// Not in the folder: NVIDIA scenes often link to NVIDIA's public asset library.
					return fetchRemote( key, onProgress );

				},
			} );
			await manager.idle();
			stripBrokenTextures( stage.group );
			result = { object: stage.group, warnings: usdWarnings( stage ), usd: readMetadata( buffer ), layers: stage.layerCount, missing: stage.missing };

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
		usd: result.usd || null,
		layers: result.layers || 0,
		missing: result.missing || [],
	};

}

/** Metadata is a bonus: a file that renders must never fail because of it. */
function readMetadata( buffer ) {

	try {

		return extractUsdMetadata( buffer );

	} catch ( e ) {

		console.warn( 'Could not read USD metadata:', e );
		return null;

	}

}

// NVIDIA's public Omniverse content (omniverse://<server>/NVIDIA/Assets/...) is mirrored here, with CORS enabled.
const NVIDIA_CONTENT = 'https://omniverse-content-production.s3-us-west-2.amazonaws.com/';
let remoteCount = 0;

/** Downloads a linked file that is not in the local bundle: web links and NVIDIA library paths. */
async function fetchRemote( key, onProgress ) {

	let url = null;
	if ( /^https?:\/\//i.test( key ) ) url = key;
	const nvidia = key.match( /^omniverse:\/\/[^/]+\/NVIDIA\/(.+)$/i );
	if ( nvidia ) url = NVIDIA_CONTENT + nvidia[ 1 ].split( '/' ).map( encodeURIComponent ).join( '/' );
	if ( ! url ) return null;

	onProgress?.( `Downloading linked assets… ${ ++ remoteCount }` );
	const res = await fetch( url ).catch( () => null );
	if ( ! res || ! res.ok ) return null;
	return { key, bytes: new Uint8Array( await res.arrayBuffer() ) };

}

function usdWarnings( stage ) {

	if ( ! stage.missing.length ) return [];
	const list = stage.missing.slice( 0, 6 ).join( ', ' ) + ( stage.missing.length > 6 ? ` and ${ stage.missing.length - 6 } more` : '' );
	return [ `${ stage.missing.length } linked file${ stage.missing.length === 1 ? ' was' : 's were' } not found: ${ list }. The full list is in Model info. Open the whole folder (or a .zip of it) so referenced files load too.` ];

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

		const stage = await loadUsdStage( {
			rootKey: canonical( absolute ),
			rootBytes: new Uint8Array( buffer ),
			manager,
			fetchFile: ( key ) => fetchRemote( key ),
		} );
		await manager.idle();
		stripBrokenTextures( stage.group );
		result = { object: stage.group, warnings: usdWarnings( stage ), usd: readMetadata( buffer ), layers: stage.layerCount, missing: stage.missing };

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
		usd: result.usd || null,
		layers: result.layers || 0,
		missing: result.missing || [],
	};

}
