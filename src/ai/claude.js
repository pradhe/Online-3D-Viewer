/**
 * Claude Messages API, called straight from the browser with the user's own key
 * (ROADMAP item 19, option 1). The key stays in this browser's localStorage.
 */
import { ViewerError } from '../errors.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const STORAGE_KEY = 'mycity-viewer:assistant:v1';

export const DEFAULT_MODEL = 'claude-sonnet-5-5';

export function loadAssistantSettings() {

	try {

		return { apiKey: '', model: DEFAULT_MODEL, ...JSON.parse( localStorage.getItem( STORAGE_KEY ) || '{}' ) };

	} catch {

		return { apiKey: '', model: DEFAULT_MODEL };

	}

}

export function saveAssistantSettings( settings ) {

	try {

		localStorage.setItem( STORAGE_KEY, JSON.stringify( settings ) );

	} catch {

		// Storage can be blocked (private mode); the settings then last for this page only.

	}

}

const STATUS_HINTS = {
	400: 'The request was not accepted. Check the model name in the assistant settings.',
	401: 'The API key was rejected. Check it in the assistant settings.',
	403: 'This API key is not allowed to use that model.',
	404: 'The model was not found. Check the model name in the assistant settings.',
	429: 'Too many requests or the usage limit was reached. Wait a moment and try again.',
	529: 'Claude is busy right now. Try again in a minute.',
};

/** One request; returns { stopReason, content }. */
export async function sendMessages( { apiKey, model, system, tools, messages, signal, maxTokens = 4096, fetchImpl = fetch } ) {

	if ( ! apiKey ) throw new ViewerError( 'No Claude API key is set.', 'Open the assistant settings and paste your key.' );

	let response;
	try {

		response = await fetchImpl( API_URL, {
			method: 'POST',
			signal,
			headers: {
				'content-type': 'application/json',
				'x-api-key': apiKey,
				'anthropic-version': '2023-06-01',
				'anthropic-dangerous-direct-browser-access': 'true',
			},
			body: JSON.stringify( { model, max_tokens: maxTokens, system, tools, messages } ),
		} );

	} catch ( error ) {

		if ( error.name === 'AbortError' ) throw error;
		throw new ViewerError( 'Could not reach Claude.', 'Check your internet connection and try again.' );

	}

	if ( ! response.ok ) {

		let detail = '';
		try {

			detail = ( await response.json() )?.error?.message || '';

		} catch {

			// Not JSON; the status code is enough.

		}

		throw new ViewerError( `Claude returned an error (${ response.status })${ detail ? `: ${ detail }` : '' }.`,
			STATUS_HINTS[ response.status ] || 'Try again in a moment.' );

	}

	const data = await response.json();
	return { stopReason: data.stop_reason, content: data.content || [] };

}
