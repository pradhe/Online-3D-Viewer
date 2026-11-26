import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { MAX_STEPS, runAgent } from '../../src/ai/agent.js';
import { sendMessages } from '../../src/ai/claude.js';
import { classify, describeMesh } from '../../src/ai/geometry.js';
import { History } from '../../src/ai/history.js';
import { runTool, toolSchemas } from '../../src/ai/tools.js';
import { ViewerError } from '../../src/errors.js';

// three's BoxGeometry( width X, height Y, depth Z ); the viewer's world is Y up.
const box = ( w, h, d, name ) => Object.assign( new THREE.Mesh( new THREE.BoxGeometry( w, h, d ), new THREE.MeshStandardMaterial() ), { name } );

function describeBox( w, h, d ) {

	const g = new THREE.BoxGeometry( w, h, d );
	return describeMesh( g.attributes.position.array, g.index.array, 1 );

}

/** The parts of Viewer the tools use. */
function fakeViewer( meshes ) {

	const model = new THREE.Group();
	model.add( ...meshes );
	model.updateMatrixWorld( true );
	return {
		model,
		meshes,
		selection: new Set(),
		select( objects ) {

			this.selection = new Set( objects );

		},
		focus: vi.fn(),
		setVisible( objects, visible ) {

			objects.forEach( ( o ) => {

				o.visible = visible;

			} );

		},
		invalidate: vi.fn(),
	};

}

function setup( { confirm = true } = {} ) {

	const meshes = [ box( 4, 3, 0.2, 'Wall' ), box( 6, 0.25, 6, 'Floor' ), box( 0.5, 0.9, 0.5, 'Chair' ), box( 0.01, 0.03, 0.01, 'Screw' ) ];
	const viewer = fakeViewer( meshes );
	const ctx = { viewer, history: new History(), units: { metresPerUnit: 1, source: 'test' }, confirm: vi.fn( async () => confirm ) };
	return { meshes, viewer, ctx };

}

describe( 'geometry', () => {

	it( 'measures a wall in metres with Y as height', () => {

		const d = describeBox( 4, 3, 0.2 );
		expect( d.width ).toBeCloseTo( 4 );
		expect( d.height ).toBeCloseTo( 3 );
		expect( d.depth ).toBeCloseTo( 0.2 );
		expect( d.verticalRatio ).toBeGreaterThan( 0.9 );

	} );

	it( 'applies the unit scale to sizes and area', () => {

		const g = new THREE.BoxGeometry( 400, 300, 20 );
		const d = describeMesh( g.attributes.position.array, g.index.array, 0.01 );
		expect( d.width ).toBeCloseTo( 4 );
		expect( d.surfaceArea ).toBeCloseTo( 2 * ( 4 * 3 + 4 * 0.2 + 3 * 0.2 ) );

	} );

	it( 'handles non-indexed triangles', () => {

		const g = new THREE.BoxGeometry( 6, 0.25, 6 ).toNonIndexed();
		expect( classify( describeMesh( g.attributes.position.array, null, 1 ) ) ).toBe( 'Slab' );

	} );

	it( 'labels clear building elements and leaves the rest Unknown', () => {

		expect( classify( describeBox( 4, 3, 0.2 ) ) ).toBe( 'Wall' );
		expect( classify( describeBox( 6, 0.25, 6 ) ) ).toBe( 'Slab' );
		expect( classify( describeBox( 0.4, 3, 0.4 ) ) ).toBe( 'Column' );
		expect( classify( describeBox( 0.5, 0.9, 0.5 ) ) ).toBe( 'Unknown' );

	} );

} );

