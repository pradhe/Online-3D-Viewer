import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import { checkGltfBytes, describeError } from '../../src/errors.js';
import { unpackScene } from '../../src/sceneTransfer.js';
import { runUsdJob } from '../../src/usdJob.js';

// GLTFLoader reads `self` for URL helpers; a worker has it, Node does not.
globalThis.self ??= globalThis;
globalThis.ProgressEvent ??= class ProgressEvent extends Event {

	constructor( type, init = {} ) {

		super( type );
		Object.assign( this, init );

	}

};

const fixtures = resolve( dirname( fileURLToPath( import.meta.url ) ), '../fixtures' );

function allFiles( dir = fixtures ) {

	return readdirSync( dir ).flatMap( ( n ) => {

		const p = join( dir, n );
		return statSync( p ).isDirectory() ? allFiles( p ) : [ p ];

	} );

}

const spec = ( rootPath ) => ( {
	kind: 'files',
	rootPath,
	files: allFiles().map( ( p ) => ( { file: new File( [ readFileSync( p ) ], p.split( '/' ).pop() ), path: relative( fixtures, p ) } ) ),
} );

async function viaJob( rootPath ) {

	const { result } = await runUsdJob( spec( rootPath ), { decode: async () => null } );
	return { result, object: unpackScene( result.packed, result.bitmaps ) };

}

async function direct( rootPath ) {

	const bytes = readFileSync( join( fixtures, rootPath ) );
	const gltf = await new GLTFLoader().parseAsync( bytes.buffer.slice( bytes.byteOffset, bytes.byteOffset + bytes.byteLength ), '' );
	gltf.scene.animations = gltf.animations;
	return gltf.scene;

}

/** Attribute values as floats, whether the attribute is interleaved, quantised or plain. */
const floats = ( a ) => Array.from( { length: a.count * a.itemSize }, ( _, j ) => a[ 'get' + 'XYZW'[ j % a.itemSize ] ]( Math.floor( j / a.itemSize ) ) );

const find = ( root, name ) => {

	let found = null;
	root.traverse( ( o ) => o.name === name && ( found = o ) );
	return found;

};

