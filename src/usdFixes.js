import { Color, SRGBColorSpace, NoColorSpace, Vector2 } from 'three';
import { USDCParser } from 'three/addons/loaders/usd/USDCParser.js';
import { USDAParser } from 'three/addons/loaders/usd/USDAParser.js';
import { USDComposer } from 'three/addons/loaders/usd/USDComposer.js';

/**
 * Fixes and additions for three.js' USD loader. Imported once, before any USD
 * file is parsed; affects both geometry loading and metadata reading.
 *
 * - Binary (crate) files: inline double/half vectors, string arrays,
 *   dictionaries, references, payloads and sublayers were not decoded.
 * - Text files: only "prepend references" / "payload" were recognised.
 * - Composer: every reference and payload is followed, not just the first.
 * - Materials: NVIDIA Omniverse MDL shaders (OmniPBR, OmniSurface, OmniGlass).
 */

// ============================================================================ crate types

const T = {
	Bool: 1,
	UChar: 2,
	String: 10,
	Vec2d: 19,
	Vec3d: 23,
	Vec3h: 25,
	Vec4d: 27,
	Vec4h: 29,
	Dictionary: 31,
	ReferenceListOp: 35,
	Payload: 47,
	LayerOffsetVector: 49,
	StringVector: 50,
	PayloadListOp: 55,
};

// Crate inlines small vectors as one signed byte per component. three.js
// handles float/int vectors but not double or half ones, so a translate of
// (0, 45, 0) authored by Pixar's tools arrives as a single number.
const INT8_INLINED_VECTORS = { [ T.Vec2d ]: 2, [ T.Vec3d ]: 3, [ T.Vec3h ]: 3, [ T.Vec4d ]: 4, [ T.Vec4h ]: 4 };

/** Minimal stand-in for the parser's internal ValueRep class. */
export class CrateRep {

	constructor( lo, hi ) {

		this.lo = lo;
		this.hi = hi;

	}

	get isArray() {

		return ( this.hi & 0x80000000 ) !== 0;

	}

	get isInlined() {

		return ( this.hi & 0x40000000 ) !== 0;

	}

	get isCompressed() {

		return ( this.hi & 0x20000000 ) !== 0;

	}

	get typeEnum() {

		return ( this.hi >> 16 ) & 0xFF;

	}

	get payload() {

		return this.lo + ( ( this.hi & 0xFFFF ) * 0x100000000 );

	}

	getInlinedValue() {

		return this.lo;

	}

}

const proto = USDCParser.prototype;
const readInlinedValue = proto._readInlinedValue;
const readArrayValue = proto._readArrayValue;
const readScalarValue = proto._readScalarValue;

proto._crateString = function ( index ) {

	return this.tokens[ this.strings[ index ] ];

};

proto._readInlinedValue = function ( valueRep ) {

	const count = INT8_INLINED_VECTORS[ valueRep.typeEnum ];
	if ( ! count ) return readInlinedValue.call( this, valueRep );

	const payload = valueRep.getInlinedValue();
	const out = [];

	for ( let i = 0; i < count; i ++ ) {

		const byte = ( payload >>> ( i * 8 ) ) & 0xFF;
		out.push( byte > 127 ? byte - 256 : byte );

	}

	return out;

};

proto._readArrayValue = function ( valueRep ) {

	const type = valueRep.typeEnum;
	if ( ( type !== T.String && type !== T.UChar && type !== T.Bool ) || valueRep.isCompressed ) return readArrayValue.call( this, valueRep );

	const reader = this.reader;
	const size = this.version.major === 0 && this.version.minor < 7 ? reader.readUint32() : reader.readUint64();

	if ( type === T.String ) {

		const out = [];
		for ( let i = 0; i < size; i ++ ) out.push( this._crateString( reader.readUint32() ) );
		return out;

	}

	// uchar[] / bool[]: one byte each.
	const out = new Uint8Array( size );
	for ( let i = 0; i < size; i ++ ) out[ i ] = reader.readUint8();
	return type === T.Bool ? Array.from( out, Boolean ) : out;

};

