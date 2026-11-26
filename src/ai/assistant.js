/**
 * Assistant panel: chat UI, settings dialog, and the glue between the agent loop, the tools,
 * the Claude client and the viewer. Markup lives in index.html (#assistant, #assistant-dialog).
 */
import { formatError } from '../errors.js';
import { runAgent } from './agent.js';
import { loadAssistantSettings, saveAssistantSettings, sendMessages, DEFAULT_MODEL } from './claude.js';
import { LABELS } from './geometry.js';
import { History } from './history.js';
import { partId, runTool, toolSchemas } from './tools.js';

const $ = ( sel ) => document.querySelector( sel );

export function systemPrompt( { units, modelName } ) {

	return `You are the assistant inside a browser-based 3D model viewer${ modelName ? ` showing "${ modelName }"` : '' }.
You act only through tools. Parts are meshes, identified by the ids that list_parts returns; never invent ids.
Sizes are in metres: width (X), depth, height (vertical). One model unit is ${ units.metresPerUnit } m (${ units.source }).
If sizes look wrong for what the parts are (a 300 m chair, a 2 mm wall), say so and use set_units.

How to work:
- Start with list_parts; filter it rather than listing everything.
- To classify: run classify_parts first (fast rules), then describe_part on the Unknown parts and set_label.
  Allowed labels: ${ LABELS.join( ', ' ) }. Part names are strong clues. If you are not confident, leave Unknown.
- Use select_parts to show the user which parts you mean.
- hide_small_parts and simplify_parts ask the user first. Every change can be undone (undo_last, or the Undo button).
- If a tool returns an error, read it and correct your next call.
- Answer briefly in plain language: what you did and the counts. Mention at most 10 parts by name.`;

}

/** One-line description of a tool call for the chat log. */
function describeCall( name, result, isError ) {

	if ( isError ) return `${ name }: ${ result.error }`;
	if ( result.cancelled ) return `${ name }: cancelled`;
	const parts = Object.entries( result )
		.filter( ( [ , v ] ) => typeof v === 'number' || typeof v === 'string' || ( v && typeof v === 'object' && ! Array.isArray( v ) ) )
		.map( ( [ k, v ] ) => `${ k } ${ typeof v === 'object' ? Object.entries( v ).map( ( [ a, b ] ) => `${ a } ${ b }` ).join( ', ' ) : v }` );
	return `${ name }${ parts.length ? `: ${ parts.join( ' · ' ) }` : '' }`;

}

/**
 * @param {object} options
 * @param {import('../viewer.js').Viewer} options.viewer
 * @param {() => { metresPerUnit: number, source: string }} options.getUnits units of the loaded model
 * @param {() => string} options.getModelName
 * @param {() => void} options.onChange called after the assistant changed labels, visibility or geometry
 */
