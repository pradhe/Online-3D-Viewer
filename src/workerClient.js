import { GLTF_EXTENSIONS, extensionOf } from './assets.js';
import { ViewerError } from './errors.js';
import { unpackScene } from './sceneTransfer.js';
import { runMetaJob, runUsdJob } from './usdJob.js';

/**
 * Opens a USD model off the main thread. Falls back to the same code on the main thread when
 * workers are unavailable, so the result is identical either way.
 */

function revive( error ) {

	if ( error.name === 'ViewerError' ) return new ViewerError( error.message, error.hint );
	const E = error.name === 'RangeError' ? RangeError : error.name === 'TypeError' ? TypeError : Error;
	return new E( error.message );

}

function abortError() {

	return new DOMException( 'Cancelled', 'AbortError' );

}

/** Runs one job in a fresh worker; resolves null if the worker itself could not run. */
function inWorker( job, spec, { onProgress, signal } ) {

	return new Promise( ( resolve, reject ) => {

		let worker;

		try {

			worker = new Worker( new URL( './usd.worker.js', import.meta.url ), { type: 'module' } );

		} catch {

			resolve( null );
			return;

		}

		const finish = ( fn, value ) => {

			signal?.removeEventListener( 'abort', onAbort );
			worker.terminate();
			fn( value );

		};

		const onAbort = () => finish( reject, abortError() );
		if ( signal?.aborted ) return onAbort();
		signal?.addEventListener( 'abort', onAbort );

		worker.onmessage = ( { data } ) => {

			if ( data.type === 'progress' ) onProgress?.( data.text );
			else if ( data.type === 'done' ) finish( resolve, data.result );
			else if ( data.error.name === 'WorkerUnsupported' ) finish( resolve, null );
			else finish( reject, revive( data.error ) );

		};

		// The script failed to load or start (blocked by a policy, old browser): use the fallback.
		worker.onerror = ( e ) => {

			e.preventDefault?.();
			finish( resolve, null );

		};

		worker.postMessage( { job, spec } );

	} );

}

async function run( job, spec, options ) {

	const viaWorker = await inWorker( job, spec, options );
	if ( viaWorker ) return viaWorker;
	if ( options.signal?.aborted ) throw abortError();

	const { result } = job === 'meta' ? await runMetaJob( spec ) : await runUsdJob( spec, { onProgress: options.onProgress } );
	return result;

}

/**
 * @param {import('./usdJob.js').UsdSpec} spec
 * @param {{ onProgress?: (text: string) => void, signal?: AbortSignal }} [options]
 */
export async function loadUsdScene( spec, { onProgress, signal } = {} ) {

	const options = { onProgress, signal };

	// Metadata is optional: a failure here must not fail the model. Only USD has any.
	const isUsd = ! GLTF_EXTENSIONS.includes( extensionOf( spec.rootPath || spec.url ) );
	const readMeta = () => ! isUsd ? Promise.resolve( { meta: null } ) : run( 'meta', spec, { signal } ).catch( ( e ) => {

		if ( e?.name === 'AbortError' ) throw e;
		return { meta: null };

	} );

	// Two busy workers leave a 2-core machine without a core for the page itself, so on small
	// machines the metadata is read after the scene instead of beside it.
	let scene, meta;

	if ( ( navigator.hardwareConcurrency || 2 ) >= 4 ) {

		[ scene, meta ] = await Promise.all( [ run( 'scene', spec, options ), readMeta() ] );

	} else {

		scene = await run( 'scene', spec, options );
		meta = await readMeta();

	}

	onProgress?.( 'Adding to the viewer…' );
	await new Promise( ( r ) => setTimeout( r, 0 ) ); // let the message paint before the last blocking step
	if ( signal?.aborted ) throw abortError();

	return {
		object: unpackScene( scene.packed, scene.bitmaps ),
		name: scene.name,
		size: scene.size,
		missing: scene.missing,
		layerCount: scene.layerCount,
		reducedTextures: scene.reducedTextures || 0,
		info: scene.info || null,
		usd: meta.meta,
	};

}
