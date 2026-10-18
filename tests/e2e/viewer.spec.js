import { expect, test } from '@playwright/test';
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
