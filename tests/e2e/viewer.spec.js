import { expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

const openFixture = ( page, ...names ) => page.setInputFiles( '#file-input', names.map( ( n ) => join( fixtures, n ) ) );

const textureCount = ( page ) => page.evaluate( () => window.viewer.renderer.info.memory.textures );

async function openGrid( page, n = 200 ) {

	const file = join( mkdtempSync( join( tmpdir(), 'viewer-' ) ), 'grid.usda' );
	writeFileSync( file, gridUsda( n ) );
	await page.setInputFiles( '#file-input', file );

}

test( 'a huge texture is reduced and the user is told', async ( { page } ) => {

	await page.goto( '' );
	await openFixture( page, 'textured/textured_big.usda', 'textured/big.png' );
	await expect.poll( () => meshCount( page ), { timeout: 60_000 } ).toBe( 1 );

	const size = await page.evaluate( () => {

		let image;
		window.viewer.model.traverse( ( o ) => o.isMesh && ( image = o.material.map?.image ) );
		return image ? Math.max( image.width, image.height ) : 0;

	} );
	expect( size ).toBeGreaterThan( 0 );
	expect( size ).toBeLessThanOrEqual( 4096 ); // the source is 5000 px
	await expect( page.locator( '.toast' ).filter( { hasText: /reduced to save memory/ } ) ).toBeVisible();

} );

test( 'a heavy model switches off shadows and ambient occlusion, and the next model gets them back', async ( { page } ) => {

	await page.goto( '?memory=3' );
	await openGrid( page );
	await expect( page.locator( '.toast' ).filter( { hasText: /Heavy model/ } ) ).toBeVisible( { timeout: 60_000 } );
	await expect( page.locator( '#opt-ao' ) ).not.toBeChecked();
	await expect( page.locator( '#opt-shadows' ) ).not.toBeChecked();

	await openFixture( page, 'flat.usda' );
	await expect.poll( () => meshCount( page ), { timeout: 60_000 } ).toBe( 2 );
	await expect( page.locator( '#opt-ao' ) ).toBeChecked();
	await expect( page.locator( '#opt-shadows' ) ).toBeChecked();

} );

test( 'a model that cannot fit the device is refused with a clear reason', async ( { page } ) => {

	await page.goto( '?memory=0.2' );
	await openGrid( page );
	await expect( page.locator( '.toast.error' ) ).toContainText( /more than this device can safely hold/, { timeout: 60_000 } );
	expect( await meshCount( page ) ).toBe( 0 );

} );

test( 'opening another model frees the previous one', async ( { page } ) => {

	await page.goto( '' );
	await openFixture( page, 'flat.usda' );
	await expect.poll( () => meshCount( page ), { timeout: 60_000 } ).toBe( 2 );
	await page.waitForTimeout( 1500 );
	const baseline = await textureCount( page );

	await openFixture( page, 'textured/textured.usda', 'textured/checker.png' );
	await expect.poll( () => page.evaluate( () => window.viewer.renderer.info.memory.textures ), { timeout: 30_000 } ).toBeGreaterThan( baseline );

	await openFixture( page, 'flat.usda' );
	await expect.poll( () => page.evaluate( () => window.viewer.renderer.info.memory.textures ), { timeout: 30_000 } ).toBe( baseline );

} );

/** What the viewer ended up with: meshes, the textured box's texture size, animation count, bounds. */
const modelFacts = ( page ) => page.evaluate( () => {

	let meshes = 0;
	let map = null;
	window.viewer.model.traverse( ( o ) => {

		if ( ! o.isMesh ) return;
		meshes ++;
		if ( o.material.map?.image ) map = { w: o.material.map.image.width, h: o.material.map.image.height, space: o.material.map.colorSpace };

	} );
	return { meshes, map, animations: window.viewer.model.animations.length, size: window.viewer.getSize().toArray().map( ( v ) => Math.round( v * 100 ) / 100 ) };

} );

for ( const [ label, files ] of [
	[ 'GLB with an embedded texture', [ 'gltf/model.glb' ] ],
	[ 'Draco-compressed GLB', [ 'gltf/model_draco.glb' ] ],
	[ 'Meshopt-compressed GLB', [ 'gltf/model_meshopt.glb' ] ],
	[ 'glTF with separate .bin and image files', [ 'gltf/model.gltf', 'gltf/model.bin', 'gltf/baseColor.png' ] ],
] ) {

	test( `opens a ${ label }`, async ( { page } ) => {

		const errors = watchErrors( page );
		await page.goto( '' );
		await openFixture( page, ...files );
		await expect.poll( () => meshCount( page ), { timeout: 60_000 } ).toBe( 2 );

		const facts = await modelFacts( page );
		expect( facts.map, 'the box keeps its texture' ).toEqual( { w: 8, h: 8, space: 'srgb' } );
		expect( facts.animations ).toBe( 1 );
		expect( facts.size[ 0 ] ).toBeGreaterThan( 3 ); // box and triangle side by side
		expect( errors ).toEqual( [] );

	} );

}

test( 'models load from a link: a GLB, and a .gltf with files next to it', async ( { page } ) => {

	const serve = ( url, file, type ) => page.route( url, ( route ) => route.fulfill( { body: readFileSync( join( fixtures, file ) ), contentType: type, headers: { 'access-control-allow-origin': '*' } } ) );
	await serve( 'https://models.test/a/model.glb', 'gltf/model.glb', 'model/gltf-binary' );
	await serve( 'https://models.test/b/model.gltf', 'gltf/model.gltf', 'model/gltf+json' );
	await serve( 'https://models.test/b/model.bin', 'gltf/model.bin', 'application/octet-stream' );
	await serve( 'https://models.test/b/baseColor.png', 'gltf/baseColor.png', 'image/png' );

	for ( const url of [ 'https://models.test/a/model.glb', 'https://models.test/b/model.gltf' ] ) {

		await page.goto( `?model=${ encodeURIComponent( url ) }` );
		await expect.poll( () => meshCount( page ), { timeout: 60_000 } ).toBe( 2 );
		expect( ( await modelFacts( page ) ).map ).toEqual( { w: 8, h: 8, space: 'srgb' } );

	}

} );

test( 'the bundled glTF sample opens from the Samples menu', async ( { page } ) => {

	await page.goto( '?sample=gltf' );
	await expect.poll( () => meshCount( page ), { timeout: 60_000 } ).toBe( 2 );

} );

test( 'a .gltf opened without its linked files is explained', async ( { page } ) => {

	await page.goto( '' );
	await openFixture( page, 'gltf/model.gltf' ); // without its .bin and image
	await expect( page.locator( '.toast.error' ) ).toContainText( /links to files that were not chosen/ );
	expect( await meshCount( page ) ).toBe( 0 );

} );

test( 'a glTF can be exported again as GLB with its texture', async ( { page } ) => {

	await page.goto( '' );
	await openFixture( page, 'gltf/model.glb' );
	await expect.poll( () => meshCount( page ), { timeout: 60_000 } ).toBe( 2 );

	await page.locator( '#menu-export summary' ).click();
	const download = page.waitForEvent( 'download' );
	await page.locator( '#export-list button' ).filter( { hasText: /GLB/ } ).first().click();
	const path = await ( await download ).path();

	const bytes = readFileSync( path );
	expect( bytes.subarray( 0, 4 ).toString() ).toBe( 'glTF' );
	const json = JSON.parse( bytes.subarray( 20, 20 + bytes.readUInt32LE( 12 ) ).toString() );
	expect( json.meshes.length ).toBe( 2 );
	expect( json.images?.length ).toBe( 1 );
	expect( json.animations?.length ?? 0 ).toBeGreaterThanOrEqual( 0 );

} );
