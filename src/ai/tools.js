/**
 * The tools Claude can call. Each returns a small JSON summary (names, paths, sizes), never
 * geometry or textures. Every change goes into the History so the user can undo it.
 *
 * `ctx` = { viewer, history, units: { metresPerUnit, source }, confirm: async ( message ) => boolean }
 * `viewer` needs: model, meshes, select( objects ), focus( objects ), setVisible( objects, visible ), invalidate().
 */
import * as THREE from 'three';
import { LABELS, UNKNOWN, classify, describeMesh, roundDescriptor } from './geometry.js';

const MAX_LISTED = 50;
const MAX_SIMPLIFY_VERTICES = 2000000; // keeps one call responsive; meshoptimizer itself is fast

// ------------------------------------------------------------------ scene access

/** Stable ID for a mesh: its USD path when it has one, otherwise its position in the mesh list. */
export function partId( viewer, mesh ) {

	return mesh.userData.usdPath || `mesh-${ viewer.meshes.indexOf( mesh ) }`;

}

function isShown( viewer, object ) {

	for ( let o = object; o; o = o.parent ) {

		if ( ! o.visible ) return false;
		if ( o === viewer.model ) break;

	}

	return true;

}

function visibleParts( viewer ) {

	return viewer.meshes.filter( ( m ) => isShown( viewer, m ) );

}

function partsById( viewer, ids ) {

	if ( ! Array.isArray( ids ) || ! ids.length ) throw new Error( 'ids must be a non-empty list of part ids from list_parts' );
	const byId = new Map( viewer.meshes.map( ( m ) => [ partId( viewer, m ), m ] ) );
	const missing = ids.filter( ( id ) => ! byId.has( id ) );
	if ( missing.length ) throw new Error( `unknown part ids: ${ missing.slice( 0, 10 ).join( ', ' ) }` );
	return ids.map( ( id ) => byId.get( id ) );

}

const _box = new THREE.Box3();
const _size = new THREE.Vector3();

/** [width, depth, height] in metres (the viewer's world is Y up). */
function sizeOf( mesh, metresPerUnit ) {

	_box.setFromObject( mesh ).getSize( _size );
	return [ _size.x, _size.z, _size.y ].map( ( v ) => Number( ( v * metresPerUnit ).toFixed( 3 ) ) );

}

function worldPositions( mesh ) {

	const position = mesh.geometry.attributes.position;
	const out = new Float64Array( position.count * 3 );
	const v = new THREE.Vector3();
	mesh.updateWorldMatrix( true, false );
	for ( let i = 0; i < position.count; i ++ ) {

		v.fromBufferAttribute( position, i ).applyMatrix4( mesh.matrixWorld );
		out[ 3 * i ] = v.x;
		out[ 3 * i + 1 ] = v.y;
		out[ 3 * i + 2 ] = v.z;

	}

	return out;

}

export function describePart( mesh, metresPerUnit ) {

	return describeMesh( worldPositions( mesh ), mesh.geometry.index?.array ?? null, metresPerUnit );

}

function summary( viewer, mesh, metresPerUnit ) {

	return { id: partId( viewer, mesh ), name: mesh.name || '(unnamed)', size: sizeOf( mesh, metresPerUnit ), label: mesh.userData.aiClass ?? null };

}

function setLabels( ctx, meshes, labelOf, description ) {

	const before = new Map( meshes.map( ( m ) => [ m, m.userData.aiClass ] ) );
	let count = 0;
	for ( const m of meshes ) {

		const label = labelOf( m );
		if ( label === undefined ) continue;
		m.userData.aiClass = label;
		count ++;

	}

	if ( count ) {

		ctx.history.push( {
			label: description,
			undo: () => before.forEach( ( label, m ) => {

				if ( label === undefined ) delete m.userData.aiClass;
				else m.userData.aiClass = label;

			} ),
		} );

	}

	return count;

}

// ------------------------------------------------------------------ tools

const TOOLS = [];

function tool( name, description, properties, required, run ) {

	TOOLS.push( { name, description, input_schema: { type: 'object', properties, required }, run } );

}

const idList = { type: 'array', items: { type: 'string' }, description: 'Part ids from list_parts' };

tool( 'list_parts',
	`List visible parts (meshes) with id, name, size [width, depth, height] in metres and label. Filter by label ("none" = unlabelled), by name, or by largest dimension. Returns at most ${ MAX_LISTED } parts plus totals.`,
	{ label: { type: 'string' }, nameContains: { type: 'string' }, minSize: { type: 'number' }, maxSize: { type: 'number' } },
	[],
	( ctx, { label, nameContains, minSize, maxSize } ) => {

		const { viewer, units } = ctx;
		let parts = visibleParts( viewer ).map( ( m ) => summary( viewer, m, units.metresPerUnit ) );
		if ( label === 'none' ) parts = parts.filter( ( p ) => p.label === null );
		else if ( label ) parts = parts.filter( ( p ) => p.label === label );
		if ( nameContains ) parts = parts.filter( ( p ) => p.name.toLowerCase().includes( nameContains.toLowerCase() ) );
		if ( minSize !== undefined ) parts = parts.filter( ( p ) => Math.max( ...p.size ) >= minSize );
		if ( maxSize !== undefined ) parts = parts.filter( ( p ) => Math.max( ...p.size ) <= maxSize );

		const byLabel = {};
		for ( const p of parts ) byLabel[ p.label ?? 'none' ] = ( byLabel[ p.label ?? 'none' ] || 0 ) + 1;
		return { result: { total: parts.length, byLabel, parts: parts.slice( 0, MAX_LISTED ), truncated: parts.length > MAX_LISTED } };

	} );