describe( 'tools', () => {

	it( 'publishes a schema for every tool', () => {

		const names = toolSchemas().map( ( t ) => t.name );
		expect( names ).toContain( 'classify_parts' );
		for ( const t of toolSchemas() ) expect( t.input_schema.type ).toBe( 'object' );

	} );

	it( 'classifies with rules, reports Unknown parts, and undoes', async () => {

		const { meshes, ctx } = setup();
		const { result, isError, changed } = await runTool( ctx, 'classify_parts', {} );

		expect( isError ).toBe( false );
		expect( changed ).toBe( true );
		expect( result.labelled ).toEqual( { Wall: 1, Slab: 1 } );
		expect( result.unknown ).toEqual( [ 'mesh-2', 'mesh-3' ] );
		expect( meshes[ 0 ].userData.aiClass ).toBe( 'Wall' );

		await runTool( ctx, 'undo_last', {} );
		expect( meshes[ 0 ].userData.aiClass ).toBeUndefined();

	} );

	it( 'uses USD paths as ids when the part has one', async () => {

		const { meshes, ctx } = setup();
		meshes[ 2 ].userData.usdPath = '/World/Chair';
		await runTool( ctx, 'set_label', { ids: [ '/World/Chair' ], label: 'Furniture' } );
		expect( meshes[ 2 ].userData.aiClass ).toBe( 'Furniture' );

		const { result } = await runTool( ctx, 'list_parts', { label: 'Furniture' } );
		expect( result.parts ).toEqual( [ { id: '/World/Chair', name: 'Chair', size: [ 0.5, 0.5, 0.9 ], label: 'Furniture' } ] );

	} );

	it( 'returns errors to the model instead of throwing', async () => {

		const { ctx } = setup();
		const bad = await runTool( ctx, 'set_label', { ids: [ 'mesh-2' ], label: 'Sofa' } );
		expect( bad.isError ).toBe( true );
		expect( bad.result.error ).toMatch( /label must be one of/ );

		const missing = await runTool( ctx, 'describe_part', { id: 'nope' } );
		expect( missing.result.error ).toMatch( /unknown part ids: nope/ );

		expect( ( await runTool( ctx, 'no_such_tool', {} ) ).isError ).toBe( true );

	} );

	it( 'asks before hiding small parts, and hidden parts leave the list', async () => {

		const declined = setup( { confirm: false } );
		expect( ( await runTool( declined.ctx, 'hide_small_parts', { maxSize: 0.05 } ) ).result ).toEqual( { cancelled: true } );
		expect( declined.meshes[ 3 ].visible ).toBe( true );

		const { meshes, ctx } = setup();
		const { result } = await runTool( ctx, 'hide_small_parts', { maxSize: 0.05 } );
		expect( result.hidden ).toBe( 1 );
		expect( meshes[ 3 ].visible ).toBe( false );
		expect( ( await runTool( ctx, 'list_parts', {} ) ).result.total ).toBe( 3 );

		await runTool( ctx, 'undo_last', {} );
		expect( meshes[ 3 ].visible ).toBe( true );

	} );

	it( 'simplifies a mesh and undo restores the original geometry', async () => {

		const sphere = new THREE.Mesh( new THREE.SphereGeometry( 1, 32, 16 ), new THREE.MeshStandardMaterial() );
		const viewer = fakeViewer( [ sphere ] );
		const ctx = { viewer, history: new History(), units: { metresPerUnit: 1, source: 'test' }, confirm: async () => true };
		const original = sphere.geometry;

		const { result, isError } = await runTool( ctx, 'simplify_parts', { ids: [ 'mesh-0' ], ratio: 0.5 } );
		expect( isError ).toBe( false );
		expect( result.trianglesAfter ).toBeLessThan( result.trianglesBefore * 0.8 );
		expect( result.trianglesAfter ).toBeGreaterThan( 0 );
		expect( sphere.geometry ).not.toBe( original );
		expect( sphere.geometry.attributes.normal ).toBeDefined();

		await runTool( ctx, 'undo_last', {} );
		expect( sphere.geometry ).toBe( original );

	} );

	it( 'skips multi-material parts when simplifying', async () => {

		const geometry = new THREE.BoxGeometry();
		const multi = new THREE.Mesh( geometry, [ new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial() ] );
		const ctx = { viewer: fakeViewer( [ multi ] ), history: new History(), units: { metresPerUnit: 1 }, confirm: async () => true };
		const { result } = await runTool( ctx, 'simplify_parts', { ids: [ 'mesh-0' ], ratio: 0.5 } );
		expect( result ).toEqual( { simplified: 0, skipped: 1 } );
		expect( multi.geometry ).toBe( geometry );

	} );

	it( 'sizes follow the unit setting', async () => {

		const { ctx } = setup();
		await runTool( ctx, 'set_units', { metresPerUnit: 0.01 } );
		const { result } = await runTool( ctx, 'list_parts', { nameContains: 'wall' } );
		expect( result.parts[ 0 ].size ).toEqual( [ 0.04, 0.002, 0.03 ] );

	} );

} );

