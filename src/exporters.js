import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import { USDZExporter } from 'three/addons/exporters/USDZExporter.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

export const EXPORT_FORMATS = {
	glb: { label: 'GLB (glTF binary)', mime: 'model/gltf-binary' },
	obj: { label: 'OBJ (geometry only)', mime: 'text/plain' },
	usdz: { label: 'USDZ', mime: 'model/vnd.usdz+zip' },
};

function toStandard( material ) {

	if ( material.isMeshStandardMaterial ) return material;

	const std = new THREE.MeshStandardMaterial( {
		name: material.name,
		color: material.color ? material.color.clone() : new THREE.Color( 0xffffff ),
		map: material.map || null,
		normalMap: material.normalMap || null,
		alphaMap: material.alphaMap || null,
		emissive: material.emissive ? material.emissive.clone() : new THREE.Color( 0x000000 ),
		emissiveMap: material.emissiveMap || null,
		opacity: material.opacity,
		transparent: material.transparent,
		side: material.side,
		roughness: material.shininess !== undefined ? THREE.MathUtils.clamp( 1 - material.shininess / 100, 0.05, 1 ) : 0.8,
		metalness: 0,
	} );

	return std;

}

/**
 * Copies the model with its original materials (the viewer may have swapped in
 * clay/wireframe display materials) so exports always contain the real look.
 */
function prepareCopy( model, getOriginalMaterial, { standardMaterials = false } = {} ) {

	const copy = cloneSkinned( model );
	const converted = new Map();
	const convert = ( m ) => {

		if ( ! converted.has( m ) ) converted.set( m, toStandard( m ) );
		return converted.get( m );

	};

	const sourceNodes = [];
	const copyNodes = [];
	model.traverse( ( n ) => sourceNodes.push( n ) );
	copy.traverse( ( n ) => copyNodes.push( n ) );

	copyNodes.forEach( ( node, i ) => {

		if ( ! node.isMesh ) return;
		let material = getOriginalMaterial( sourceNodes[ i ] );
		if ( standardMaterials ) material = Array.isArray( material ) ? material.map( convert ) : convert( material );
		node.material = material;

	} );

	copy.animations = model.animations || [];
	return copy;

}

export async function exportModel( model, format, getOriginalMaterial ) {

	if ( format === 'glb' ) {

		const copy = prepareCopy( model, getOriginalMaterial, { standardMaterials: true } );
		const result = await new GLTFExporter().parseAsync( copy, { binary: true, onlyVisible: true, animations: copy.animations } );
		return new Blob( [ result ], { type: EXPORT_FORMATS.glb.mime } );

	}

	if ( format === 'obj' ) {

		const copy = prepareCopy( model, getOriginalMaterial );
		return new Blob( [ new OBJExporter().parse( copy ) ], { type: EXPORT_FORMATS.obj.mime } );

	}

	if ( format === 'usdz' ) {

		const copy = prepareCopy( model, getOriginalMaterial, { standardMaterials: true } );
		const result = await new USDZExporter().parseAsync( copy );
		return new Blob( [ result ], { type: EXPORT_FORMATS.usdz.mime } );

	}

	throw new Error( `Unknown export format: ${ format }` );

}
