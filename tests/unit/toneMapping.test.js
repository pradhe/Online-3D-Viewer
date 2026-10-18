import { describe, expect, it } from 'vitest';
import { inverseToneMap, toneMap } from '../../src/toneMapping.js';

// Background colours are mostly neutral or slightly tinted; strongly saturated colours can lie
// outside what AgX can output, so they are not expected to round-trip.
const colours = [ [ 0.05, 0.1, 0.2 ], [ 0.5, 0.5, 0.5 ], [ 0.6, 0.45, 0.35 ], [ 0.02, 0.02, 0.02 ] ];

describe( 'inverseToneMap', () => {

	for ( const mode of [ 'neutral', 'aces', 'agx', 'none' ] ) {

		it( `${ mode }: tone mapping the result returns the requested colour`, () => {

			for ( const target of colours ) {

				const scene = inverseToneMap( mode, target, 1 );
				const back = toneMap( mode, scene, 1 );
				back.forEach( ( v, i ) => expect( v ).toBeCloseTo( target[ i ], 3 ) );

			}

		} );

	}

	it( 'respects exposure', () => {

		const scene = inverseToneMap( 'neutral', [ 0.4, 0.4, 0.4 ], 2 );
		toneMap( 'neutral', scene, 2 ).forEach( ( v ) => expect( v ).toBeCloseTo( 0.4, 3 ) );

	} );

} );
