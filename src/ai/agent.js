/**
 * The assistant loop: send the chat to the model, run the tools it asks for, send the results
 * back, and repeat until it answers in text. No DOM and no three.js, so it is easy to test.
 */

export const MAX_STEPS = 20;

/**
 * @param {object} options
 * @param {(request: {system, tools, messages, signal}) => Promise<{stopReason: string, content: object[]}>} options.send
 * @param {string} options.system
 * @param {object[]} options.tools tool schemas
 * @param {(name: string, input: object) => Promise<{result: object, isError: boolean, changed: boolean}>} options.runTool
 * @param {object[]} options.messages conversation so far; the new turns are appended to it
 * @param {AbortSignal} [options.signal]
 * @param {(event: object) => void} [options.onEvent] { type: 'text' | 'tool', ... }
 * @returns {Promise<string>} the final answer
 */
export async function runAgent( { send, system, tools, runTool, messages, signal, onEvent = () => {} } ) {

	for ( let step = 0; step < MAX_STEPS; step ++ ) {

		const reply = await send( { system, tools, messages, signal } );
		messages.push( { role: 'assistant', content: reply.content } );

		const text = reply.content.filter( ( b ) => b.type === 'text' ).map( ( b ) => b.text ).join( '\n' ).trim();
		const calls = reply.content.filter( ( b ) => b.type === 'tool_use' );

		if ( reply.stopReason !== 'tool_use' || ! calls.length ) return text;
		if ( text ) onEvent( { type: 'text', text } );

		const results = [];
		for ( const call of calls ) {

			signal?.throwIfAborted();
			const { result, isError, changed } = await runTool( call.name, call.input || {} );
			onEvent( { type: 'tool', name: call.name, input: call.input, result, isError, changed } );
			results.push( { type: 'tool_result', tool_use_id: call.id, content: JSON.stringify( result ), is_error: isError } );

		}

		messages.push( { role: 'user', content: results } );

	}

	return 'I stopped because the task needed too many steps. Try a smaller request.';

}
