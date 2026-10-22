import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { decodeImage } from '../../src/usdJob.js';
import { MB, deviceLimits, disposeObject, fitToBudget, formatMemory, measureScene, textureBytes } from '../../src/memory.js';

const fakeImage = ( w, h ) => ( { width: w, height: h, closed: false, close() { this.closed = true; } } );

function textured( w, h ) {

	const texture = new THREE.Texture( fakeImage( w, h ) );
	return new THREE.Mesh( new THREE.BoxGeometry(), new THREE.MeshStandardMaterial( { map: texture } ) );

}

afterEach( () => vi.unstubAllGlobals() );

describe( 'measureScene', () => {

	it( 'counts shared geometry and textures once', () => {

		const geometry = new THREE.BoxGeometry();
		const material = new THREE.MeshStandardMaterial( { map: new THREE.Texture( fakeImage( 1024, 1024 ) ) } );
		const root = new THREE.Group().add( new THREE.Mesh( geometry, material ), new THREE.Mesh( geometry, material ) );
		const m = measureScene( root );

		expect( m.meshes ).toBe( 2 );
		expect( m.triangles ).toBe( 24 ); // 12 per box, two boxes
		expect( m.textures ).toHaveLength( 1 );
		expect( m.geometryBytes ).toBe( [ ...Object.values( geometry.attributes ), geometry.index ].reduce( ( s, a ) => s + a.array.byteLength, 0 ) );
		expect( m.textureBytes ).toBe( textureBytes( material.map ) );

	} );

	it( 'multiplies instanced meshes', () => {

		const mesh = new THREE.InstancedMesh( new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 100 );
		const m = measureScene( new THREE.Group().add( mesh ) );
		expect( m.triangles ).toBe( 1200 );
		expect( m.geometryBytes ).toBeGreaterThan( 100 * 64 ); // includes the instance matrices

	} );

	it( 'estimates a texture with its mip chain', () => {

		expect( textureBytes( new THREE.Texture( fakeImage( 1024, 1024 ) ) ) ).toBe( Math.round( 1024 * 1024 * 4 * 4 / 3 ) );

	} );

} );

describe( 'disposeObject', () => {

	it( 'releases geometry, material, textures and decoded images', () => {

		const mesh = textured( 64, 64 );
		const events = [];
		mesh.geometry.addEventListener( 'dispose', () => events.push( 'geometry' ) );
		mesh.material.addEventListener( 'dispose', () => events.push( 'material' ) );
		mesh.material.map.addEventListener( 'dispose', () => events.push( 'texture' ) );
		const image = mesh.material.map.image;

		disposeObject( new THREE.Group().add( mesh ) );
		expect( events.sort() ).toEqual( [ 'geometry', 'material', 'texture' ] );
		expect( image.closed ).toBe( true );

	} );

	it( 'covers texture slots that are not in a fixed list, and instanced meshes', () => {

		const material = new THREE.MeshPhysicalMaterial( { specularColorMap: new THREE.Texture( fakeImage( 8, 8 ) ), iridescenceMap: new THREE.Texture( fakeImage( 8, 8 ) ) } );
		const instanced = new THREE.InstancedMesh( new THREE.BoxGeometry(), material, 4 );
		const disposed = [];
		instanced.addEventListener( 'dispose', () => disposed.push( 'instanced' ) );
		material.specularColorMap.addEventListener( 'dispose', () => disposed.push( 'a' ) );
		material.iridescenceMap.addEventListener( 'dispose', () => disposed.push( 'b' ) );

		disposeObject( instanced );
		expect( disposed.sort() ).toEqual( [ 'a', 'b', 'instanced' ] );

	} );

	it( 'disposes a shared texture only once', () => {

		const texture = new THREE.Texture( fakeImage( 8, 8 ) );
		let count = 0;
		texture.addEventListener( 'dispose', () => count ++ );
		const a = new THREE.Mesh( new THREE.BoxGeometry(), new THREE.MeshBasicMaterial( { map: texture } ) );
		const b = new THREE.Mesh( new THREE.BoxGeometry(), new THREE.MeshBasicMaterial( { map: texture } ) );
		disposeObject( new THREE.Group().add( a, b ) );
		expect( count ).toBe( 1 );

	} );

} );

