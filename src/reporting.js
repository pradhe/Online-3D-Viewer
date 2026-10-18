/**
 * Optional, opt-in crash reporting. Nothing is sent unless the site was built with
 * VITE_ERROR_ENDPOINT (a URL that accepts a JSON POST) AND the user ticked the box.
 * Reports hold the error text, a short stack, the app version and the browser name — never model
 * contents, and file names are scrubbed from the text.
 */

const ENDPOINT = import.meta.env.VITE_ERROR_ENDPOINT || '';
const KEY = 'mycity-viewer:report-errors';
const MAX_PER_SESSION = 5;

let sent = 0;

export const reportingAvailable = Boolean( ENDPOINT );

export function reportingEnabled() {

	if ( ! ENDPOINT ) return false;

	try {

		return localStorage.getItem( KEY ) === '1';

	} catch {

		return false;

	}

}

export function setReportingEnabled( on ) {

	try {

		localStorage.setItem( KEY, on ? '1' : '0' );

	} catch { /* storage unavailable: stays off */ }

}

/** Removes file names, URLs and long tokens that could identify a user's files. */
export function scrub( text ) {

	return String( text || '' )
		.replace( /\b(?:blob:)?(?:https?|file):\/\/\S+|\bblob:\S+/gi, '<url>' )
		.replace( /[\w .\-%()]+\.(?:obj|mtl|usd[azc]?|zip|png|jpe?g|webp|tga|bmp|gif|exr|dds)\b/gi, '<file>' )
		.slice( 0, 600 );

}

export function reportError( error, context = '' ) {

	if ( ! reportingEnabled() || sent >= MAX_PER_SESSION ) return;
	sent ++;

	const body = JSON.stringify( {
		app: 'online-3d-viewer',
		version: import.meta.env.VITE_APP_VERSION || 'dev',
		context,
		message: scrub( error?.message || error ),
		stack: scrub( error?.stack ).split( '\n' ).slice( 0, 6 ).join( '\n' ),
		browser: navigator.userAgent,
		page: location.origin + location.pathname,
	} );

	try {

		if ( ! navigator.sendBeacon?.( ENDPOINT, new Blob( [ body ], { type: 'text/plain' } ) ) ) {

			fetch( ENDPOINT, { method: 'POST', body, keepalive: true, mode: 'no-cors' } ).catch( () => {} );

		}

	} catch { /* reporting must never raise another error */ }

}
