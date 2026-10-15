import * as THREE from 'three';

/**
 * CPU copies of three.js' tone-mapping curves (linear in → linear out), used to
 * pick a background colour that comes out of tone mapping exactly as chosen.
 */

export const TONE_MAPPINGS = {
	neutral: { label: 'Neutral (accurate colour)', value: THREE.NeutralToneMapping },
	agx: { label: 'AgX (film-like)', value: THREE.AgXToneMapping },
	aces: { label: 'ACES Filmic (high contrast)', value: THREE.ACESFilmicToneMapping },
	none: { label: 'None (linear)', value: THREE.NoToneMapping },
};

// GLSL mat3( a, b, c ) is column-major: M * v = a * v.x + b * v.y + c * v.z.
function mul( cols, v ) {

	return [ 0, 1, 2 ].map( ( i ) => cols[ 0 ][ i ] * v[ 0 ] + cols[ 1 ][ i ] * v[ 1 ] + cols[ 2 ][ i ] * v[ 2 ] );

}

const clamp01 = ( x ) => Math.min( 1, Math.max( 0, x ) );

function neutral( c ) {

	const startCompression = 0.8 - 0.04;
	const desaturation = 0.15;
	const x = Math.min( ...c );
	const offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
	c = c.map( ( v ) => v - offset );
	const peak = Math.max( ...c );
	if ( peak < startCompression ) return c;
	const d = 1 - startCompression;
	const newPeak = 1 - ( d * d ) / ( peak + d - startCompression );
	c = c.map( ( v ) => v * newPeak / peak );
	const g = 1 - 1 / ( desaturation * ( peak - newPeak ) + 1 );
	return c.map( ( v ) => v + ( newPeak - v ) * g );

}

const ACES_IN = [ [ 0.59719, 0.07600, 0.02840 ], [ 0.35458, 0.90834, 0.13383 ], [ 0.04823, 0.01566, 0.83777 ] ];
const ACES_OUT = [ [ 1.60475, - 0.10208, - 0.00327 ], [ - 0.53108, 1.10813, - 0.07276 ], [ - 0.07367, - 0.00605, 1.07602 ] ];

function aces( c ) {

	c = mul( ACES_IN, c.map( ( v ) => v / 0.6 ) );
	c = c.map( ( v ) => ( v * ( v + 0.0245786 ) - 0.000090537 ) / ( v * ( 0.983729 * v + 0.4329510 ) + 0.238081 ) );
	return mul( ACES_OUT, c ).map( clamp01 );

}

const SRGB_TO_2020 = [ [ 0.6274, 0.0691, 0.0164 ], [ 0.3293, 0.9195, 0.0880 ], [ 0.0433, 0.0113, 0.8956 ] ];
const REC2020_TO_SRGB = [ [ 1.6605, - 0.1246, - 0.0182 ], [ - 0.5876, 1.1329, - 0.1006 ], [ - 0.0728, - 0.0083, 1.1187 ] ];
const AGX_INSET = [ [ 0.856627153315983, 0.137318972929847, 0.11189821299995 ], [ 0.0951212405381588, 0.761241990602591, 0.0767994186031903 ], [ 0.0482516061458583, 0.101439036467562, 0.811302368396859 ] ];
const AGX_OUTSET = [ [ 1.1271005818144368, - 0.1413297634984383, - 0.14132976349843826 ], [ - 0.11060664309660323, 1.157823702216272, - 0.11060664309660294 ], [ - 0.016493938717834573, - 0.016493938717834257, 1.2519364065950405 ] ];

function agx( c ) {

	const minEv = - 12.47393;
	const maxEv = 4.026069;
	c = mul( AGX_INSET, mul( SRGB_TO_2020, c ) );
	c = c.map( ( v ) => clamp01( ( Math.log2( Math.max( v, 1e-10 ) ) - minEv ) / ( maxEv - minEv ) ) );
	c = c.map( ( x ) => {

		const x2 = x * x;
		const x4 = x2 * x2;
		return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;

	} );
	c = mul( AGX_OUTSET, c ).map( ( v ) => Math.pow( Math.max( 0, v ), 2.2 ) );
	return mul( REC2020_TO_SRGB, c ).map( clamp01 );

}

const CURVES = { neutral, aces, agx, none: ( c ) => c };

export function toneMap( mode, rgb, exposure ) {

	return ( CURVES[ mode ] || neutral )( rgb.map( ( v ) => v * exposure ) );

}

/**
 * Finds the scene colour that tone maps to `target` (linear RGB): damped Newton
 * steps with a numeric Jacobian, since the curves mix channels.
 */
export function inverseToneMap( mode, target, exposure ) {

	if ( mode === 'none' ) return target.map( ( v ) => v / exposure );

	let x = target.map( ( v ) => Math.max( v, 1e-4 ) / exposure );

	for ( let iter = 0; iter < 60; iter ++ ) {

		const f = toneMap( mode, x, exposure );
		const err = f.map( ( v, i ) => target[ i ] - v );
		if ( Math.max( ...err.map( Math.abs ) ) < 1e-5 ) break;

		// Jacobian columns by forward differences.
		const J = [ 0, 1, 2 ].map( ( j ) => {

			const h = Math.max( 1e-5, x[ j ] * 1e-3 );
			const xh = [ ...x ];
			xh[ j ] += h;
			const fh = toneMap( mode, xh, exposure );
			return fh.map( ( v, i ) => ( v - f[ i ] ) / h );

		} );

		const step = solve3( J, err ) || err.map( ( e ) => e / exposure );
		x = x.map( ( v, i ) => Math.min( 64, Math.max( 0, v + 0.8 * step[ i ] ) ) );

	}

	return x;

}

/** Solves J * s = e for s, with J given as columns. */
function solve3( cols, e ) {

	const m = new THREE.Matrix3().set(
		cols[ 0 ][ 0 ], cols[ 1 ][ 0 ], cols[ 2 ][ 0 ],
		cols[ 0 ][ 1 ], cols[ 1 ][ 1 ], cols[ 2 ][ 1 ],
		cols[ 0 ][ 2 ], cols[ 1 ][ 2 ], cols[ 2 ][ 2 ]
	);
	if ( Math.abs( m.determinant() ) < 1e-12 ) return null;
	return new THREE.Vector3( ...e ).applyMatrix3( m.invert() ).toArray();

}
