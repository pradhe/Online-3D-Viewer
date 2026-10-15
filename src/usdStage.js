import * as THREE from 'three';
import { USDAParser } from 'three/addons/loaders/usd/USDAParser.js';
import { USDCParser } from 'three/addons/loaders/usd/USDCParser.js';
import { USDComposer } from 'three/addons/loaders/usd/USDComposer.js';
import { unzipSync } from 'three/addons/libs/fflate.module.js';
import './usdFixes.js';

/**
 * Loads a USD stage that spans several files (references, payloads,
 * sublayers, textures) — the way NVIDIA Omniverse and most pipelines ship
 * assets. Files come from a local bundle (folder / zip / multi-select) or are
 * fetched next to a URL.
 *
 * Paths are handled as URLs: local bundles live under `file:///bundle/`, so
 * "../Props/chair.usd" resolves with the standard URL rules.
 */

export const BUNDLE_ROOT = 'file:///bundle/';
const USD_EXT = /\.(usd|usda|usdc|usdz)$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|avif|bmp|gif|tga|tiff?|exr|hdr)$/i;
const MAX_LAYERS = 2000;

// ============================================================================ paths

/** Canonical form of a path the composer builds (it concatenates "base/" + "../x.usd"). */
export function canonical( key ) {

	let s = String( key ).replace( /\\/g, '/' );

	// "file:///bundle/stage/omniverse://host/x.usd" → the absolute URL that was appended.
	const inner = s.match( /\/([a-z][a-z0-9+.-]*:\/\/.*)$/i );
	if ( inner ) s = inner[ 1 ];

	try {

		return decodeURI( new URL( s ).href );

	} catch {

		try {

			return decodeURI( new URL( s, BUNDLE_ROOT ).href );

		} catch {

			return s;

		}

	}

}

export function dirOf( key ) {

	return key.slice( 0, key.lastIndexOf( '/' ) );

}

