import * as THREE from 'three';

/**
 * Moves a composed three.js scene between threads. Class instances cannot be posted, so a scene is
 * split into: a small JSON tree (three's own toJSON/ObjectLoader format), the big typed arrays
 * (vertex data, instance matrices — transferred, not copied), exact float colours (toJSON would
 * round them to 8 bits), and texture slots (the images are decoded separately).
 */

const isPlain = ( v ) => v !== null && typeof v === 'object';

function materialsOf( object ) {

	const m = object.material;
	return m ? ( Array.isArray( m ) ? m : [ m ] ) : [];

}

function attributeData( attribute ) {

	// glTF files often interleave position, normal and uv in one buffer; an interleaved attribute's
	// `array` is the whole shared buffer, so copy out just this attribute's values.
	if ( attribute.isInterleavedBufferAttribute ) {

		const { data, offset, itemSize, count } = attribute;
		const array = new data.array.constructor( count * itemSize );

		for ( let i = 0; i < count; i ++ ) {

			for ( let k = 0; k < itemSize; k ++ ) array[ i * itemSize + k ] = data.array[ i * data.stride + offset + k ];

		}

		return { array, itemSize, normalized: attribute.normalized };

	}

	return { array: attribute.array, itemSize: attribute.itemSize, normalized: attribute.normalized };

}

function extractGeometry( geometry ) {

	const data = { attributes: {}, groups: geometry.groups.map( ( g ) => ( { ...g } ) ) };
	for ( const [ name, attribute ] of Object.entries( geometry.attributes ) ) data.attributes[ name ] = attributeData( attribute );
	if ( geometry.index ) data.index = { array: geometry.index.array };

	if ( Object.keys( geometry.morphAttributes ).length ) {

		data.morph = {};
		for ( const [ name, list ] of Object.entries( geometry.morphAttributes ) ) data.morph[ name ] = list.map( attributeData );
		data.morphTargetsRelative = geometry.morphTargetsRelative;

	}

	return data;

}

function textureProps( texture, flipY ) {

	return {
		flipY,
		magFilter: texture.magFilter,
		minFilter: texture.minFilter,
		wrapS: texture.wrapS,
		wrapT: texture.wrapT,
		colorSpace: texture.colorSpace,
		channel: texture.channel,
		rotation: texture.rotation,
		repeat: texture.repeat.toArray(),
		offset: texture.offset.toArray(),
		center: texture.center.toArray(),
		userData: texture.userData ? JSON.parse( JSON.stringify( texture.userData, ( k, v ) => ( k === 'pendingImage' ? undefined : v ) ) ) : {},
	};

}

/**
 * @returns {{ scene: object, geometries: object, instanced: object, colors: object,
 *   textures: object[], textureSlots: object[], images: Map<number, Uint8Array|string|ImageBitmap|HTMLImageElement> }}
 */
export function packScene( root ) {

	const geometries = {};
	const instanced = {};
	const colors = {};
	const textures = []; // one per Texture object
	const textureSlots = [];
	const textureIds = new Map(); // Texture -> index
	const imageIds = new Map(); // image data -> id
	const images = new Map(); // id -> data
	const restore = [];
	const placeholders = new Map();
	const seenMaterials = new Set();

	const colourTable = ( owner ) => {

		const table = {};
		for ( const [ key, value ] of Object.entries( owner ) ) if ( value?.isColor ) table[ key ] = [ value.r, value.g, value.b ];
		return table;

	};

	const packTexture = ( texture ) => {

		if ( textureIds.has( texture ) ) return textureIds.get( texture );

		// Either encoded bytes waiting to be decoded (USD), or an image a loader already produced
		// (glTF: an ImageBitmap in a worker, an <img> on the main thread). A bitmap decoded for
		// USD is flipped already; a loader's image keeps the texture's own flipY.
		let data = texture.userData?.pendingImage;
		let flipY = false;

		if ( ! data && texture.image && ( typeof texture.image.close === 'function' || texture.image.nodeName ) ) {

			data = texture.image;
			flipY = texture.flipY;

		}

		if ( ! data ) return - 1; // data textures and the like are left out

		if ( ! imageIds.has( data ) ) {

			imageIds.set( data, imageIds.size );
			images.set( imageIds.get( data ), data );

		}

		textures.push( { image: imageIds.get( data ), ...textureProps( texture, flipY ) } );
		textureIds.set( texture, textures.length - 1 );
		return textures.length - 1;

	};

	root.traverse( ( object ) => {

		const geometry = object.geometry;

		// Parametric geometry (boxes, spheres) serialises as a few numbers; only raw buffers need moving.
		if ( geometry && geometry.type === 'BufferGeometry' ) {

			if ( ! geometries[ geometry.uuid ] ) {

				geometries[ geometry.uuid ] = extractGeometry( geometry );
				const stand = new THREE.BufferGeometry();
				stand.uuid = geometry.uuid;
				stand.name = geometry.name;
				placeholders.set( geometry.uuid, stand );

			}

			object.geometry = placeholders.get( geometry.uuid );
			restore.push( () => { object.geometry = geometry; } );

		}

		if ( object.isInstancedMesh ) {

			const entry = { matrix: attributeData( object.instanceMatrix ), color: object.instanceColor ? attributeData( object.instanceColor ) : null };
			instanced[ object.uuid ] = entry;
			const matrix = object.instanceMatrix;
			const colour = object.instanceColor;
			object.instanceMatrix = new THREE.InstancedBufferAttribute( new Float32Array( 16 ), 16 );
			if ( colour ) object.instanceColor = new THREE.InstancedBufferAttribute( new Float32Array( 3 ), 3 );
			restore.push( () => {

				object.instanceMatrix = matrix;
				object.instanceColor = colour;

			} );

		}

		if ( object.isLight ) colors[ object.uuid ] = colourTable( object );

		for ( const material of materialsOf( object ) ) {

			if ( seenMaterials.has( material ) ) continue;
			seenMaterials.add( material );
			colors[ material.uuid ] = colourTable( material );

			for ( const [ slot, value ] of Object.entries( material ) ) {

				if ( ! value?.isTexture ) continue;
				const texture = packTexture( value );
				if ( texture >= 0 ) textureSlots.push( { material: material.uuid, slot, texture } );
				material[ slot ] = null;
				restore.push( () => { material[ slot ] = value; } );

			}

		}

	} );

	let scene;

	try {

		scene = root.toJSON();

	} finally {

		for ( const undo of restore ) undo();

	}

	return { scene, geometries, instanced, colors, textures, textureSlots, images };

}

