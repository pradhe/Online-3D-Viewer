import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { imageSize } from '../../src/imageSize.js';

const dir = resolve( dirname( fileURLToPath( import.meta.url ) ), '../fixtures/images' );
const size = ( name ) => imageSize( new Uint8Array( readFileSync( join( dir, name ) ) ) );

describe( 'imageSize', () => {

	it( 'reads PNG', () => expect( size( 'p300x200.png' ) ).toEqual( { width: 300, height: 200 } ) );
	it( 'reads JPEG', () => expect( size( 'j640x480.jpg' ) ).toEqual( { width: 640, height: 480 } ) );
	it( 'reads progressive JPEG', () => expect( size( 'jprog.jpg' ) ).toEqual( { width: 641, height: 479 } ) );
	it( 'reads lossy WebP', () => expect( size( 'w123x77.webp' ) ).toEqual( { width: 123, height: 77 } ) );
	it( 'reads lossless WebP', () => expect( size( 'w55x66ll.webp' ) ).toEqual( { width: 55, height: 66 } ) );
	it( 'reads WebP with alpha', () => expect( size( 'p90x40a.webp' ) ).toEqual( { width: 90, height: 40 } ) );

	it( 'returns null for other data instead of guessing', () => {

		expect( imageSize( new Uint8Array( [ 1, 2, 3 ] ) ) ).toBeNull();
		expect( imageSize( new Uint8Array( 100 ) ) ).toBeNull();
		expect( imageSize( new Uint8Array( [ 0xFF, 0xD8, 0xFF ] ) ) ).toBeNull(); // truncated JPEG

	} );

} );