proto._readScalarValue = function ( type ) {

	switch ( type ) {

		case T.Dictionary: return this._readCrateDictionary();
		case T.StringVector: return this._readCrateStringVector();
		case T.LayerOffsetVector: return this._readCrateLayerOffsets();
		case T.ReferenceListOp: return this._readCrateListOp( () => this._readCrateReference() );
		case T.PayloadListOp: return this._readCrateListOp( () => this._readCratePayload() );
		case T.Payload: return this._readCratePayload();
		default: return readScalarValue.call( this, type );

	}

};

proto._readCrateDictionary = function () {

	// Each entry: key (string index), then an int64 offset to the value's ValueRep.
	// Out-of-line value data sits between the offset and the rep; the next entry
	// starts right after the rep.
	const reader = this.reader;
	const count = reader.readUint64();
	const dict = {};

	for ( let i = 0; i < count; i ++ ) {

		const key = this._crateString( reader.readUint32() );
		const offsetPos = reader.tell();
		const offset = reader.readInt64();

		reader.seek( offsetPos + offset );
		const rep = new CrateRep( reader.readUint32(), reader.readUint32() );
		const after = reader.tell();
		let value = null;

		try {

			value = this._readValue( rep );

		} catch {

			value = null;

		}

		reader.seek( after );
		if ( key !== undefined ) dict[ key ] = value;

	}

	return dict;

};

proto._readCrateStringVector = function () {

	const reader = this.reader;
	const n = reader.readUint64();
	const out = [];
	for ( let i = 0; i < n; i ++ ) out.push( this._crateString( reader.readUint32() ) );
	return out;

};

proto._readCrateLayerOffsets = function () {

	const reader = this.reader;
	const n = reader.readUint64();
	const out = [];
	for ( let i = 0; i < n; i ++ ) out.push( { offset: reader.readFloat64(), scale: reader.readFloat64() } );
	return out;

};

proto._readCrateReference = function () {

	const reader = this.reader;
	const assetPath = this._crateString( reader.readUint32() ) || '';
	const primPath = this.paths[ reader.readUint32() ] || '';
	reader.readFloat64(); // layer offset
	reader.readFloat64(); // layer scale
	this._readCrateDictionary(); // customData
	return { assetPath, primPath };

};

proto._readCratePayload = function () {

	const reader = this.reader;
	const assetPath = this._crateString( reader.readUint32() ) || '';
	const primPath = this.paths[ reader.readUint32() ] || '';

	// Layer offsets were added to payloads in crate 0.8.
	if ( this.version.major > 0 || this.version.minor >= 8 ) {

		reader.readFloat64();
		reader.readFloat64();

	}

	return { assetPath, primPath };

};

/** List ops: header bitmask, then Explicit, Add, Prepend, Append, Delete, Reorder lists. */
proto._readCrateListOp = function ( readItem ) {

	const reader = this.reader;
	const flags = reader.readUint8();
	const readList = () => {

		const n = reader.readUint64();
		const items = [];
		for ( let i = 0; i < n; i ++ ) items.push( readItem() );
		return items;

	};

	const items = [];
	if ( flags & 0x02 ) items.push( ...readList() );
	if ( flags & 0x04 ) items.push( ...readList() );
	if ( flags & 0x20 ) items.push( ...readList() );
	if ( flags & 0x40 ) items.push( ...readList() );
	if ( flags & 0x08 ) readList();
	if ( flags & 0x10 ) readList();

	// Same shape the composer reads from text files: one "@a@<p>, @b@" string.
	const refs = items.filter( ( r ) => r.assetPath ).map( ( r ) => `@${ r.assetPath }@${ r.primPath ? `<${ r.primPath }>` : '' }` );
	return refs.length ? [ refs.join( ', ' ) ] : [];

};

// ============================================================================ text files

const extractPrimData = USDAParser.prototype._extractPrimData;

