import * as THREE from 'three';
import './usdFixes.js';
import { baseName, filesToAssets } from './assets.js';
import { ViewerError, checkUsdBytes } from './errors.js';
import { extractUsdMetadata } from './usdMetadata.js';
import { packScene, transferListOf } from './sceneTransfer.js';
import { BUNDLE_ROOT, canonical, loadUsdStage, setTextureFactory, suffixMatch } from './usdStage.js';

/**
 * The heavy part of opening a USD model, written so it can run in a Web Worker (no DOM access)
 * or, as a fallback, on the main thread. It reads and parses every layer, composes the scene,
 * decodes textures and returns plain data that `unpackScene` turns back into three.js objects.
 */

// NVIDIA's public Omniverse content (omniverse://<server>/NVIDIA/Assets/...) is mirrored here, with CORS enabled.
const NVIDIA_CONTENT = 'https://omniverse-content-production.s3-us-west-2.amazonaws.com/';

/** Downloads a linked file that is not in the local bundle: web links and NVIDIA library paths. */
export function makeRemoteFetcher( onProgress ) {

	let count = 0;

	return async ( key ) => {

		let url = null;
		if ( /^https?:\/\//i.test( key ) ) url = key;
		const nvidia = key.match( /^omniverse:\/\/[^/]+\/NVIDIA\/(.+)$/i );
		if ( nvidia ) url = NVIDIA_CONTENT + nvidia[ 1 ].split( '/' ).map( encodeURIComponent ).join( '/' );
		if ( ! url ) return null;

		onProgress?.( `Downloading linked assets… ${ ++ count }` );
		const res = await fetch( url ).catch( () => null );
		if ( ! res || ! res.ok ) return null;
		return { key, bytes: new Uint8Array( await res.arrayBuffer() ) };

	};

}

/** Metadata is a bonus: a file that renders must never fail because of it. */
export function readMetadata( buffer ) {

	try {

		return extractUsdMetadata( buffer );

	} catch ( e ) {

		console.warn( 'Could not read USD metadata:', e );
		return null;

	}

}

/**
 * @typedef {{ kind: 'files', files: { file: Blob, path: string }[], rootPath: string }
 *   | { kind: 'url', url: string }} UsdSpec
 */

/** Opens the root layer and returns a function that finds the files it links to. */
async function openSpec( spec, onProgress ) {

	if ( spec.kind === 'url' ) {

		const response = await fetch( spec.url );
		if ( ! response.ok ) {

			throw new ViewerError( `Download failed (${ response.status }${ response.statusText ? ' ' + response.statusText : '' }).`, response.status === 404 ? 'Check the address.' : '' );

		}

		return {
			name: baseName( spec.url ),
			rootKey: canonical( spec.url ),
			rootBytes: new Uint8Array( await response.arrayBuffer() ),
			fetchFile: makeRemoteFetcher( onProgress ),
		};

	}

	// A File loses its relativePath when posted to a worker, so it travels beside it.
	const files = spec.files.map( ( f ) => Object.assign( f.file, { relativePath: f.path } ) );
	const assets = await filesToAssets( files );
	const main = assets.all.find( ( a ) => a.path === spec.rootPath );
	if ( ! main ) throw new ViewerError( 'The chosen file is no longer available.', 'Open it again.' );

	const byKey = new Map( assets.all.map( ( a ) => [ canonical( BUNDLE_ROOT + a.path ), a ] ) );
	const keys = [ ...byKey.keys() ];
	const remote = makeRemoteFetcher( onProgress );

	return {
		name: main.name,
		rootKey: canonical( BUNDLE_ROOT + main.path ),
		rootBytes: new Uint8Array( await main.blob.arrayBuffer() ),
		fetchFile: async ( key ) => {

			const found = byKey.has( key ) ? key : suffixMatch( keys, key );
			if ( found ) return { key: found, bytes: new Uint8Array( await byKey.get( found ).blob.arrayBuffer() ) };
			// Not in the folder: NVIDIA scenes often link to NVIDIA's public asset library.
			return remote( key );

		},
	};

}

/** Texture stand-in: remembers the encoded image instead of decoding it with the DOM. */
function stubTexture( data, textureAttrs, transformAttrs ) {

	const bytes = data instanceof ArrayBuffer ? new Uint8Array( data ) : data;
	if ( ! ( bytes instanceof Uint8Array ) ) return null; // a missing file (the composer passes its path)

	const texture = new THREE.Texture();

	if ( textureAttrs ) {

		texture.wrapS = this._getWrapMode( textureAttrs[ 'inputs:wrapS' ] );
		texture.wrapT = this._getWrapMode( textureAttrs[ 'inputs:wrapT' ] );

	}

	this._applyTextureTransforms( texture, transformAttrs );
	texture.userData.pendingImage = bytes;
	return texture;

}

/** Decodes to a bitmap that is already flipped, which is what a non-flipping texture expects. */
export function decodeImage( bytes ) {

	if ( typeof createImageBitmap !== 'function' ) return Promise.resolve( null );
	return createImageBitmap( new Blob( [ bytes ] ), { imageOrientation: 'flipY', premultiplyAlpha: 'none' } ).catch( () => null );

}

/**
 * Builds the scene for a USD model.
 * @returns {Promise<{ result: object, transfer: Transferable[] }>}
 */
export async function runUsdJob( spec, { onProgress, decode = decodeImage } = {} ) {

	const { name, rootKey, rootBytes, fetchFile } = await openSpec( spec, onProgress );
	checkUsdBytes( rootBytes, name );

	let stage;
	setTextureFactory( stubTexture );

	try {

		stage = await loadUsdStage( { rootKey, rootBytes, fetchFile, manager: new THREE.LoadingManager(), onProgress } );

	} finally {

		setTextureFactory( null );

	}

	onProgress?.( 'Packing the scene…' );
	const { images, ...packed } = packScene( stage.group );

	// Decode a few images at a time: fast, and the worker's memory stays modest.
	const bitmaps = new Map();
	const queue = [ ...images ];
	let done = 0;

	await Promise.all( Array.from( { length: 4 }, async () => {

		for ( let next = queue.shift(); next; next = queue.shift() ) {

			const bitmap = await decode( next[ 1 ] );
			if ( bitmap ) bitmaps.set( next[ 0 ], bitmap );
			onProgress?.( `Decoding textures… ${ ++ done } of ${ images.size }` );

		}

	} ) );

	return {
		result: { packed, bitmaps, missing: stage.missing, layerCount: stage.layerCount, name, size: rootBytes.length },
		transfer: [ ...transferListOf( packed ), ...bitmaps.values() ],
	};

}

/** Reads the stage and prim metadata for the Selection panel. */
export async function runMetaJob( spec ) {

	const { rootBytes } = await openSpec( spec );
	return { result: { meta: readMetadata( rootBytes ) }, transfer: [] };

}
