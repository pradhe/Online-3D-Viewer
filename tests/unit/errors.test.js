import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ViewerError, assertHasGeometry, checkUsdBytes, countGeometry, describeError, formatError } from '../../src/errors.js';
import { scrub } from '../../src/reporting.js';

const bytes = ( text ) => new TextEncoder().encode( text );

describe( 'checkUsdBytes', () => {

	it( 'rejects an empty file', () => {

		expect( () => checkUsdBytes( new Uint8Array( 0 ), 'a.usd' ) ).toThrow( /a\.usd is empty/ );

	} );

	it( 'rejects text that is not USD', () => {

		expect( () => checkUsdBytes( bytes( 'hello' ), 'a.usd' ) ).toThrow( /not a valid USD file/ );

	} );

	it( 'accepts text, binary and package files', () => {

		expect( () => checkUsdBytes( bytes( '#usda 1.0\n' ) ) ).not.toThrow();
		expect( () => checkUsdBytes( bytes( '﻿  #usda 1.0\n' ) ) ).not.toThrow();
		expect( () => checkUsdBytes( bytes( 'PXR-USDC\u0000' ) ) ).not.toThrow();
		expect( () => checkUsdBytes( new Uint8Array( [ 0x50, 0x4B, 3, 4 ] ) ) ).not.toThrow();

	} );

} );

describe( 'assertHasGeometry', () => {

	it( 'fails on an empty scene and explains missing links', () => {

		const empty = new THREE.Group();
		expect( () => assertHasGeometry( empty, { format: 'usd' } ) ).toThrow( /no geometry/ );
		expect( () => assertHasGeometry( empty, { format: 'usd', missing: [ 'a.usd', 'b.usd' ] } ) ).toThrow( /2 linked files could not be found/ );

	} );

	it( 'passes when there is a mesh', () => {

		const g = new THREE.Group().add( new THREE.Mesh( new THREE.BoxGeometry() ) );
		expect( countGeometry( new THREE.Group().add( new THREE.Mesh( new THREE.BufferGeometry() ) ) ) ).toBe( 0 );
		expect( countGeometry( g ) ).toBe( 1 );
		expect( () => assertHasGeometry( g ) ).not.toThrow();

	} );

} );

describe( 'describeError', () => {

	it( 'passes through messages written for users', () => {

		expect( describeError( new ViewerError( 'Nope.', 'Try this.' ) ) ).toEqual( { message: 'Nope.', hint: 'Try this.' } );

	} );

	it( 'explains truncated files', () => {

		expect( describeError( new RangeError( 'Offset is outside the bounds of the DataView' ) ).message ).toMatch( /damaged or incomplete/ );
		expect( describeError( new Error( 'invalid zip data' ) ).message ).toMatch( /damaged or incomplete/ );

	} );

	it( 'explains memory and network failures', () => {

		expect( describeError( new RangeError( 'Array buffer allocation failed' ) ).message ).toMatch( /out of memory/ );
		expect( describeError( new TypeError( 'Failed to fetch' ) ).message ).toMatch( /could not be downloaded/ );

	} );

	it( 'keeps unknown messages and joins the hint', () => {

		expect( formatError( new Error( 'weird' ) ) ).toBe( 'weird' );
		expect( formatError( new ViewerError( 'A.', 'B.' ) ) ).toBe( 'A. B.' );

	} );

} );

describe( 'scrub (crash report text)', () => {

	it( 'removes file names and URLs', () => {

		const out = scrub( 'Failed on My Secret Plan.usdc at https://example.com/a/b.obj and blob:http://x/1234' );
		expect( out ).not.toMatch( /Secret|example\.com|blob:/ );
		expect( out ).toContain( '<file>' );

	} );

} );