tool( 'describe_part',
	'Geometry descriptor of one part: width, depth, height (metres), share of horizontal and vertical surface, surface area (m²). Use it to choose a label for parts the rules left Unknown.',
	{ id: { type: 'string' } },
	[ 'id' ],
	( ctx, { id } ) => {

		const [ mesh ] = partsById( ctx.viewer, [ id ] );
		return { result: { id, name: mesh.name || '(unnamed)', label: mesh.userData.aiClass ?? null, ...roundDescriptor( describePart( mesh, ctx.units.metresPerUnit ) ) } };

	} );

tool( 'classify_parts',
	'Run the rule-based classifier on visible parts (or the given ids). Labels clear cases (Wall, Slab, Column, Beam) and returns the parts left Unknown. Skips labelled parts unless overwrite is true.',
	{ ids: idList, overwrite: { type: 'boolean' } },
	[],
	( ctx, { ids, overwrite = false } ) => {

		const { viewer, units } = ctx;
		const meshes = ( ids ? partsById( viewer, ids ) : visibleParts( viewer ) ).filter( ( m ) => overwrite || ! m.userData.aiClass );
		const labelled = {};
		const unknown = [];
		const labels = new Map();
		for ( const m of meshes ) {

			const label = classify( describePart( m, units.metresPerUnit ) );
			if ( label === UNKNOWN ) unknown.push( partId( viewer, m ) );
			else {

				labels.set( m, label );
				labelled[ label ] = ( labelled[ label ] || 0 ) + 1;

			}

		}

		const count = setLabels( ctx, meshes, ( m ) => labels.get( m ), 'Classify parts' );
		return { result: { labelled, unknownCount: unknown.length, unknown: unknown.slice( 0, MAX_LISTED ) }, changed: count > 0 };

	} );

tool( 'set_label',
	`Set the label of parts. Allowed labels: ${ LABELS.join( ', ' ) }.`,
	{ ids: idList, label: { type: 'string', enum: LABELS } },
	[ 'ids', 'label' ],
	( ctx, { ids, label } ) => {

		if ( ! LABELS.includes( label ) ) throw new Error( `label must be one of: ${ LABELS.join( ', ' ) }` );
		const meshes = partsById( ctx.viewer, ids );
		setLabels( ctx, meshes, () => label, `Label ${ meshes.length } part(s) ${ label }` );
		return { result: { labelled: meshes.length, label }, changed: true };

	} );

tool( 'select_parts',
	'Select parts in the viewer (highlighted with an outline) and frame them in the camera, so the user can see what you mean.',
	{ ids: idList, focus: { type: 'boolean', description: 'Frame the camera on them (default true)' } },
	[ 'ids' ],
	( ctx, { ids, focus = true } ) => {

		const meshes = partsById( ctx.viewer, ids );
		ctx.viewer.select( meshes );
		if ( focus ) ctx.viewer.focus( meshes );
		return { result: { selected: meshes.length } };

	} );

tool( 'hide_parts',
	'Hide the given parts. The user can undo it or press "Show all".',
	{ ids: idList },
	[ 'ids' ],
	( ctx, { ids } ) => {

		const meshes = partsById( ctx.viewer, ids );
		hide( ctx, meshes, `Hide ${ meshes.length } part(s)` );
		return { result: { hidden: meshes.length }, changed: true };

	} );

tool( 'hide_small_parts',
	'Hide every visible part whose largest dimension is below maxSize metres (screws, clips, small details). Asks the user first.',
	{ maxSize: { type: 'number' } },
	[ 'maxSize' ],
	async ( ctx, { maxSize } ) => {

		const { viewer, units } = ctx;
		const small = visibleParts( viewer ).filter( ( m ) => Math.max( ...sizeOf( m, units.metresPerUnit ) ) < maxSize );
		if ( ! small.length ) return { result: { hidden: 0 } };
		if ( ! await ctx.confirm( `Hide ${ small.length } part(s) smaller than ${ formatSize( maxSize ) }?` ) ) return { result: { cancelled: true } };
		hide( ctx, small, `Hide ${ small.length } small part(s)` );
		return { result: { hidden: small.length, sample: small.slice( 0, 10 ).map( ( m ) => partId( viewer, m ) ) }, changed: true };

	} );

