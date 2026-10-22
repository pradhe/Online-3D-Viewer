import * as THREE from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { baseName } from './assets.js';
import { ViewerError } from './errors.js';

/**
 * Reads a .glb or .gltf file into a three.js scene. Runs in the worker (no DOM) or on the page;
 * Draco and Meshopt compressed meshes are supported. Linked files (.bin, images) come from the
 * chosen files/folder/zip, or from the same web folder as the model.
 */

/**
 * @param {object} options
 * @param {Uint8Array} options.rootBytes
 * @param {string} options.ext  'glb' or 'gltf'
 * @param {Map<string, { blob: Blob }>} [options.assets]  chosen files by lower-case name
 * @param {string} [options.baseUrl]  folder of a downloaded model
 * @param {string} [options.dracoPath]  folder holding the Draco decoder
 */
export async function buildGltf( { rootBytes, ext, assets, baseUrl = '', dracoPath } ) {

	const missing = new Set();
	const objectUrls = [];
	const manager = new THREE.LoadingManager();

	if ( assets ) {

		manager.setURLModifier( ( url ) => {

			if ( /^(blob|data):/.test( url ) ) return url;
			const asset = assets.get( baseName( url ).toLowerCase() );

			if ( asset ) {

				objectUrls.push( URL.createObjectURL( asset.blob ) );
				return objectUrls[ objectUrls.length - 1 ];

			}

			missing.add( baseName( url ) );
			return 'data:,';

		} );

	}

	const loader = new GLTFLoader( manager );
	let draco = null;

	if ( dracoPath ) {

		// Its own manager: the model's URL rewriting must not touch the decoder files.
		draco = new DRACOLoader().setDecoderPath( dracoPath );
		loader.setDRACOLoader( draco );

	}

	loader.setMeshoptDecoder( MeshoptDecoder );

	try {

		const data = ext === 'gltf' ? new TextDecoder().decode( rootBytes ) : rootBytes.buffer.slice( rootBytes.byteOffset, rootBytes.byteOffset + rootBytes.byteLength );
		const gltf = await loader.parseAsync( data, baseUrl );

		const object = gltf.scene || new THREE.Group();
		object.animations = gltf.animations || [];
		const asset = gltf.asset || {};
		const json = gltf.parser?.json || {};

		return {
			object,
			missing: [ ...missing ],
			info: {
				generator: asset.generator || '',
				version: asset.version || '',
				copyright: asset.copyright || '',
				extensionsUsed: json.extensionsUsed || [],
				extensionsRequired: json.extensionsRequired || [],
			},
		};

	} catch ( error ) {

		if ( missing.size ) throw new ViewerError( `This model links to files that were not chosen: ${ [ ...missing ].slice( 0, 6 ).join( ', ' ) }.`, 'Select the .gltf together with its .bin and texture files, or open the folder or a .zip of it.' );

		// No DOM in a worker: older Safari/Firefox cannot decode textures there, so the page does the work.
		if ( error instanceof ReferenceError && /document|Image|HTML/.test( error.message ) ) throw Object.assign( new Error( 'Textures need the page' ), { name: 'WorkerUnsupported' } );
		throw error;

	} finally {

		draco?.dispose();
		objectUrls.forEach( ( u ) => URL.revokeObjectURL( u ) );

	}

}