USDAParser.prototype._extractPrimData = function ( data, path, primFields, specsByPath, SpecType ) {

	if ( data && typeof data === 'object' ) {

		// "references", "append references", "prepend payload", ... → the two keys the parser knows.
		for ( const key of Object.keys( data ) ) {

			const m = key.match( /^(?:(?:prepend|append|add)\s+)?(references|payload)$/ );
			if ( ! m || key === 'prepend references' || key === 'payload' ) continue;
			const target = m[ 1 ] === 'references' ? 'prepend references' : 'payload';
			data[ target ] = data[ target ] ? `${ data[ target ] }, ${ data[ key ] }` : data[ key ];

		}

	}

	return extractPrimData.call( this, data, path, primFields, specsByPath, SpecType );

};

// ============================================================================ composer

const composerProto = USDComposer.prototype;

/** Every reference and payload on a prim (three.js used the first reference, else the payload). */
composerProto._getReferences = function ( spec ) {

	const results = [];
	const collect = ( value ) => {

		if ( ! value ) return;
		if ( Array.isArray( value ) ) return value.forEach( collect );
		if ( typeof value === 'string' ) {

			for ( const m of value.matchAll( /@([^@]+)@(?:<([^>]+)>)?/g ) ) results.push( m[ 0 ] );
			return;

		}

		if ( value.assetPath ) results.push( `@${ value.assetPath }@${ value.primPath ? `<${ value.primPath }>` : '' }` );

	};

	collect( spec.fields.references );
	collect( spec.fields.payload );
	return [ ...new Set( results ) ];

};

// ---------------------------------------------------------------- MDL materials

const applyMaterial = composerProto._applyMaterial;

composerProto._applyMaterial = function ( material, materialPath ) {

	applyMaterial.call( this, material, materialPath );

	const shaderPaths = this.shadersByMaterialPath?.get( materialPath );
	if ( ! shaderPaths ) return;

	let hasPreview = false;
	let mdl = null;

	for ( const path of shaderPaths ) {

		const attrs = this._getAttributes( path );
		const id = attrs[ 'info:id' ] || this.specsByPath[ path ]?.fields[ 'info:id' ];
		if ( id === 'UsdPreviewSurface' || id === 'ND_UsdPreviewSurface_surfaceshader' || id === 'arnold:openpbr_surface' ) hasPreview = true;
		const source = attrs[ 'info:mdl:sourceAsset' ] || attrs[ 'info:mdl:sourceAsset:subIdentifier' ];
		if ( source ) mdl = { path, attrs };

	}

	// Omniverse materials often carry both; a UsdPreviewSurface wins when present.
	if ( mdl && ! hasPreview ) applyMdl( this, material, mdl.attrs );

};

function cleanAsset( v ) {

	if ( ! v ) return '';
	return String( v ).replace( /^@|@$/g, '' ).trim();

}

function setColor( color, value ) {

	if ( ! Array.isArray( value ) && ! ArrayBuffer.isView( value ) ) return false;
	color.setRGB( value[ 0 ], value[ 1 ], value[ 2 ], SRGBColorSpace );
	return true;

}