tool( 'simplify_parts',
	`Reduce the triangles of parts to about \`ratio\` of the original (0.05–0.95), keeping normals and texture coordinates. Parts with several materials are skipped. At most ${ MAX_SIMPLIFY_VERTICES.toLocaleString( 'en' ) } vertices per call. Asks the user first.`,
	{ ids: idList, ratio: { type: 'number' } },
	[ 'ids', 'ratio' ],
	async ( ctx, { ids, ratio } ) => {

		if ( ! ( ratio >= 0.05 && ratio <= 0.95 ) ) throw new Error( 'ratio must be between 0.05 and 0.95' );
		const meshes = partsById( ctx.viewer, ids );
		const usable = meshes.filter( ( m ) => ! Array.isArray( m.material ) && ! m.geometry.groups.length && ! m.isInstancedMesh && ! m.isSkinnedMesh );
		const skipped = meshes.length - usable.length;
		const vertices = usable.reduce( ( s, m ) => s + m.geometry.attributes.position.count, 0 );
		if ( vertices > MAX_SIMPLIFY_VERTICES ) throw new Error( `${ vertices } vertices is too many for one call (limit ${ MAX_SIMPLIFY_VERTICES }); simplify fewer parts at a time` );
		if ( ! usable.length ) return { result: { simplified: 0, skipped } };
		if ( ! await ctx.confirm( `Simplify ${ usable.length } part(s) to about ${ Math.round( ratio * 100 ) }% of their triangles?` ) ) return { result: { cancelled: true } };

		let before = 0;
		let after = 0;
		const swaps = [];
		for ( const mesh of usable ) {

			const oldGeometry = mesh.geometry;
			const newGeometry = await simplifyGeometry( oldGeometry, ratio );
			before += triangleCount( oldGeometry );
			after += triangleCount( newGeometry );
			mesh.geometry = newGeometry;
			swaps.push( { mesh, oldGeometry, newGeometry } );

		}

		ctx.history.push( {
			label: `Simplify ${ usable.length } part(s)`,
			undo: () => swaps.forEach( ( s ) => {

				s.mesh.geometry = s.oldGeometry;
				s.newGeometry.dispose();

			} ),
			discard: () => swaps.forEach( ( s ) => {

				if ( ! geometryInUse( ctx.viewer, s.oldGeometry ) ) s.oldGeometry.dispose();

			} ),
		} );

		return { result: { simplified: usable.length, skipped, trianglesBefore: before, trianglesAfter: after }, changed: true };

	} );

tool( 'set_units',
	'Change how many metres one model unit is (e.g. 0.001 for millimetres, 0.01 for centimetres, 1 for metres). Use it when sizes are clearly wrong, such as a 300 m tall chair.',
	{ metresPerUnit: { type: 'number' } },
	[ 'metresPerUnit' ],
	( ctx, { metresPerUnit } ) => {

		if ( ! ( metresPerUnit > 0 ) ) throw new Error( 'metresPerUnit must be positive' );
		ctx.units = { metresPerUnit, source: 'set by the assistant' };
		return { result: { metresPerUnit } };

	} );

tool( 'undo_last',
	'Undo the most recent change made by the assistant.',
	{},
	[],
	( ctx ) => {

		const label = ctx.history.undo();
		return { result: label ? { undone: label } : { undone: null, note: 'nothing to undo' }, changed: Boolean( label ) };

	} );

// ------------------------------------------------------------------ helpers

function hide( ctx, meshes, label ) {

	const before = meshes.map( ( m ) => m.visible );
	ctx.viewer.setVisible( meshes, false );
	ctx.history.push( { label, undo: () => meshes.forEach( ( m, i ) => ctx.viewer.setVisible( [ m ], before[ i ] ) ) } );

}

function formatSize( metres ) {

	return metres < 1 ? `${ Math.round( metres * 1000 ) } mm` : `${ metres } m`;

}

function triangleCount( geometry ) {

	return Math.floor( ( geometry.index ? geometry.index.count : geometry.attributes.position.count ) / 3 );

}

function geometryInUse( viewer, geometry ) {

	return viewer.meshes.some( ( m ) => m.geometry === geometry );

}

/**
 * meshoptimizer (three's SimplifyModifier, async since r18x); normals and UVs are kept and weigh in the error.
 * Imported on first use so its WASM is not compiled while the page starts.
 */
export async function simplifyGeometry( geometry, ratio ) {

	const { SimplifyModifier } = await import( 'three/addons/modifiers/SimplifyModifier.js' );
	const remove = Math.floor( geometry.attributes.position.count * ( 1 - ratio ) );
	const result = await new SimplifyModifier().modify( geometry, remove );
	result.computeBoundingBox();
	result.computeBoundingSphere();
	return result;

}

// ------------------------------------------------------------------ dispatch

export const toolSchemas = () => TOOLS.map( ( { name, description, input_schema } ) => ( { name, description, input_schema } ) );

/** Runs one tool. Failures go back to Claude as text so it can correct its next call. */
export async function runTool( ctx, name, input ) {

	const t = TOOLS.find( ( x ) => x.name === name );
	if ( ! t ) return { result: { error: `unknown tool: ${ name }` }, isError: true, changed: false };

	try {

		const { result, changed = false } = await t.run( ctx, input || {} );
		if ( changed ) ctx.viewer.invalidate();
		return { result, isError: false, changed };

	} catch ( error ) {

		return { result: { error: error.message }, isError: true, changed: false };

	}

}
