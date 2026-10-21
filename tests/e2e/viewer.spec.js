import { expect, test } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtures = resolve( dirname( fileURLToPath( import.meta.url ) ), '../fixtures' );

/** Collects uncaught errors and console errors so a test can assert there were none. */
function watchErrors( page ) {

	const errors = [];
	page.on( 'pageerror', ( e ) => errors.push( String( e ) ) );
	page.on( 'console', ( m ) => {

		// Missing favicon / optional files are not viewer bugs.
		if ( m.type() === 'error' && ! /favicon|Failed to load resource/.test( m.text() ) ) errors.push( m.text() );

	} );
	return errors;

}

const meshCount = ( page ) => page.evaluate( () => {

	let n = 0;
	window.viewer.model?.traverse( ( o ) => o.isMesh && n ++ );
	return n;

} );

test( 'opens the OBJ sample', async ( { page } ) => {

	const errors = watchErrors( page );
	await page.goto( '?sample=city' );
	await expect.poll( () => meshCount( page ), { timeout: 60_000 } ).toBeGreaterThan( 10 );
	expect( errors ).toEqual( [] );

} );

test( 'opens the USD sample', async ( { page } ) => {

	const errors = watchErrors( page );
	await page.goto( '?sample=shapes' );
	await expect.poll( () => meshCount( page ), { timeout: 60_000 } ).toBeGreaterThan( 0 );
	expect( errors ).toEqual( [] );

} );

test( 'opens a binary USD file chosen from disk', async ( { page } ) => {

	const errors = watchErrors( page );
	await page.goto( '' );
	await page.setInputFiles( '#file-input', join( fixtures, 'flat.usdc' ) );
	await expect.poll( () => meshCount( page ), { timeout: 60_000 } ).toBe( 2 );
	expect( errors ).toEqual( [] );

} );

test( 'shows a readable error for a broken file and keeps working', async ( { page } ) => {

	await page.goto( '' );
	await page.setInputFiles( '#file-input', join( fixtures, 'broken.usdc' ) );
	await expect( page.locator( '.toast.error' ) ).toContainText( /Could not open/ );

	// The viewer is still usable afterwards.
	await page.setInputFiles( '#file-input', join( fixtures, 'flat.usda' ) );
	await expect.poll( () => meshCount( page ), { timeout: 60_000 } ).toBe( 2 );

} );

test( 'draws something on the canvas', async ( { page } ) => {

	await page.goto( '?sample=city' );
	await expect.poll( () => meshCount( page ), { timeout: 60_000 } ).toBeGreaterThan( 10 );
	await page.waitForTimeout( 1500 );
	const shot = await page.locator( '#viewport canvas, canvas' ).first().screenshot();
	// A blank frame compresses to almost nothing; a lit city does not.
	expect( shot.length ).toBeGreaterThan( 8_000 );

} );

for ( const [ file, message ] of [
	[ 'empty.usda', /is empty/ ],
	[ 'garbage.usd', /not a valid USD file/ ],
	[ 'broken.usdc', /damaged or incomplete/ ],
	[ 'broken.usda', /no geometry/ ],
	[ 'broken.obj', /no geometry/ ],
] ) {

	test( `${ file }: says what is wrong`, async ( { page } ) => {

		await page.goto( '' );
		await page.setInputFiles( '#file-input', join( fixtures, file ) );
		await expect( page.locator( '.toast.error' ) ).toContainText( message );
		expect( await meshCount( page ) ).toBe( 0 );

	} );

}

test( 'an unexpected script error is reported once, not as a blank page', async ( { page } ) => {

	await page.goto( '' );
	await page.evaluate( () => setTimeout( () => { throw new Error( 'boom' ); }, 0 ) );
	await expect( page.locator( '.toast.error' ) ).toContainText( /Something went wrong/ );

} );

/** A big text USD: an n x n grid of quads (about 2 n^2 triangles). */
function gridUsda( n ) {

	const points = [];
	for ( let y = 0; y <= n; y ++ ) for ( let x = 0; x <= n; x ++ ) points.push( `(${ x }, ${ ( Math.sin( x / 9 ) * Math.cos( y / 7 ) ).toFixed( 3 ) }, ${ y })` );
	const counts = new Array( n * n ).fill( 4 ).join( ', ' );
	const indices = [];
	for ( let y = 0; y < n; y ++ ) for ( let x = 0; x < n; x ++ ) {

		const a = y * ( n + 1 ) + x;
		indices.push( a, a + 1, a + n + 2, a + n + 1 );

	}

	return `#usda 1.0\n(\n    upAxis = "Y"\n)\n\ndef Xform "World"\n{\n    def Mesh "Grid"\n    {\n        int[] faceVertexCounts = [${ counts }]\n        int[] faceVertexIndices = [${ indices.join( ', ' ) }]\n        point3f[] points = [${ points.join( ', ' ) }]\n    }\n}\n`;

}

test( 'a large scene does not block the page while it loads', async ( { page } ) => {

	// Long tasks (over 50 ms) are main-thread work. Unlike frame timing they are not stretched by
	// a busy GPU process, so the check also holds on a small CI machine with software WebGL.
	await page.addInitScript( () => {

		window.__long = [];
		new PerformanceObserver( ( list ) => list.getEntries().forEach( ( e ) => window.__long.push( { start: e.startTime, duration: e.duration } ) ) )
			.observe( { entryTypes: [ 'longtask' ] } );

	} );

	await page.goto( '' );
	await page.waitForTimeout( 8000 ); // start-up compiles shaders; it is not part of loading

	await page.evaluate( () => {

		window.__from = performance.now();
		window.viewer.addEventListener( 'modelchange', () => { window.__to = performance.now(); } );

	} );

	// From disk, not as an in-memory payload: Playwright injects payloads on the page's own thread.
	const big = join( mkdtempSync( join( tmpdir(), 'viewer-' ) ), 'grid.usda' );
	writeFileSync( big, gridUsda( 450 ) );
	await page.setInputFiles( '#file-input', big );
	await expect.poll( () => meshCount( page ), { timeout: 110_000 } ).toBe( 1 );

	const during = await page.evaluate( () => window.__long
		.filter( ( t ) => t.start + t.duration > window.__from && t.start < window.__to )
		.map( ( t ) => Math.round( t.duration ) ) );

	// Parsing and composing about 700,000 triangles on the page thread adds up to over a second;
	// with the worker only unpacking the result is left.
	const blocked = during.reduce( ( a, b ) => a + b, 0 );
	expect( blocked, `long tasks while loading (ms): ${ during }` ).toBeLessThan( 700 );

} );

test( 'Cancel stops a load and the viewer keeps working', async ( { page } ) => {

	// Hold the model back so there is time to cancel.
	await page.route( '**/samples/shapes/shapes.usda', async ( route ) => {

		await new Promise( ( r ) => setTimeout( r, 4000 ) );
		await route.continue();

	} );

	await page.goto( '?sample=shapes' );
	await expect( page.locator( '#loading' ) ).toBeVisible();
	await page.locator( '#loading-cancel' ).click();
	await expect( page.locator( '.toast' ) ).toContainText( /cancelled/i );
	await expect( page.locator( '#loading' ) ).toBeHidden();
	await page.waitForTimeout( 5000 );
	expect( await meshCount( page ) ).toBe( 0 ); // the late reply is ignored

	await page.unroute( '**/samples/shapes/shapes.usda' );
	await page.setInputFiles( '#file-input', join( fixtures, 'flat.usda' ) );
	await expect.poll( () => meshCount( page ), { timeout: 60_000 } ).toBe( 2 );

} );