function applyMdl( composer, material, attrs ) {

	const name = cleanAsset( attrs[ 'info:mdl:sourceAsset:subIdentifier' ] || attrs[ 'info:mdl:sourceAsset' ] ).replace( /\.mdl$/i, '' ).split( '/' ).pop();
	const input = ( key ) => attrs[ `inputs:${ key }` ];
	const texture = ( key, colorSpace ) => {

		const file = cleanAsset( input( key ) );
		if ( ! file ) return null;
		const tex = composer._loadTexture( file, null, null );
		if ( tex ) tex.colorSpace = colorSpace;
		return tex;

	};

	const on = ( key, fallback = false ) => ( input( key ) === undefined ? fallback : !! input( key ) );
	const num = ( key, fallback ) => ( typeof input( key ) === 'number' ? input( key ) : fallback );

	material.userData.mdl = name;

	if ( /glass/i.test( name ) ) {

		// OmniGlass
		setColor( material.color, input( 'glass_color' ) );
		material.transmission = 1;
		material.thickness = 0.01;
		material.ior = num( 'glass_ior', 1.5 );
		material.roughness = num( 'frosting_roughness', 0 );
		material.metalness = 0;
		material.transparent = true;
		return;

	}

	if ( /surface/i.test( name ) ) {

		// OmniSurface / OmniSurfaceBase
		setColor( material.color, input( 'diffuse_reflection_color' ) );
		material.map = texture( 'diffuse_reflection_color_image', SRGBColorSpace ) || material.map;
		material.metalness = num( 'metalness', material.metalness );
		material.roughness = num( 'specular_reflection_roughness', material.roughness );
		if ( num( 'emission_weight', 0 ) > 0 && setColor( material.emissive, input( 'emission_color' ) ) ) material.emissiveIntensity = Math.min( 5, num( 'emission_weight', 1 ) );
		if ( on( 'enable_opacity' ) ) {

			material.opacity = num( 'geometry_opacity', 1 );
			material.transparent = material.opacity < 1;

		}

		return;

	}

	// OmniPBR and its variants (OmniPBR_ClearCoat, OmniPBR_Opacity, ...)
	setColor( material.color, input( 'diffuse_color_constant' ) );
	const tint = input( 'diffuse_tint' );
	const map = texture( 'diffuse_texture', SRGBColorSpace );
	if ( map ) {

		material.map = map;
		// OmniPBR multiplies the texture by the tint, not by the constant colour.
		material.color.set( 0xffffff );
		if ( tint ) setColor( material.color, tint );

	}

	material.roughness = num( 'reflection_roughness_constant', 0.5 );
	material.metalness = num( 'metallic_constant', 0 );

	if ( on( 'enable_ORM_texture' ) ) {

		const orm = texture( 'ORM_texture', NoColorSpace );
		if ( orm ) {

			material.aoMap = orm;
			material.roughnessMap = orm;
			material.metalnessMap = orm;
			material.roughness = 1;
			material.metalness = 1;

		}

	} else {

		const rough = texture( 'reflectionroughness_texture', NoColorSpace );
		if ( rough ) {

			material.roughnessMap = rough;
			material.roughness = num( 'reflection_roughness_texture_influence', 1 ) > 0 ? 1 : material.roughness;

		}

		const metal = texture( 'metallic_texture', NoColorSpace );
		if ( metal ) {

			material.metalnessMap = metal;
			material.metalness = num( 'metallic_texture_influence', 1 ) > 0 ? 1 : material.metalness;

		}

	}

	const normal = texture( 'normalmap_texture', NoColorSpace );
	if ( normal ) {

		material.normalMap = normal;
		const s = num( 'bump_factor', 1 );
		material.normalScale = new Vector2( s, s );

	}

	if ( on( 'enable_emission' ) ) {

		setColor( material.emissive, input( 'emissive_color' ) || [ 1, 1, 1 ] );
		material.emissiveMap = texture( 'emissive_color_texture', SRGBColorSpace ) || null;
		// Omniverse intensities are physical (default 40); map them to a 0–5 range.
		material.emissiveIntensity = Math.min( 5, num( 'emissive_intensity', 40 ) / 40 );

	}

	if ( on( 'enable_opacity' ) ) {

		material.opacity = num( 'opacity_constant', 1 );
		const alpha = texture( 'opacity_texture', NoColorSpace );
		if ( alpha ) material.alphaMap = alpha;
		material.transparent = material.opacity < 1 || !! alpha;
		if ( num( 'opacity_threshold', 0 ) > 0 ) material.alphaTest = num( 'opacity_threshold', 0 );

	}

	if ( input( 'clearcoat_weight' ) !== undefined ) {

		material.clearcoat = num( 'clearcoat_weight', 0 );
		material.clearcoatRoughness = num( 'clearcoat_reflection_roughness', 0 );

	}

	if ( ! material.color ) material.color = new Color( 1, 1, 1 );

}
