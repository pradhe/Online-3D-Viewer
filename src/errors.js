/**
 * Turns low-level failures into messages a person can act on, and checks inputs early so a
 * bad file fails with a clear reason instead of opening as an empty scene.
 */

/** An error whose message is already written for the user. */
export class ViewerError extends Error {

	constructor( message, hint = '' ) {

		super( message );
		this.name = 'ViewerError';
		this.hint = hint;

	}

}

const ascii = ( bytes, from, length ) => String.fromCharCode( ...bytes.slice( from, from + length ) );

/** Rejects empty files and files that are plainly not USD (text, crate or package). */
export function checkUsdBytes( bytes, name = 'This file' ) {

	if ( ! bytes.length ) throw new ViewerError( `${ name } is empty.`, 'Check that the download or copy finished, then open it again.' );
	if ( bytes[ 0 ] === 0x50 && bytes[ 1 ] === 0x4B ) return; // package (zip)
	if ( ascii( bytes, 0, 8 ) === 'PXR-USDC' ) return; // binary crate

	const head = new TextDecoder().decode( bytes.slice( 0, 64 ) ).replace( /^﻿/, '' ).trimStart();
	if ( head.startsWith( '#usda' ) ) return;

	throw new ViewerError(
		`${ name } is not a valid USD file.`,
		'USD files start with "#usda" (text) or "PXR-USDC" (binary). It may be another format with a USD extension, or it may have been damaged.'
	);

}

/** Counts what can actually be drawn. */
export function countGeometry( object ) {

	let n = 0;
	object.traverse( ( o ) => {

		// An empty mesh (a prim with no points, a face list with no vertices) draws nothing.
		const position = ( o.isMesh || o.isLine || o.isPoints ) && o.geometry?.attributes?.position;
		// A first vertex that is not a number means a malformed file (OBJ "v 0 0" gives NaN).
		if ( position && position.count > 0 && Number.isFinite( position.getX( 0 ) + position.getY( 0 ) + position.getZ( 0 ) ) ) n ++;

	} );
	return n;

}

/** A scene with nothing to draw is a failed load, not a success. */
export function assertHasGeometry( object, { format, missing = [] } = {} ) {

	if ( countGeometry( object ) > 0 ) return;

	if ( missing.length ) {

		throw new ViewerError(
			`The file opened, but ${ missing.length } linked file${ missing.length === 1 ? '' : 's' } could not be found, so there is nothing to show.`,
			'Open the whole folder (or a .zip of it) so referenced files load too.'
		);

	}

	throw new ViewerError(
		'The file opened, but it contains no geometry to show.',
		format === 'obj'
			? 'An OBJ needs vertices (v) and faces (f).'
			: 'It may hold only materials, cameras or lights, or its geometry may be in files that were not chosen.'
	);

}

/** @returns {{ message: string, hint: string }} */
export function describeError( error ) {

	if ( error instanceof ViewerError ) return { message: error.message, hint: error.hint };

	const text = String( error?.message || error || '' );

	if ( error instanceof RangeError && /array buffer allocation|invalid (typed )?array length|out of memory/i.test( text ) || /out of memory/i.test( text ) ) {

		return { message: 'The browser ran out of memory.', hint: 'Close other tabs, or open a smaller model. Very large scenes can need several gigabytes.' };

	}

	if ( error instanceof RangeError || /outside the bounds|unexpected end|invalid zip|truncated|offset/i.test( text ) ) {

		return { message: 'The file looks damaged or incomplete.', hint: 'It ends unexpectedly. Download or export it again, then retry.' };

	}

	if ( /failed to fetch|networkerror|load failed|network request failed/i.test( text ) ) {

		return { message: 'The file could not be downloaded.', hint: 'The address may be wrong, the server may be offline, or it may not allow other sites to read it (CORS). Download the file and open it from your computer instead.' };

	}

	return { message: text || 'An unexpected problem occurred.', hint: '' };

}

/** "message Hint." as one line for a toast. */
export function formatError( error ) {

	const { message, hint } = describeError( error );
	return hint ? `${ message } ${ hint }` : message;

}

/** True when this browser can create a WebGL2 context at all. */
export function webglAvailable() {

	try {

		return !! document.createElement( 'canvas' ).getContext( 'webgl2' );

	} catch {

		return false;

	}

}