export function initAssistant( { viewer, getUnits, getModelName, onChange } ) {

	const panel = $( '#assistant' );
	const log = $( '#assistant-log' );
	const form = $( '#assistant-form' );
	const input = $( '#assistant-text' );
	const sendButton = $( '#assistant-send' );
	const undoButton = $( '#assistant-undo' );
	const dialog = $( '#assistant-dialog' );

	let settings = loadAssistantSettings();
	const history = new History();
	const ctx = { viewer, history, units: getUnits(), confirm };
	let messages = [];
	let running = null; // AbortController of the current request
	let pendingConfirm = null;

	function scrollDown() {

		log.scrollTop = log.scrollHeight;

	}

	function makeEntry( kind, text ) {

		const el = document.createElement( 'div' );
		el.className = `assistant-msg ${ kind }`;
		el.textContent = text;
		return el;

	}

	function addEntry( kind, text ) {

		const el = makeEntry( kind, text );
		log.append( el );
		scrollDown();
		return el;

	}

	function syncButtons() {

		undoButton.disabled = ! history.size || Boolean( running );
		sendButton.textContent = running ? 'Stop' : 'Send';
		sendButton.classList.toggle( 'primary', ! running );
		input.disabled = Boolean( running );

	}

	function changed() {

		syncButtons();
		onChange();

	}

	/** Asks inside the chat; resolves false if the user says no or presses Stop. */
	function confirm( message ) {

		return new Promise( ( resolve ) => {

			const el = addEntry( 'confirm', message );
			const row = document.createElement( 'div' );
			row.className = 'button-row';
			const finish = ( answer ) => {

				row.remove();
				el.append( answer ? ' — yes' : ' — no' );
				pendingConfirm = null;
				resolve( answer );

			};

			for ( const [ label, answer ] of [ [ 'Yes', true ], [ 'No', false ] ] ) {

				const b = document.createElement( 'button' );
				b.type = 'button';
				b.className = answer ? 'btn small primary' : 'btn small';
				b.textContent = label;
				b.addEventListener( 'click', () => finish( answer ) );
				row.append( b );

			}

			el.append( row );
			pendingConfirm = finish;
			scrollDown();

		} );

	}

	async function ask( text ) {

		if ( ! settings.apiKey ) {

			openSettings();
			return;

		}

		addEntry( 'user', text );
		const selection = [ ...viewer.selection ].filter( ( o ) => o.isMesh ).map( ( m ) => partId( viewer, m ) );
		const content = selection.length ? `${ text }\n\n[Selected part ids: ${ selection.slice( 0, 50 ).join( ', ' ) }]` : text;
		const turnStart = messages.length;
		messages.push( { role: 'user', content } );

		running = new AbortController();
		syncButtons();
		const thinking = addEntry( 'status', 'Thinking…' );

		try {

			const answer = await runAgent( {
				send: ( request ) => sendMessages( { ...request, apiKey: settings.apiKey, model: settings.model } ),
				system: systemPrompt( { units: ctx.units, modelName: getModelName() } ),
				tools: toolSchemas(),
				runTool: ( name, toolInput ) => runTool( ctx, name, toolInput ),
				messages,
				signal: running.signal,
				onEvent: ( event ) => {

					if ( event.type === 'text' ) log.insertBefore( makeEntry( 'assistant', event.text ), thinking );
					if ( event.type === 'tool' ) {

						log.insertBefore( makeEntry( event.isError ? 'action error' : 'action', describeCall( event.name, event.result, event.isError ) ), thinking );
						if ( event.changed ) changed();

					}

					scrollDown();

				},
			} );

			thinking.remove();
			addEntry( 'assistant', answer || '(no answer)' );

		} catch ( error ) {

			thinking.remove();
			// Drop the unfinished turn so the next request starts from a valid conversation.
			messages.length = turnStart;
			addEntry( error.name === 'AbortError' ? 'status' : 'error', error.name === 'AbortError' ? 'Stopped.' : formatError( error ) );

		} finally {

			running = null;
			syncButtons();
			input.focus();

		}

	}

	// ------------------------------------------------------------------ wiring

	form.addEventListener( 'submit', ( e ) => {

		e.preventDefault();
		if ( running ) {

			pendingConfirm?.( false );
			running.abort();
			return;

		}

		const text = input.value.trim();
		if ( ! text ) return;
		input.value = '';
		ask( text );

	} );

	input.addEventListener( 'keydown', ( e ) => {

		if ( e.key === 'Enter' && ! e.shiftKey ) {

			e.preventDefault();
			form.requestSubmit();

		}

	} );

	undoButton.addEventListener( 'click', () => {

		const label = history.undo();
		if ( label ) addEntry( 'action', `Undone: ${ label }` );
		changed();
		viewer.invalidate();

	} );

	$( '#btn-assistant' ).addEventListener( 'click', () => {

		panel.hidden = ! panel.hidden;
		$( '#btn-assistant' ).classList.toggle( 'active', ! panel.hidden );
		if ( ! panel.hidden ) {

			if ( ! settings.apiKey ) openSettings();
			input.focus();

		}

	} );

	$( '#assistant-close' ).addEventListener( 'click', () => {

		panel.hidden = true;
		$( '#btn-assistant' ).classList.remove( 'active' );

	} );

	// ------------------------------------------------------------------ settings

	function openSettings() {

		$( '#assistant-key' ).value = settings.apiKey;
		$( '#assistant-model' ).value = settings.model;
		dialog.showModal();

	}

	$( '#assistant-settings' ).addEventListener( 'click', openSettings );

	dialog.addEventListener( 'close', () => {

		if ( dialog.returnValue === 'save' ) {

			settings = { apiKey: $( '#assistant-key' ).value.trim(), model: $( '#assistant-model' ).value.trim() || DEFAULT_MODEL };
			saveAssistantSettings( settings );

		} else if ( dialog.returnValue === 'forget' ) {

			settings = { apiKey: '', model: settings.model };
			saveAssistantSettings( settings );
			addEntry( 'status', 'API key removed from this browser.' );

		}

	} );

	// ------------------------------------------------------------------ model changes

	viewer.addEventListener( 'modelchange', () => {

		// setUpAxis also emits modelchange; only a new model resets the conversation.
		if ( ctx.model === viewer.model ) return;
		ctx.model = viewer.model;
		running?.abort();
		history.clear();
		messages = [];
		ctx.units = getUnits();
		log.replaceChildren();
		if ( viewer.model ) addEntry( 'status', `Ask about "${ getModelName() || 'this model' }". For example: "Classify the parts", "Hide parts smaller than 5 cm".` );
		syncButtons();

	} );

	syncButtons();

}