describe( 'glTF / GLB input', () => {

	it( 'opens a GLB with the same geometry, transforms and materials as the loader gives', async () => {

		const original = await direct( 'gltf/plain.glb' );
		const { object } = await viaJob( 'gltf/plain.glb' );

		const meshes = ( root ) => { const list = []; root.traverse( ( o ) => o.isMesh && list.push( o ) ); return list; };
		expect( meshes( object ).length ).toBe( meshes( original ).length );
		expect( meshes( object ).length ).toBe( 2 );

		for ( const name of [ 'Box', 'Tri' ] ) {

			const a = find( original, name );
			const b = find( object, name );
			expect( b.position.toArray() ).toEqual( a.position.toArray() );

			for ( const key of Object.keys( a.geometry.attributes ) ) {

				expect( floats( b.geometry.attributes[ key ] ), `${ name }.${ key }` ).toEqual( floats( a.geometry.attributes[ key ] ) );

			}

			expect( b.material.type ).toBe( a.material.type );
			expect( b.material.color.toArray() ).toEqual( a.material.color.toArray() );
			expect( b.material.roughness ).toBe( a.material.roughness );
			expect( b.material.metalness ).toBe( a.material.metalness );
			expect( b.material.side ).toBe( a.material.side );

		}

	} );

	it( 'keeps morph targets, vertex colours and the animation', async () => {

		const { object } = await viaJob( 'gltf/plain.glb' );
		const tri = find( object, 'Tri' );
		expect( tri.geometry.morphAttributes.position ).toHaveLength( 1 );
		expect( floats( tri.geometry.morphAttributes.position[ 0 ] ) ).toEqual( [ 0, 0, 0.5, 0, 0, 0.5, 0, 0, 0.5 ] );
		expect( tri.morphTargetInfluences ).toEqual( [ 0.25 ] );
		expect( tri.material.vertexColors ).toBe( true );
		expect( floats( tri.geometry.attributes.color ).slice( 0, 6 ) ).toEqual( [ 1, 0, 0, 0, 1, 0 ] );
		expect( floats( tri.geometry.attributes.position ) ).toEqual( [ 0, 0, 0, 1, 0, 0, 0, 1, 0 ] ); // not mixed up with the colours

		expect( object.animations.map( ( c ) => c.name ) ).toEqual( [ 'Slide' ] );
		expect( object.animations[ 0 ].tracks[ 0 ].name ).toContain( 'position' );
		expect( object.animations[ 0 ].duration ).toBeCloseTo( 1 );

	} );

	it( 'reads Meshopt-compressed meshes to the same vertices', async () => {

		const plain = ( await viaJob( 'gltf/plain.glb' ) ).object;
		const packed = ( await viaJob( 'gltf/plain_meshopt.glb' ) ).object;
		const a = floats( find( plain, 'Box' ).geometry.attributes.position );
		const b = floats( find( packed, 'Box' ).geometry.attributes.position );
		expect( b.length ).toBe( a.length );
		a.forEach( ( v, i ) => expect( b[ i ] ).toBeCloseTo( v, 2 ) ); // quantised, so close rather than equal

	} );

	it( 'reports the file facts', async () => {

		const { result } = await runUsdJob( spec( 'gltf/plain_meshopt.glb' ), { decode: async () => null } );
		expect( result.info.version ).toBe( '2.0' );
		expect( result.info.extensionsUsed ).toContain( 'EXT_meshopt_compression' );

	} );

	it( 'rejects files that are not glTF', () => {

		expect( () => checkGltfBytes( new Uint8Array( 0 ), 'a.glb', 'glb' ) ).toThrow( /is empty/ );
		expect( () => checkGltfBytes( new TextEncoder().encode( '#usda 1.0' ), 'a.glb', 'glb' ) ).toThrow( /not a valid GLB/ );
		expect( () => checkGltfBytes( new TextEncoder().encode( 'hello' ), 'a.gltf', 'gltf' ) ).toThrow( /not a valid glTF/ );
		expect( () => checkGltfBytes( new TextEncoder().encode( '{"asset":{}}' ), 'a.gltf', 'gltf' ) ).not.toThrow();
		expect( () => checkGltfBytes( new TextEncoder().encode( 'glTF\u0002\u0000\u0000\u0000' ), 'a.glb', 'glb' ) ).not.toThrow();

	} );

	it( 'a truncated GLB fails with a readable error', async () => {

		const bytes = readFileSync( join( fixtures, 'gltf/plain.glb' ) ).subarray( 0, 200 );
		const broken = { kind: 'files', rootPath: 'cut.glb', files: [ { file: new File( [ bytes ], 'cut.glb' ), path: 'cut.glb' } ] };
		const error = await runUsdJob( broken, { decode: async () => null } ).catch( ( e ) => e );
		expect( error ).toBeInstanceOf( Error );
		expect( describeError( error ).message.length ).toBeGreaterThan( 5 );

	} );

	it( 'a .gltf whose linked files were not chosen says which are missing', async () => {

		const only = { kind: 'files', rootPath: 'model.gltf', files: [ { file: new File( [ readFileSync( join( fixtures, 'gltf/model.gltf' ) ) ], 'model.gltf' ), path: 'model.gltf' } ] };
		const error = await runUsdJob( only, { decode: async () => null } ).catch( ( e ) => e );
		expect( error.name ).toBe( 'ViewerError' );
		expect( error.message ).toMatch( /model\.bin|baseColor\.png/ );

	} );

	it( 'a .gltf with its .bin opens and matches the GLB', async () => {

		const files = [ 'plain.gltf', 'plain.bin' ].map( ( n ) => ( { file: new File( [ readFileSync( join( fixtures, 'gltf', n ) ) ], n ), path: n } ) );
		const { result } = await runUsdJob( { kind: 'files', rootPath: 'plain.gltf', files }, { decode: async () => null } );
		const fromGltf = unpackScene( result.packed, result.bitmaps );
		const fromGlb = ( await viaJob( 'gltf/plain.glb' ) ).object;

		for ( const name of [ 'Box', 'Tri' ] ) {

			expect( floats( find( fromGltf, name ).geometry.attributes.position ) ).toEqual( floats( find( fromGlb, name ).geometry.attributes.position ) );

		}

	} );

} );
