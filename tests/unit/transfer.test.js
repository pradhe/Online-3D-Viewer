import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { transferListOf, unpackScene } from '../../src/sceneTransfer.js';
import { runMetaJob, runUsdJob } from '../../src/usdJob.js';
import { BUNDLE_ROOT, canonical, loadUsdStage } from '../../src/usdStage.js';

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

// A fake "decoded image" so the tests do not need a browser.
const fakeDecode = async ( bytes ) => ( { width: 2, height: 2, byteLength: bytes.length } );

async function viaJob( rootPath ) {

	const { result } = await runUsdJob( spec( rootPath ), { decode: fakeDecode } );
	return { result, object: unpackScene( result.packed, result.bitmaps ) };

}

/** The scene as the original main-thread code builds it (no textures: Node has no Image). */
async function direct( rootPath ) {

	const stage = await loadUsdStage( {
		rootKey: canonical( BUNDLE_ROOT + rootPath ),
		rootBytes: new Uint8Array( readFileSync( join( fixtures, rootPath ) ) ),
		manager: new THREE.LoadingManager(),
		fetchFile: async ( key ) => {

			try {

				return { key, bytes: new Uint8Array( readFileSync( join( fixtures, relative( BUNDLE_ROOT, key ) ) ) ) };

			} catch {

				return null;

			}

		},
	} );
	return stage.group;

}

const close = ( a, b, digits = 6 ) => a.forEach( ( v, i ) => expect( v ).toBeCloseTo( b[ i ], digits ) );

function sameTree( a, b, path = '' ) {

	const here = `${ path }/${ a.name }`;
	expect( b.type, here ).toBe( a.type );
	expect( b.name, here ).toBe( a.name );
	expect( b.children.length, here ).toBe( a.children.length );
	close( b.matrix.elements, a.matrix.elements );
	expect( b.userData, here ).toEqual( a.userData );

	if ( a.geometry ) {

		for ( const name of Object.keys( a.geometry.attributes ) ) {

			expect( Array.from( b.geometry.attributes[ name ].array ), `${ here } ${ name }` ).toEqual( Array.from( a.geometry.attributes[ name ].array ) );

		}

		expect( b.geometry.index?.array ? Array.from( b.geometry.index.array ) : null ).toEqual( a.geometry.index?.array ? Array.from( a.geometry.index.array ) : null );
		expect( b.geometry.groups ).toEqual( a.geometry.groups );

	}

	if ( a.material ) {

		const [ ma, mb ] = [ a.material, b.material ];
		expect( mb.type ).toBe( ma.type );
		expect( mb.color.toArray(), `${ here } colour` ).toEqual( ma.color.toArray() ); // exact, not 8-bit
		expect( mb.emissive?.toArray() ).toEqual( ma.emissive?.toArray() );
		expect( mb.roughness ).toBe( ma.roughness );
		expect( mb.metalness ).toBe( ma.metalness );
		expect( mb.opacity ).toBe( ma.opacity );
		expect( mb.side ).toBe( ma.side );
		expect( mb.vertexColors ).toBe( ma.vertexColors );

	}

	if ( a.isInstancedMesh ) {

		expect( b.count ).toBe( a.count );
		expect( Array.from( b.instanceMatrix.array ) ).toEqual( Array.from( a.instanceMatrix.array ) );

	}

	a.children.forEach( ( child, i ) => sameTree( child, b.children[ i ], here ) );

}

describe( 'moving a scene between threads', () => {

	for ( const file of [ 'flat.usda', 'flat.usdc', 'scene/root.usda', 'scene/box.usdc', 'animated.usda' ] ) {

		it( `${ file }: the rebuilt scene matches the original`, async () => {

			const original = await direct( file );
			const { object } = await viaJob( file );
			sameTree( original, object );

		} );

	}

	it( 'keeps animation clips', async () => {

		const original = await direct( 'animated.usda' );
		const { object } = await viaJob( 'animated.usda' );
		expect( original.animations.length ).toBeGreaterThan( 0 );
		expect( object.animations.map( ( c ) => c.name ) ).toEqual( original.animations.map( ( c ) => c.name ) );
		expect( object.animations[ 0 ].tracks.map( ( t ) => t.name ) ).toEqual( original.animations[ 0 ].tracks.map( ( t ) => t.name ) );
		expect( object.animations[ 0 ].duration ).toBeCloseTo( original.animations[ 0 ].duration );

	} );

	it( 'builds point instancers as instanced meshes', async () => {

		const { object } = await viaJob( 'animated.usda' );
		const instanced = [];
		object.traverse( ( o ) => o.isInstancedMesh && instanced.push( o ) );
		expect( instanced ).toHaveLength( 1 );
		expect( instanced[ 0 ].count ).toBe( 3 );

	} );

	it( 'reattaches texture maps with their settings', async () => {

		const { result, object } = await viaJob( 'textured/textured.usda' );
		expect( result.bitmaps.size ).toBe( 1 );
		let material;
		object.traverse( ( o ) => o.isMesh && ( material = o.material ) );
		expect( material.map ).toBeTruthy();
		expect( material.map.colorSpace ).toBe( THREE.SRGBColorSpace );
		expect( material.map.wrapS ).toBe( THREE.ClampToEdgeWrapping );
		expect( material.map.flipY ).toBe( false );
		expect( material.map.image.width ).toBe( 2 );
		expect( material.emissive.r ).toBeCloseTo( 0.2, 4 ); // exact float, not rounded to 8 bits

	} );

	it( 'a scene without a decoder still loads (textures are simply left off)', async () => {

		const { result } = await runUsdJob( spec( 'textured/textured.usda' ), { decode: async () => null } );
		const object = unpackScene( result.packed, result.bitmaps );
		let material;
		object.traverse( ( o ) => o.isMesh && ( material = o.material ) );
		expect( material.map ).toBeFalsy();

	} );

	it( 'the result can be posted: structured-cloneable with a transfer list', async () => {

		const baseline = ( await viaJob( 'flat.usdc' ) ).object;
		const { result, transfer } = await runUsdJob( spec( 'flat.usdc' ), { decode: fakeDecode } );
		expect( transfer.length ).toBeGreaterThan( 0 );
		const copy = structuredClone( result, { transfer: transferListOf( result.packed ) } );
		sameTree( baseline, unpackScene( copy.packed, new Map() ) );

	} );

	it( 'metadata travels too', async () => {

		const { result } = await runMetaJob( spec( 'flat.usda' ) );
		const copy = structuredClone( result );
		expect( copy.meta.prims.has( '/World/BoxA' ) ).toBe( true );

	} );

	it( 'a bad root file is reported, not swallowed', async () => {

		await expect( runUsdJob( spec( 'empty.usda' ) ) ).rejects.toThrow( /is empty/ );
		await expect( runUsdJob( spec( 'garbage.usd' ) ) ).rejects.toThrow( /not a valid USD file/ );
		await expect( runUsdJob( spec( 'nope.usda' ) ) ).rejects.toThrow( /no longer available/ );

	} );

} );
