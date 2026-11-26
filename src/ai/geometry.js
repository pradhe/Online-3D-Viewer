/**
 * Geometry analysis for the assistant. Works on plain arrays (no three.js), so it is cheap to test.
 * Input positions are world space with Y up (the viewer turns Z-up models upright) in model units;
 * `metresPerUnit` converts them. Output is always metres.
 */

export const UNKNOWN = 'Unknown';

/** The only labels the assistant may assign. */
export const LABELS = [
	'Wall', 'Slab', 'Column', 'Beam', 'Door', 'Window', 'Stair', 'Roof',
	'Furniture', 'Equipment', 'Pipe', 'Fastener', 'Other', UNKNOWN,
];

/**
 * @param {ArrayLike<number>} positions world positions, x y z per vertex
 * @param {ArrayLike<number>|null} index triangle indices, or null for non-indexed triangles
 * @param {number} metresPerUnit
 */
export function describeMesh( positions, index, metresPerUnit = 1 ) {

	const s = metresPerUnit;
	const vertexCount = positions.length / 3;
	const result = { width: 0, depth: 0, height: 0, horizontalRatio: 0, verticalRatio: 0, surfaceArea: 0 };
	if ( ! vertexCount ) return result;

	const min = [ Infinity, Infinity, Infinity ];
	const max = [ - Infinity, - Infinity, - Infinity ];
	for ( let i = 0; i < positions.length; i += 3 ) {

		for ( let k = 0; k < 3; k ++ ) {

			const v = positions[ i + k ];
			if ( v < min[ k ] ) min[ k ] = v;
			if ( v > max[ k ] ) max[ k ] = v;

		}

	}

	result.width = ( max[ 0 ] - min[ 0 ] ) * s;
	result.height = ( max[ 1 ] - min[ 1 ] ) * s;
	result.depth = ( max[ 2 ] - min[ 2 ] ) * s;

	const triangleCount = index ? index.length / 3 : vertexCount / 3;
	let total = 0;
	let horizontal = 0;
	let vertical = 0;

	for ( let t = 0; t < triangleCount; t ++ ) {

		const a = 3 * ( index ? index[ 3 * t ] : 3 * t );
		const b = 3 * ( index ? index[ 3 * t + 1 ] : 3 * t + 1 );
		const c = 3 * ( index ? index[ 3 * t + 2 ] : 3 * t + 2 );

		const ux = positions[ b ] - positions[ a ], uy = positions[ b + 1 ] - positions[ a + 1 ], uz = positions[ b + 2 ] - positions[ a + 2 ];
		const vx = positions[ c ] - positions[ a ], vy = positions[ c + 1 ] - positions[ a + 1 ], vz = positions[ c + 2 ] - positions[ a + 2 ];
		const nx = uy * vz - uz * vy;
		const ny = uz * vx - ux * vz;
		const nz = ux * vy - uy * vx;
		const length = Math.hypot( nx, ny, nz );
		if ( length < 1e-12 ) continue;

		const area = 0.5 * length;
		const up = Math.abs( ny ) / length;
		total += area;
		if ( up > 0.9 ) horizontal += area;
		else if ( up < 0.1 ) vertical += area;

	}

	if ( total > 0 ) {

		result.horizontalRatio = horizontal / total;
		result.verticalRatio = vertical / total;
		result.surfaceArea = total * s * s;

	}

	return result;

}

/** Rules for clear building elements; everything else stays Unknown for the language model. */
export function classify( d ) {

	const longSide = Math.max( d.width, d.depth );
	const shortSide = Math.min( d.width, d.depth );

	if ( d.height < 0.4 && longSide > 2 && d.horizontalRatio > 0.7 ) return 'Slab';
	if ( d.height > 2 && shortSide < 0.4 && longSide > 0.8 && d.verticalRatio > 0.7 ) return 'Wall';
	if ( d.height > 2 && longSide < 0.8 ) return 'Column';
	if ( d.height < 1 && longSide > 2 && shortSide < 0.6 && d.horizontalRatio < 0.7 ) return 'Beam';
	return UNKNOWN;

}

/** Rounds a descriptor for the language model (small JSON, millimetre precision). */
export function roundDescriptor( d ) {

	const r = ( v, digits = 3 ) => Number( v.toFixed( digits ) );
	return {
		width: r( d.width ), depth: r( d.depth ), height: r( d.height ),
		horizontalRatio: r( d.horizontalRatio, 2 ), verticalRatio: r( d.verticalRatio, 2 ),
		surfaceArea: r( d.surfaceArea ),
	};

}