describe( 'agent loop', () => {

	const toolUse = ( id, name, input ) => ( { stopReason: 'tool_use', content: [ { type: 'tool_use', id, name, input } ] } );

	it( 'runs requested tools, returns results with matching ids, and ends with the answer', async () => {

		const replies = [ toolUse( 't1', 'list_parts', {} ), { stopReason: 'end_turn', content: [ { type: 'text', text: 'Done.' } ] } ];
		const send = vi.fn( async () => replies.shift() );
		const runTool = vi.fn( async () => ( { result: { total: 2 }, isError: false, changed: false } ) );
		const messages = [ { role: 'user', content: 'How many parts?' } ];
		const events = [];

		const answer = await runAgent( { send, system: 's', tools: [], runTool, messages, onEvent: ( e ) => events.push( e ) } );

		expect( answer ).toBe( 'Done.' );
		expect( runTool ).toHaveBeenCalledWith( 'list_parts', {} );
		expect( messages[ 2 ] ).toEqual( { role: 'user', content: [ { type: 'tool_result', tool_use_id: 't1', content: '{"total":2}', is_error: false } ] } );
		expect( events ).toEqual( [ { type: 'tool', name: 'list_parts', input: {}, result: { total: 2 }, isError: false, changed: false } ] );

	} );

	it( 'stops after a bounded number of steps', async () => {

		const send = vi.fn( async () => toolUse( 't', 'list_parts', {} ) );
		const runTool = async () => ( { result: {}, isError: false, changed: false } );
		const answer = await runAgent( { send, system: '', tools: [], runTool, messages: [] } );
		expect( send ).toHaveBeenCalledTimes( MAX_STEPS );
		expect( answer ).toMatch( /too many steps/ );

	} );

} );

describe( 'Claude client', () => {

	it( 'sends the key and the browser-access header', async () => {

		const fetchImpl = vi.fn( async () => ( { ok: true, json: async () => ( { stop_reason: 'end_turn', content: [ { type: 'text', text: 'hi' } ] } ) } ) );
		const reply = await sendMessages( { apiKey: 'k', model: 'm', system: 's', tools: [], messages: [], fetchImpl } );

		const [ url, init ] = fetchImpl.mock.calls[ 0 ];
		expect( url ).toBe( 'https://api.anthropic.com/v1/messages' );
		expect( init.headers[ 'x-api-key' ] ).toBe( 'k' );
		expect( init.headers[ 'anthropic-dangerous-direct-browser-access' ] ).toBe( 'true' );
		expect( JSON.parse( init.body ).model ).toBe( 'm' );
		expect( reply ).toEqual( { stopReason: 'end_turn', content: [ { type: 'text', text: 'hi' } ] } );

	} );

	it( 'turns API failures into readable errors', async () => {

		const fetchImpl = async () => ( { ok: false, status: 401, json: async () => ( { error: { message: 'invalid x-api-key' } } ) } );
		const error = await sendMessages( { apiKey: 'bad', model: 'm', messages: [], fetchImpl } ).catch( ( e ) => e );
		expect( error ).toBeInstanceOf( ViewerError );
		expect( error.message ).toContain( 'invalid x-api-key' );
		expect( error.hint ).toMatch( /API key was rejected/ );

		await expect( sendMessages( { apiKey: '', model: 'm', messages: [] } ) ).rejects.toThrow( /No Claude API key/ );

	} );

} );
