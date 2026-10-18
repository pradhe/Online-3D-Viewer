import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import '../../src/usdFixes.js';
import { extractUsdMetadata } from '../../src/usdMetadata.js';
import { BUNDLE_ROOT, canonical, loadUsdStage, suffixMatch } from '../../src/usdStage.js';

const fixtures = resolve( dirname( fileURLToPath( import.meta.url ) ), '../fixtures' );
const read = ( name ) => new Uint8Array( readFileSync( join( fixtures, name ) ) );

async function load( name ) {

	const rootKey = canonical( BUNDLE_ROOT + name );
	const stage = await loadUsdStage( {
		rootKey,
		rootBytes: read( name ),
		manager: new THREE.LoadingManager(),
		fetchFile: async ( key ) => {

			const rel = relative( BUNDLE_ROOT, key );
			try {

				return { key, bytes: read( rel ) };

			} catch {

				return null;

			}

		},
	} );
	const meshes = [];
	stage.group.traverse( ( o ) => o.isMesh && meshes.push( o ) );
	return { stage, meshes };

}

describe( 'USD loading', () => {

	for ( const name of [ 'flat.usda', 'flat.usdc' ] ) {

		it( `${ name }: loads both boxes at the right place`, async () => {

			const { meshes } = await load( name );
			expect( meshes ).toHaveLength( 2 );
			const box = new THREE.Box3().setFromObject( meshes[ 0 ].parent.parent );
			expect( box.isEmpty() ).toBe( false );

		} );

	}

	it( 'binary file with double translate (int8-inlined Vec3d) is placed at y = 45', async () => {

		const { meshes } = await load( 'scene/box.usdc' );
		expect( meshes ).toHaveLength( 1 );
		meshes[ 0 ].updateWorldMatrix( true, false );
		expect( new THREE.Vector3().setFromMatrixPosition( meshes[ 0 ].matrixWorld ).y ).toBeCloseTo( 45, 4 );

	} );

	it( 'follows references and sublayers across files', async () => {

		const { stage, meshes } = await load( 'scene/root.usda' );
		expect( stage.missing ).toEqual( [] );
		expect( stage.layerCount ).toBeGreaterThanOrEqual( 3 );
		expect( meshes ).toHaveLength( 2 );

	} );

	it( 'reports a missing referenced file instead of failing', async () => {

		const { stage } = await load( 'scene/root.usda' ).then( async () => {

			const rootKey = canonical( BUNDLE_ROOT + 'scene/root.usda' );
			const s = await loadUsdStage( {
				rootKey,
				rootBytes: read( 'scene/root.usda' ),
				manager: new THREE.LoadingManager(),
				fetchFile: async () => null,
			} );
			return { stage: s };

		} );
		expect( stage.missing.length ).toBeGreaterThan( 0 );

	} );

	it( 'rejects a truncated binary file', async () => {

		await expect( load( 'broken.usdc' ) ).rejects.toThrow();

	} );

} );

describe( 'USD metadata', () => {

	it( 'reads prims from a text file', () => {

		const meta = extractUsdMetadata( read( 'flat.usda' ) );
		expect( meta.prims.has( '/World/BoxA' ) ).toBe( true );
		expect( meta.prims.has( '/World/BoxB' ) ).toBe( true );

	} );

	it( 'reads the same prims from the binary version', () => {

		const text = extractUsdMetadata( read( 'flat.usda' ) );
		const binary = extractUsdMetadata( read( 'flat.usdc' ) );
		expect( [ ...binary.prims.keys() ].sort() ).toEqual( [ ...text.prims.keys() ].sort() );

	} );

} );

describe( 'path helpers', () => {

	it( 'canonical resolves . and ..', () => {

		expect( canonical( 'file:///bundle/a/./b/../c.usd' ) ).toBe( 'file:///bundle/a/c.usd' );

	} );

	it( 'suffixMatch finds a file by its tail path', () => {

		expect( suffixMatch( [ 'file:///bundle/x/y/tex/a.png' ], 'file:///bundle/tex/a.png' ) ).toBe( 'file:///bundle/x/y/tex/a.png' );

	} );

} );