function resolve( fromKey, assetPath ) {

	const clean = cleanAsset( assetPath );
	if ( /^[a-z][a-z0-9+.-]*:\/\//i.test( clean ) ) return canonical( clean );
	return canonical( new URL( clean, dirOf( fromKey ) + '/' ).href );

}

function cleanAsset( v ) {

	return String( v ).trim().replace( /^@+|@+$/g, '' ).replace( /<[^>]*>$/, '' ).replace( /^\.\//, '' );

}

function segments( key ) {

	return key.replace( /^[a-z][a-z0-9+.-]*:\/\/[^/]*\/?/i, '' ).toLowerCase().split( '/' ).filter( Boolean );

}

/**
 * Finds a key by the longest matching tail of path segments, for absolute
 * links (omniverse://host/NVIDIA/Assets/x.usd) or files picked without their folders.
 */
export function suffixMatch( keys, wanted ) {

	const want = segments( wanted );
	let best = null;
	let bestScore = 0;
	let tie = false;

	for ( const key of keys ) {

		const have = segments( key );
		let score = 0;
		while ( score < want.length && score < have.length && want[ want.length - 1 - score ] === have[ have.length - 1 - score ] ) score ++;

		if ( score > bestScore ) {

			best = key;
			bestScore = score;
			tie = false;

		} else if ( score === bestScore && score > 0 ) {

			tie = true;

		}

	}

	// A bare file-name match must be unique to count.
	if ( ! best || ( bestScore === 1 && tie ) ) return null;
	return best;

}

// ============================================================================ parsing

function isCrate( bytes ) {

	const magic = 'PXR-USDC';
	for ( let i = 0; i < magic.length; i ++ ) if ( bytes[ i ] !== magic.charCodeAt( i ) ) return false;
	return true;

}

function toArrayBuffer( bytes ) {

	return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.buffer.slice( bytes.byteOffset, bytes.byteOffset + bytes.byteLength );

}

/** Parses one USD layer to the composer's { specsByPath } form, plus its sublayer list. */
function parseLayer( bytes ) {

	if ( isCrate( bytes ) ) {

		const data = new USDCParser().parseData( toArrayBuffer( bytes ) );
		const root = data.specsByPath[ '/' ]?.fields || {};
		return { data, subLayers: ( root.subLayers || [] ).map( String ) };

	}

	const text = new TextDecoder().decode( bytes );
	const data = new USDAParser().parseData( text );
	// The text parser drops the header's subLayers; read them directly.
	const header = text.slice( 0, 20000 ).match( /^#usda[^\n]*\n\s*\(([\s\S]*?)\n\)/ );
	const list = header?.[ 1 ].match( /subLayers\s*=\s*\[([\s\S]*?)\]/ );
	const subLayers = list ? [ ...list[ 1 ].matchAll( /@([^@]+)@/g ) ].map( ( m ) => m[ 1 ] ) : [];
	return { data, subLayers };

}

/** Asset paths a layer depends on: references, payloads and texture/asset attribute values. */
function dependencies( data ) {

	const refs = new Set();
	const files = new Set();

	const scan = ( value, sink ) => {

		if ( ! value ) return;
		if ( Array.isArray( value ) ) return value.forEach( ( v ) => scan( v, sink ) );
		if ( typeof value === 'object' ) {

			if ( value.assetPath ) sink.add( value.assetPath );
			return;

		}

		if ( typeof value !== 'string' ) return;
		const matches = [ ...value.matchAll( /@([^@]+)@/g ) ];
		if ( matches.length ) matches.forEach( ( m ) => sink.add( m[ 1 ] ) );
		else sink.add( value );

	};

	for ( const spec of Object.values( data.specsByPath ) ) {

		const f = spec.fields || {};
		scan( f.references, refs );
		scan( f.payload, refs );

		const value = f.default;
		if ( typeof value === 'string' && ( IMAGE_EXT.test( cleanAsset( value ) ) || USD_EXT.test( cleanAsset( value ) ) ) ) files.add( cleanAsset( value ) );

	}

	return {
		layers: [ ...refs ].map( cleanAsset ).filter( ( p ) => USD_EXT.test( p ) ),
		files: [ ...files ],
	};

}

/** Merges a weaker layer's specs into a stronger one (sublayer composition). */
function mergeWeaker( strong, weak ) {

	for ( const [ path, spec ] of Object.entries( weak.specsByPath ) ) {

		const s = strong.specsByPath[ path ];

		if ( ! s ) {

			strong.specsByPath[ path ] = spec;
			continue;

		}

		for ( const [ k, v ] of Object.entries( spec.fields || {} ) ) {

			if ( k === 'primChildren' || k === 'properties' ) {

				s.fields[ k ] = [ ...new Set( [ ...( s.fields[ k ] || [] ), ...( v || [] ) ] ) ];

			} else if ( s.fields[ k ] === undefined || s.fields[ k ] === '' ) {

				s.fields[ k ] = v;

			}

		}

	}

}

// ============================================================================ loading

/**
 * @param {object} options
 * @param {string} options.rootKey   canonical key of the root layer
 * @param {Uint8Array} options.rootBytes
 * @param {(key: string, assetPath: string) => Promise<{ key: string, bytes: Uint8Array } | null>} options.fetchFile
 * @param {THREE.LoadingManager} options.manager
 * @param {(text: string) => void} [options.onProgress]
 */
export async function loadUsdStage( { rootKey, rootBytes, fetchFile, manager, onProgress } ) {

	const layers = new Map(); // key -> { data, subLayers }
	const assets = {}; // key -> parsed data | image bytes (what the composer reads)
	const missing = new Set();
	const pending = new Map(); // key -> promise

	const addPackage = ( key, bytes ) => {

		// USDZ: expose entries as if extracted next to the package; return the root layer key.
		const entries = unzipSync( bytes );
		const dir = dirOf( key );
		let root = null;

		for ( const [ name, data ] of Object.entries( entries ) ) {

			const entryKey = canonical( `${ dir }/${ name }` );
			if ( USD_EXT.test( name ) ) {

				if ( ! root ) root = entryKey;
				layers.set( entryKey, parseLayer( data ) );

			} else {

				assets[ entryKey ] = data;

			}

		}

		if ( root ) layers.set( key, layers.get( root ) );
		return root;

	};

	const load = ( key, bytes ) => {

		if ( bytes[ 0 ] === 0x50 && bytes[ 1 ] === 0x4B ) addPackage( key, bytes );
		else layers.set( key, parseLayer( bytes ) );

	};

	const want = ( fromKey, assetPath, isLayer ) => {

		const key = resolve( fromKey, assetPath );
		if ( layers.has( key ) || key in assets || pending.has( key ) ) return pending.get( key );
		if ( layers.size + pending.size > MAX_LAYERS ) return null;

		const job = ( async () => {

			const found = await fetchFile( key, assetPath ).catch( () => null );

			if ( ! found ) {

				missing.add( key.replace( BUNDLE_ROOT, '' ) );
				return;

			}

			if ( isLayer ) {

				load( key, found.bytes );
				if ( found.key !== key ) layers.set( found.key, layers.get( key ) );
				await visit( key );

			} else {

				assets[ key ] = found.bytes;

			}

		} )();

		pending.set( key, job );
		return job;

	};

	const visited = new Set();

	const visit = async ( key ) => {

		if ( visited.has( key ) ) return;
		visited.add( key );
		const layer = layers.get( key );
		if ( ! layer ) return;
		onProgress?.( `Loading layers… ${ visited.size }` );

		const deps = dependencies( layer.data );
		await Promise.all( [
			...layer.subLayers.map( ( p ) => want( key, p, true ) ),
			...deps.layers.map( ( p ) => want( key, p, true ) ),
			...deps.files.map( ( p ) => want( key, p, USD_EXT.test( p ) ) ),
		] );

	};

	load( rootKey, rootBytes );
	await visit( rootKey );

	// Sublayers: fold each layer's sublayers into it, weakest last (recursively).
	const merged = new Set();
	const mergeInto = ( key, stack = new Set() ) => {

		if ( merged.has( key ) || stack.has( key ) ) return;
		stack.add( key );
		const layer = layers.get( key );
		if ( ! layer ) return;

		for ( const sub of layer.subLayers ) {

			const subKey = resolve( key, sub );
			const subLayer = layers.get( subKey );
			if ( ! subLayer ) continue;
			mergeInto( subKey, stack );
			mergeWeaker( layer.data, subLayer.data );

		}

		merged.add( key );

	};

	for ( const key of layers.keys() ) mergeInto( key );
	for ( const [ key, layer ] of layers ) assets[ key ] = layer.data;

	onProgress?.( 'Building scene…' );
	await new Promise( ( r ) => setTimeout( r, 0 ) );

	const composer = new USDComposer( manager );
	const resolverAssets = makeResolver( assets );
	const textures = [];
	textureSink = textures;
	let group;

	try {

		group = composer.compose( layers.get( rootKey ).data, resolverAssets, {}, dirOf( rootKey ) );

	} finally {

		textureSink = null;

	}

	// Referenced layers are composed by nested composers; wait for their textures too.
	onProgress?.( `Loading textures… (${ textures.length })` );
	await Promise.allSettled( textures );

	return {
		group,
		missing: [ ...missing ],
		layerCount: new Set( [ ...layers.values() ] ).size,
	};

}

/** Lets the composer find files however it spells their paths. */
function makeResolver( assets ) {

	const keys = Object.keys( assets );
	const cache = new Map();

	return new Proxy( assets, {

		get( target, prop ) {

			if ( typeof prop !== 'string' ) return target[ prop ];
			if ( prop in target ) return target[ prop ];
			if ( prop === REF_CACHE ) return cache;
			if ( cache.has( 'k:' + prop ) ) return target[ cache.get( 'k:' + prop ) ];

			let key = canonical( prop );
			if ( ! ( key in target ) ) key = suffixMatch( keys, key );
			cache.set( 'k:' + prop, key );
			return key ? target[ key ] : undefined;

		},

	} );

}

// ============================================================================ composer additions

const REF_CACHE = '__mycityRefCache';
const composerProto = USDComposer.prototype;

// Collects texture loads from every composer (including nested ones for references).
let textureSink = null;
const createTextureFromData = composerProto._createTextureFromData;

composerProto._createTextureFromData = function ( ...args ) {

	const before = this.texturePromises.length;
	const texture = createTextureFromData.apply( this, args );
	if ( textureSink ) textureSink.push( ...this.texturePromises.slice( before ) );
	return texture;

};

// Scenes reference the same asset many times (chairs, crates, bolts). Compose
// each (file, prim, variants) once and clone it: clones share geometry and materials.
const resolveReference = composerProto._resolveReference;

composerProto._resolveReference = function ( refValue, localVariants = {} ) {

	const cache = this.assets?.[ REF_CACHE ];
	if ( ! cache ) return resolveReference.call( this, refValue, localVariants );

	const key = `${ this.basePath }|${ refValue }|${ JSON.stringify( { ...localVariants, ...this.externalVariantSelections } ) }`;

	if ( ! cache.has( key ) ) {

		const group = resolveReference.call( this, refValue, localVariants );
		cache.set( key, group );

	}

	const master = cache.get( key );
	return master ? master.clone( true ) : null;

};

// Point instancers: build InstancedMeshes from prototypes + per-instance transforms.
const compose = composerProto.compose;

composerProto.compose = function ( data, ...rest ) {

	// Text and binary layers store quaternions in a different component order.
	this.isTextLayer = !! data?.isText;
	const group = compose.call( this, data, ...rest );

	try {

		buildPointInstancers( this, group );

	} catch ( e ) {

		console.warn( 'Could not build point instancers:', e );

	}

	return group;

};

function findByPath( root, path ) {

	let obj = root;
	for ( const name of path.split( '/' ).filter( Boolean ) ) {

		obj = obj?.children.find( ( c ) => c.name === name );
		if ( ! obj ) return null;

	}

	return obj;

}

function targetsOf( spec ) {

	const t = spec?.fields?.targetPaths;
	if ( ! t ) return [];
	return ( Array.isArray( t ) ? t : [ t ] ).flatMap( ( s ) => String( s ).replace( /[\[\]<>]/g, '' ).split( ',' ) ).map( ( s ) => s.trim() ).filter( Boolean );

}

function flat( v ) {

	if ( ! v ) return [];
	if ( ArrayBuffer.isView( v ) ) return Array.from( v );
	if ( Array.isArray( v ) ) return v.flat( Infinity ).map( Number );
	return [];

}

function buildPointInstancers( composer, group ) {

	const specs = composer.specsByPath;
	const instancers = Object.entries( specs ).filter( ( [ , s ] ) => s.fields?.typeName === 'PointInstancer' ).map( ( [ p ] ) => p );
	if ( ! instancers.length ) return;

	group.updateMatrixWorld( true );
	const pos = new THREE.Vector3();
	const quat = new THREE.Quaternion();
	const scl = new THREE.Vector3();
	const m = new THREE.Matrix4();
	const rel = new THREE.Matrix4();
	const inv = new THREE.Matrix4();
	const isText = composer.isTextLayer;

	for ( const path of instancers ) {

		const instancer = findByPath( group, path );
		if ( ! instancer ) continue;

		const attrs = composer._getAttributes( path );
		const protoPaths = targetsOf( specs[ `${ path }.prototypes` ] );
		const indices = flat( attrs.protoIndices );
		const positions = flat( attrs.positions );
		const orientations = flat( attrs.orientations || attrs.orientationsf );
		const scales = flat( attrs.scales );
		const hidden = new Set( flat( attrs.invisibleIds ) );
		const count = indices.length;
		if ( ! count || ! protoPaths.length ) continue;

		const instanceMatrix = ( i ) => {

			pos.set( positions[ i * 3 ] || 0, positions[ i * 3 + 1 ] || 0, positions[ i * 3 + 2 ] || 0 );
			if ( orientations.length >= ( i + 1 ) * 4 ) {

				// Text layers write quaternions as (real, i, j, k); binary layers store (i, j, k, real).
				const o = orientations.slice( i * 4, i * 4 + 4 );
				if ( isText ) quat.set( o[ 1 ], o[ 2 ], o[ 3 ], o[ 0 ] );
				else quat.set( o[ 0 ], o[ 1 ], o[ 2 ], o[ 3 ] );
				quat.normalize();

			} else quat.identity();

			if ( scales.length >= ( i + 1 ) * 3 ) scl.set( scales[ i * 3 ], scales[ i * 3 + 1 ], scales[ i * 3 + 2 ] );
			else scl.set( 1, 1, 1 );
			return m.compose( pos, quat, scl );

		};

		const consumed = [];

		protoPaths.forEach( ( protoPath, protoIndex ) => {

			const proto = findByPath( group, protoPath );
			if ( ! proto ) return;
			consumed.push( proto );

			const instances = [];
			for ( let i = 0; i < count; i ++ ) if ( indices[ i ] === protoIndex && ! hidden.has( i ) ) instances.push( i );
			if ( ! instances.length ) return;

			// Each piece relative to the prototype's parent: the prototype's own transform is
			// part of every instance, the transforms above it (e.g. a "Prototypes" scope) are not.
			inv.copy( proto.parent ? proto.parent.matrixWorld : new THREE.Matrix4() ).invert();
			proto.updateMatrixWorld( true );

			proto.traverse( ( mesh ) => {

				if ( ! mesh.isMesh ) return;
				rel.multiplyMatrices( inv, mesh.matrixWorld );

				const im = new THREE.InstancedMesh( mesh.geometry, mesh.material, instances.length );
				im.name = `${ proto.name }${ mesh === proto ? '' : '/' + mesh.name } ×${ instances.length }`;
				instances.forEach( ( i, j ) => im.setMatrixAt( j, instanceMatrix( i ).clone().multiply( rel ) ) );
				im.instanceMatrix.needsUpdate = true;
				im.computeBoundingBox();
				im.computeBoundingSphere();
				instancer.add( im );

			} );

		} );

		// USD never draws prototypes that live under their instancer on their own.
		for ( const proto of consumed ) {

			let inside = false;
			for ( let p = proto.parent; p; p = p.parent ) if ( p === instancer ) inside = true;
			if ( inside ) proto.parent.remove( proto );

		}

	}

}

const parseData = USDAParser.prototype.parseData;
USDAParser.prototype.parseData = function ( text ) {

	const data = parseData.call( this, text );
	data.isText = true;
	return data;

};