/** Every ArrayBuffer inside a packed scene, for postMessage's transfer list. */
export function transferListOf( packed ) {

	const buffers = new Set();
	const add = ( data ) => data?.array && buffers.add( data.array.buffer );

	for ( const g of Object.values( packed.geometries ) ) {

		Object.values( g.attributes ).forEach( add );
		add( g.index );
		Object.values( g.morph || {} ).forEach( ( list ) => list.forEach( add ) );

	}

	for ( const i of Object.values( packed.instanced ) ) {

		add( i.matrix );
		add( i.color );

	}

	return [ ...buffers ];

}

/**
 * Rebuilds the scene.
 * @param {object} packed  what packScene returned (after posting)
 * @param {Map<number, ImageBitmap|HTMLImageElement|null>} bitmaps  decoded images by image id
 */
export function unpackScene( packed, bitmaps = new Map() ) {

	const root = new THREE.ObjectLoader().parse( packed.scene );
	const filled = new Set();
	const materials = new Map();
	const textureCache = new Map();

	const attribute = ( data, Type = THREE.BufferAttribute ) => new Type( data.array, data.itemSize, data.normalized );

	const texture = ( index ) => {

		if ( textureCache.has( index ) ) return textureCache.get( index );

		const d = packed.textures[ index ];
		const image = bitmaps.get( d.image );
		let result = null;

		if ( image ) {

			result = new THREE.Texture( image );
			result.wrapS = d.wrapS;
			result.wrapT = d.wrapT;
			result.colorSpace = d.colorSpace;
			result.channel = d.channel;
			result.rotation = d.rotation;
			result.repeat.fromArray( d.repeat );
			result.offset.fromArray( d.offset );
			result.center.fromArray( d.center );
			result.userData = { ...d.userData };
			result.flipY = d.flipY;
			result.magFilter = d.magFilter;
			result.minFilter = d.minFilter;
			result.needsUpdate = true;

		}

		textureCache.set( index, result );
		return result;

	};

	root.traverse( ( object ) => {

		const geometry = object.geometry;
		const data = geometry && packed.geometries[ geometry.uuid ];

		if ( data && ! filled.has( geometry ) ) {

			filled.add( geometry );
			for ( const [ name, a ] of Object.entries( data.attributes ) ) geometry.setAttribute( name, attribute( a ) );
			if ( data.index ) geometry.setIndex( new THREE.BufferAttribute( data.index.array, 1 ) );
			data.groups.forEach( ( g ) => geometry.addGroup( g.start, g.count, g.materialIndex ) );

			if ( data.morph ) {

				for ( const [ name, list ] of Object.entries( data.morph ) ) geometry.morphAttributes[ name ] = list.map( ( a ) => attribute( a ) );
				geometry.morphTargetsRelative = data.morphTargetsRelative;

			}

		}

		const inst = object.isInstancedMesh && packed.instanced[ object.uuid ];

		if ( inst ) {

			object.instanceMatrix = attribute( inst.matrix, THREE.InstancedBufferAttribute );
			if ( inst.color ) object.instanceColor = attribute( inst.color, THREE.InstancedBufferAttribute );
			object.computeBoundingBox();
			object.computeBoundingSphere();

		}

		for ( const [ key, rgb ] of Object.entries( packed.colors[ object.uuid ] || {} ) ) object[ key ]?.setRGB( ...rgb, THREE.LinearSRGBColorSpace );

		for ( const material of materialsOf( object ) ) {

			if ( materials.has( material.uuid ) ) continue;
			materials.set( material.uuid, material );

			for ( const [ key, rgb ] of Object.entries( packed.colors[ material.uuid ] || {} ) ) {

				if ( isPlain( material[ key ] ) && material[ key ].isColor ) material[ key ].setRGB( ...rgb, THREE.LinearSRGBColorSpace );

			}

		}

	} );

	for ( const slot of packed.textureSlots ) {

		const material = materials.get( slot.material );
		const t = material && texture( slot.texture );
		if ( t ) {

			material[ slot.slot ] = t;
			material.needsUpdate = true;

		}

	}

	return root;

}
