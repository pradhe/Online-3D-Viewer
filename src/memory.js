
/**
 * Keeps a model within what the device can hold: measures it, caps and shrinks textures, and
 * releases everything when the model is replaced. Sizes are estimates of CPU + GPU memory.
 */

export const MB = 1048576;

const texturesOf = ( material ) => Object.values( material ).filter( ( v ) => v?.isTexture );
const materialsOf = ( object ) => ( object.material ? ( Array.isArray( object.material ) ? object.material : [ object.material ] ) : [] );

/** Bytes of one decoded image, with the mip chain the GPU adds. */
export function textureBytes( texture ) {

	const image = texture.image;
	if ( ! image ) return 0;
	const w = image.width || image.videoWidth || 0;
	const h = image.height || image.videoHeight || 0;
	return Math.round( w * h * 4 * ( texture.generateMipmaps === false ? 1 : 4 / 3 ) );

}

/** The device limits, from what the browser tells us (deviceMemory is Chromium-only). */
export function deviceLimits( { maxTextureSize = 8192, override } = {} ) {

	const nav = typeof navigator === 'undefined' ? {} : navigator;
	const memoryGB = nav.deviceMemory || 0; // 0 = unknown
	const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test( nav.userAgent || '' ) || ( nav.maxTouchPoints > 1 && /Mac/.test( nav.platform || '' ) );

	let budget = memoryGB ? Math.min( memoryGB * 0.25, 2 ) * 1024 * MB : 1536 * MB;
	if ( mobile ) budget = Math.min( budget, 640 * MB );
	if ( override ) budget = override * MB;

	const small = mobile || ( memoryGB && memoryGB <= 4 );

	return {
		budget,
		// Beyond this the browser would very likely crash the tab, so the load is refused.
		hardLimit: Math.min( budget * 4, 3072 * MB ),
		maxTextureSize: Math.min( maxTextureSize, small ? 2048 : 4096 ),
		mobile,
	};

}

/** Memory and complexity of a scene. Shared geometry and textures count once. */
export function measureScene( root ) {

	const geometries = new Set();
	const textures = new Set();
	const out = { triangles: 0, vertices: 0, geometryBytes: 0, textureBytes: 0, textures: [], meshes: 0 };

	const buffers = new Set(); // an interleaved buffer is shared by several attributes

	const addAttribute = ( a ) => {

		const array = a?.isInterleavedBufferAttribute ? a.data.array : a?.array;
		if ( ! array || buffers.has( array ) ) return;
		buffers.add( array );
		out.geometryBytes += array.byteLength;

	};

	root.traverse( ( object ) => {

		const g = object.geometry;

		if ( g && ! geometries.has( g ) ) {

			geometries.add( g );
			Object.values( g.attributes ).forEach( addAttribute );
			addAttribute( g.index );
			Object.values( g.morphAttributes ).forEach( ( list ) => list.forEach( addAttribute ) );

		}

		if ( object.isMesh && g ) {

			const copies = object.isInstancedMesh ? object.count : 1;
			const position = g.attributes.position;
			out.meshes ++;
			out.vertices += ( position?.count || 0 ) * copies;
			out.triangles += Math.floor( ( g.index ? g.index.count : ( position?.count || 0 ) ) / 3 ) * copies;
			if ( object.isInstancedMesh ) addAttribute( object.instanceMatrix );

		}

		for ( const material of materialsOf( object ) ) {

			for ( const t of texturesOf( material ) ) {

				if ( textures.has( t ) ) continue;
				textures.add( t );
				const bytes = textureBytes( t );
				out.textureBytes += bytes;
				out.textures.push( { texture: t, bytes } );

			}

		}

	} );

	out.totalBytes = out.geometryBytes + out.textureBytes;
	return out;

}

/** Resizes an image (bitmap, canvas or <img>) to fit `max` pixels on its longer side. */
async function resized( image, max ) {

	const scale = max / Math.max( image.width, image.height );
	const width = Math.max( 1, Math.round( image.width * scale ) );
	const height = Math.max( 1, Math.round( image.height * scale ) );

	if ( typeof createImageBitmap === 'function' ) {

		return createImageBitmap( image, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high', premultiplyAlpha: 'none', imageOrientation: 'none' } );

	}

	return null;

}

async function shrink( texture, max ) {

	const next = await resized( texture.image, max ).catch( () => null );
	if ( ! next ) return false;
	texture.image?.close?.();
	texture.image = next;
	texture.needsUpdate = true;
	return true;

}

/**
 * Brings textures within `maxTextureSize`, then halves the largest ones until the whole scene
 * fits `budget`. Geometry cannot be reduced, so it is reported rather than changed.
 * @returns {Promise<{ before: object, after: object, capped: number, halved: number }>}
 */
export async function fitToBudget( root, { budget, maxTextureSize } ) {

	const before = measureScene( root );
	let capped = 0;
	let halved = 0;

	for ( const { texture } of before.textures ) {

		const image = texture.image;
		if ( image && Math.max( image.width, image.height ) > maxTextureSize && await shrink( texture, maxTextureSize ) ) capped ++;

	}

	let now = measureScene( root );

	for ( let guard = 0; now.totalBytes > budget && guard < 200; guard ++ ) {

		const largest = now.textures.reduce( ( a, b ) => ( b.bytes > a.bytes ? b : a ), { bytes: 0 } );
		const image = largest.texture?.image;
		if ( ! image || Math.max( image.width, image.height ) <= 256 ) break; // nothing sensible left to shrink
		if ( ! await shrink( largest.texture, Math.max( image.width, image.height ) / 2 ) ) break;
		halved ++;
		now = measureScene( root );

	}

	return { before, after: now, capped, halved };

}

/** Frees everything a scene holds: GPU buffers and textures, and decoded images on the CPU side. */
export function disposeObject( root ) {

	const seen = new Set();
	const once = ( thing, fn ) => {

		if ( thing && ! seen.has( thing ) ) {

			seen.add( thing );
			fn( thing );

		}

	};

	root.traverse( ( object ) => {

		once( object.geometry, ( g ) => g.dispose() );
		if ( object.isInstancedMesh ) object.dispose();
		once( object.skeleton, ( s ) => s.dispose() );

		for ( const material of materialsOf( object ) ) {

			once( material, ( m ) => {

				for ( const t of texturesOf( m ) ) {

					once( t, ( tex ) => {

						tex.dispose();
						// Decoded bitmaps live outside the JS heap until closed.
						tex.image?.close?.();

					} );

				}

				m.dispose();

			} );

		}

	} );

}

/** "1.2 GB" / "340 MB" */
export function formatMemory( bytes ) {

	return bytes >= 1024 * MB ? `${ ( bytes / 1024 / MB ).toFixed( 1 ) } GB` : `${ Math.round( bytes / MB ) } MB`;

}