describe( 'fitToBudget', () => {

	function stubResize() {

		vi.stubGlobal( 'createImageBitmap', async ( image, opts ) => fakeImage( opts.resizeWidth, opts.resizeHeight ) );

	}

	it( 'caps textures above the maximum size and keeps the aspect ratio', async () => {

		stubResize();
		const mesh = textured( 8192, 4096 );
		const result = await fitToBudget( new THREE.Group().add( mesh ), { budget: 1e12, maxTextureSize: 2048 } );
		expect( result.capped ).toBe( 1 );
		expect( mesh.material.map.image.width ).toBe( 2048 );
		expect( mesh.material.map.image.height ).toBe( 1024 );

	} );

	it( 'halves the largest textures until the scene fits', async () => {

		stubResize();
		const big = textured( 4096, 4096 );
		const small = textured( 256, 256 );
		const root = new THREE.Group().add( big, small );
		const limit = 30 * MB;
		const result = await fitToBudget( root, { budget: limit, maxTextureSize: 4096 } );
		expect( result.before.totalBytes ).toBeGreaterThan( limit );
		expect( result.after.totalBytes ).toBeLessThanOrEqual( limit );
		expect( result.halved ).toBeGreaterThan( 0 );
		expect( big.material.map.image.width ).toBeLessThan( 4096 );
		expect( small.material.map.image.width ).toBe( 256 ); // the small one is left alone

	} );

	it( 'stops when nothing sensible is left to shrink', async () => {

		stubResize();
		const root = new THREE.Group().add( textured( 512, 512 ) );
		const result = await fitToBudget( root, { budget: 1, maxTextureSize: 4096 } );
		expect( result.after.totalBytes ).toBeGreaterThan( 1 );
		expect( Math.max( root.children[ 0 ].material.map.image.width ) ).toBeGreaterThanOrEqual( 128 );

	} );

} );

describe( 'deviceLimits', () => {

	it( 'uses a generous default when the browser does not say', () => {

		vi.stubGlobal( 'navigator', { userAgent: 'Mozilla/5.0 (X11; Linux)' } );
		const l = deviceLimits( { maxTextureSize: 16384 } );
		expect( l.budget ).toBe( 1536 * MB );
		expect( l.maxTextureSize ).toBe( 4096 );

	} );

	it( 'is stricter on a small phone', () => {

		vi.stubGlobal( 'navigator', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17)', deviceMemory: 2 } );
		const l = deviceLimits( { maxTextureSize: 8192 } );
		expect( l.budget ).toBe( 512 * MB );
		expect( l.maxTextureSize ).toBe( 2048 );
		expect( l.mobile ).toBe( true );

	} );

	it( 'follows an override and never exceeds the GPU limit', () => {

		vi.stubGlobal( 'navigator', { userAgent: 'x' } );
		expect( deviceLimits( { override: 10 } ).budget ).toBe( 10 * MB );
		expect( deviceLimits( { maxTextureSize: 1024 } ).maxTextureSize ).toBe( 1024 );

	} );

	it( 'formats sizes', () => {

		expect( formatMemory( 340 * MB ) ).toBe( '340 MB' );
		expect( formatMemory( 1.5 * 1024 * MB ) ).toBe( '1.5 GB' );

	} );

} );

describe( 'decodeImage', () => {

	const png = new Uint8Array( readFileSync( new URL( '../fixtures/textured/big.png', import.meta.url ) ) ); // 5000 x 4000

	it( 'scales a huge image down while decoding, keeping the aspect ratio', async () => {

		const calls = [];
		vi.stubGlobal( 'createImageBitmap', async ( data, options ) => {

			calls.push( options );
			return fakeImage( options.resizeWidth || 5000, options.resizeHeight || 4000 );

		} );
		const bitmap = await decodeImage( png, 2048 );
		expect( calls ).toHaveLength( 1 ); // one decode, at the reduced size: never the full image
		expect( calls[ 0 ].resizeWidth ).toBe( 2048 );
		expect( calls[ 0 ].resizeHeight ).toBe( 1638 );
		expect( calls[ 0 ].imageOrientation ).toBe( 'flipY' );
		expect( bitmap.width ).toBe( 2048 );

	} );

	it( 'leaves images alone when they fit, or when no limit is set', async () => {

		const calls = [];
		vi.stubGlobal( 'createImageBitmap', async ( data, options ) => {

			calls.push( options );
			return fakeImage( 5000, 4000 );

		} );
		await decodeImage( png, 8192 );
		await decodeImage( png, 0 );
		expect( calls.every( ( o ) => o.resizeWidth === undefined ) ).toBe( true );

	} );

	it( 'shrinks after decoding when the format is not recognised', async () => {

		const calls = [];
		vi.stubGlobal( 'createImageBitmap', async ( data, options ) => {

			calls.push( options );
			return options.resizeWidth ? fakeImage( options.resizeWidth, options.resizeHeight ) : fakeImage( 6000, 3000 );

		} );
		const bitmap = await decodeImage( new Uint8Array( [ 1, 2, 3, 4 ] ), 1000 );
		expect( bitmap.width ).toBe( 1000 );
		expect( bitmap.height ).toBe( 500 );

	} );

} );
