import { USDAParser } from 'three/addons/loaders/usd/USDAParser.js';
import { USDCParser } from 'three/addons/loaders/usd/USDCParser.js';
import { unzipSync } from 'three/addons/libs/fflate.module.js';
import './usdFixes.js';

/**
 * Reads USD metadata that three.js' USDLoader drops while building geometry:
 * stage metadata, prim metadata (kind, doc, customData, assetInfo, API schemas…),
 * attributes and relationships. Works for .usda, .usdc and .usdz.
 *
 * Result:
 *   {
 *     stage: [ [ key, value ] ],
 *     prims: Map< path, { path, name, type, specifier, metadata: [ [ key, value ] ],
 *                         attributes: [ { name, type, value, custom, uniform, animated, connection } ],
 *                         relationships: [ { name, targets: [ path ] } ] } >
 *   }
 */

const MAX_VALUE_CHARS = 160;
const LIST_OPS = [ 'prepend', 'append', 'add', 'delete', 'reorder' ];

// Crate (USDC) type enums used below.
const T_DICTIONARY = 31;
const T_TOKEN_LIST_OP = 32;
const T_STRING_LIST_OP = 33;

/** Minimal stand-in for the parser's internal ValueRep class. */
class Rep {

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

/**
 * USDCParser skips the value types that only matter for metadata
 * (dictionaries, token/string list ops). Decode them here.
 */
class MetadataUSDCParser extends USDCParser {

	_readScalarValue( type ) {

		if ( type === T_DICTIONARY ) return this._readDictionary();
		if ( type === T_TOKEN_LIST_OP || type === T_STRING_LIST_OP ) return this._readNameListOp( type === T_STRING_LIST_OP );
		return super._readScalarValue( type );

	}

	_readDictionary() {

		const reader = this.reader;
		const count = reader.readUint64();
		const dict = {};

		for ( let i = 0; i < count; i ++ ) {

			// Each entry: key (string index), then an int64 offset to the value's ValueRep.
			// Out-of-line value data sits between the offset and the rep; the next entry
			// starts right after the rep.
			const key = this.tokens[ this.strings[ reader.readUint32() ] ];
			const offsetPos = reader.tell();
			const offset = reader.readInt64();

			reader.seek( offsetPos + offset );
			const rep = new Rep( reader.readUint32(), reader.readUint32() );
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

	}

	_readNameListOp( isString ) {

		const reader = this.reader;
		const flags = reader.readUint8();
		const name = ( idx ) => ( isString ? this.tokens[ this.strings[ idx ] ] : this.tokens[ idx ] );
		const readList = () => {

			const n = reader.readUint64();
			const list = [];
			for ( let i = 0; i < n; i ++ ) list.push( name( reader.readUint32() ) );
			return list;

		};

		const op = {};
		if ( flags & 0x02 ) op.explicit = readList();
		if ( flags & 0x04 ) op.add = readList();
		if ( flags & 0x20 ) op.prepend = readList();
		if ( flags & 0x40 ) op.append = readList();
		if ( flags & 0x08 ) op.delete = readList();
		if ( flags & 0x10 ) op.reorder = readList();
		return op;

	}

}

// ------------------------------------------------------------------ formatting

function clip( s ) {

	return s.length > MAX_VALUE_CHARS ? s.slice( 0, MAX_VALUE_CHARS - 1 ) + '…' : s;

}

function fmtNumber( n ) {

	if ( typeof n !== 'number' ) return String( n );
	if ( Number.isInteger( n ) ) return String( n );
	return String( + n.toPrecision( 6 ) );

}

function tupleSize( typeName = '' ) {

	const base = typeName.replace( '[]', '' );
	if ( /matrix4d/.test( base ) ) return 16;
	if ( /matrix3d/.test( base ) ) return 9;
	if ( /matrix2d/.test( base ) ) return 4;
	if ( /quat/.test( base ) ) return 4;
	const m = base.match( /(\d)[fdhi]?$/ );
	return m && /^(float|double|half|int|color|normal|point|vector|texCoord)/.test( base ) ? Number( m[ 1 ] ) : 1;

}

/** Formats a parsed (USDC) value for display. */
function formatValue( value, typeName = '' ) {

	if ( value === null || value === undefined ) return '—';
	if ( typeof value === 'boolean' ) return value ? 'true' : 'false';
	if ( typeof value === 'number' ) return /bool/.test( typeName ) ? ( value ? 'true' : 'false' ) : fmtNumber( value );
	if ( typeof value === 'string' ) return clip( value );

	if ( Array.isArray( value ) || ArrayBuffer.isView( value ) ) {

		const arr = Array.from( value );
		const isArrayType = typeName.endsWith( '[]' );
		const size = tupleSize( typeName );

		if ( isArrayType ) {

			const count = size > 1 ? Math.floor( arr.length / size ) : arr.length;
			if ( count > 6 ) return `${ count.toLocaleString() } items`;
			if ( size > 1 ) {

				const tuples = [];
				for ( let i = 0; i < count; i ++ ) tuples.push( '(' + arr.slice( i * size, i * size + size ).map( fmtNumber ).join( ', ' ) + ')' );
				return clip( '[' + tuples.join( ', ' ) + ']' );

			}

			return clip( '[' + arr.map( ( v ) => ( typeof v === 'string' ? v : fmtNumber( v ) ) ).join( ', ' ) + ']' );

		}

		if ( arr.length > 16 ) return `${ arr.length.toLocaleString() } values`;
		return clip( '(' + arr.map( ( v ) => ( typeof v === 'string' ? v : fmtNumber( v ) ) ).join( ', ' ) + ')' );

	}

	if ( typeof value === 'object' ) {

		// List op: { prepend: [...], append: [...] }
		const keys = Object.keys( value );
		if ( keys.length && keys.every( ( k ) => [ 'explicit', ...LIST_OPS ].includes( k ) ) ) {

			return clip( keys.map( ( k ) => ( k === 'explicit' ? '' : k + ' ' ) + value[ k ].join( ', ' ) ).join( '; ' ) );

		}

		try {

			return clip( JSON.stringify( value ) );

		} catch {

			return '[object]';

		}

	}

	return clip( String( value ) );

}

/** Formats a raw USDA value string (as the text parser keeps it). */
function formatRaw( raw, typeName = '' ) {

	if ( raw === undefined || raw === null ) return '—';
	if ( typeof raw === 'object' ) return formatValue( raw, typeName );

	let s = String( raw ).trim();
	if ( /^"(?:[^"\\]|\\.)*"$/.test( s ) ) return clip( s.slice( 1, - 1 ) );
	if ( /^@[^@]*@$/.test( s ) ) return clip( s.slice( 1, - 1 ) );
	if ( /bool/.test( typeName ) && ( s === '1' || s === '0' ) ) return s === '1' ? 'true' : 'false';

	if ( s.startsWith( '[' ) && s.endsWith( ']' ) ) {

		const count = countTopLevel( s.slice( 1, - 1 ) );
		if ( count > 6 ) return `${ count.toLocaleString() } items`;
		s = s.replace( /"/g, '' );

	}

	return clip( s );

}

function countTopLevel( inner ) {

	if ( ! inner.trim() ) return 0;
	let depth = 0;
	let count = 1;
	let inString = false;

	for ( const ch of inner ) {

		if ( ch === '"' ) inString = ! inString;
		if ( inString ) continue;
		if ( ch === '(' || ch === '[' || ch === '{' ) depth ++;
		else if ( ch === ')' || ch === ']' || ch === '}' ) depth --;
		else if ( ch === ',' && depth === 0 ) count ++;

	}

	return count;

}

function rawTargets( raw ) {

	if ( typeof raw !== 'string' ) return [];
	return [ ...raw.matchAll( /<([^>]+)>/g ) ].map( ( m ) => m[ 1 ] );

}

function flattenDict( prefix, dict, out, isRaw ) {

	for ( const [ k, v ] of Object.entries( dict || {} ) ) {

		// USDA dictionary keys look like "string owner"; keep just the name.
		const name = isRaw ? k.replace( /^\S+\s+/, '' ) : k;
		if ( v && typeof v === 'object' && ! Array.isArray( v ) && ! ArrayBuffer.isView( v ) ) flattenDict( `${ prefix }.${ name }`, v, out, isRaw );
		else out.push( [ `${ prefix }.${ name }`, isRaw ? formatRaw( v, k.split( /\s+/ )[ 0 ] ) : formatValue( v ) ] );

	}

}

function newPrim( path, type = '', specifier = 'def' ) {

	return { path, name: path.split( '/' ).pop(), type, specifier, metadata: [], attributes: [], relationships: [] };

}

const STAGE_SKIP = new Set( [ 'primChildren' ] );
const PRIM_SKIP = new Set( [ 'specifier', 'typeName', 'primChildren', 'properties', 'variantSetChildren', 'variantChildren' ] );
const META_LABELS = { documentation: 'doc' };

// ------------------------------------------------------------------ USDA

const PRIM_KEY = /^(def|over|class)(?:\s+(\w+))?\s+"([^"]+)"$/;
const REL_KEY = /^(custom\s+)?(?:varying\s+)?rel\s+([\w:.\-]+)$/;
const ATTR_KEY = /^(custom\s+)?(uniform\s+|varying\s+|config\s+)?([A-Za-z]\w*(?:\[\])?)\s+([\w:.\-]+)$/;

function fromUsda( text ) {

	const tree = new USDAParser().parseText( text );
	const stage = [];
	const prims = new Map();

	const header = tree[ '#usda 1.0' ] || {};
	for ( const [ k, v ] of Object.entries( header ) ) {

		if ( v && typeof v === 'object' ) flattenDict( k, v, stage, true );
		else stage.push( [ k, formatRaw( v ) ] );

	}

	const walk = ( node, parentPath ) => {

		for ( const [ key, value ] of Object.entries( node ) ) {

			const m = key.match( PRIM_KEY );
			if ( ! m ) continue;

			const path = ( parentPath === '/' ? '' : parentPath ) + '/' + m[ 3 ];
			const prim = newPrim( path, m[ 2 ] || '', m[ 1 ] );
			prims.set( path, prim );
			readUsdaPrimBody( value, prim );
			walk( value, path );

		}

	};

	walk( tree, '/' );
	return { stage, prims };

}

function readUsdaPrimBody( body, prim ) {

	const attrs = new Map();

	for ( const [ key, value ] of Object.entries( body ) ) {

		if ( PRIM_KEY.test( key ) ) continue;

		const variantSet = key.match( /^variantSet\s+"([^"]+)"$/ );
		if ( variantSet ) {

			const options = Object.keys( value || {} ).map( ( k ) => k.replace( /"/g, '' ) );
			prim.metadata.push( [ `variantSet.${ variantSet[ 1 ] }`, options.join( ', ' ) ] );
			continue;

		}

		if ( key === 'variants' && value && typeof value === 'object' ) {

			flattenDict( 'variants', value, prim.metadata, true );
			continue;

		}

		const rel = key.match( REL_KEY );
		if ( rel ) {

			prim.relationships.push( { name: rel[ 2 ], targets: rawTargets( value ), custom: !! rel[ 1 ] } );
			continue;

		}

		const words = key.split( /\s+/ );

		if ( words.length === 2 && LIST_OPS.includes( words[ 0 ] ) ) {

			prim.metadata.push( [ words[ 1 ], `${ words[ 0 ] } ${ formatRaw( value ) }` ] );
			continue;

		}

		const attr = key.match( ATTR_KEY );
		if ( attr ) {

			let name = attr[ 4 ];
			let animated = false;
			let connection = null;

			if ( name.endsWith( '.timeSamples' ) ) {

				name = name.slice( 0, - '.timeSamples'.length );
				animated = true;

			} else if ( name.endsWith( '.connect' ) ) {

				name = name.slice( 0, - '.connect'.length );
				connection = rawTargets( value )[ 0 ] || formatRaw( value );

			}

			const entry = attrs.get( name ) || { name, type: attr[ 3 ], value: undefined, custom: !! attr[ 1 ], uniform: /uniform/.test( attr[ 2 ] || '' ), animated: false, connection: null };

			if ( animated ) {

				entry.animated = true;
				entry.samples = value && typeof value === 'object' ? Object.keys( value ).length : 0;

			} else if ( connection ) {

				entry.connection = connection;

			} else if ( value && typeof value === 'object' && ! Array.isArray( value ) ) {

				// Attribute with its own metadata block; keep the default if present.
				entry.value = formatRaw( value.default ?? '' );

			} else {

				entry.value = formatRaw( value, attr[ 3 ] );

			}

			attrs.set( name, entry );
			continue;

		}

		if ( words.length === 1 ) {

			const label = META_LABELS[ key ] || key;
			if ( value && typeof value === 'object' && ! Array.isArray( value ) ) flattenDict( label, value, prim.metadata, true );
			else prim.metadata.push( [ label, formatRaw( value ) ] );

		}

	}

	prim.attributes = [ ...attrs.values() ];

}

// ------------------------------------------------------------------ USDC

const SPECIFIERS = [ 'def', 'over', 'class' ];
const SPEC_RELATIONSHIP = 8;

function fromUsdc( buffer ) {

	const parser = new MetadataUSDCParser();
	const { specsByPath } = parser.parseData( buffer );
	const stage = [];
	const prims = new Map();

	const root = specsByPath[ '/' ]?.fields || {};
	for ( const [ k, v ] of Object.entries( root ) ) {

		if ( STAGE_SKIP.has( k ) ) continue;
		const label = META_LABELS[ k ] || k;
		if ( v && typeof v === 'object' && ! Array.isArray( v ) && ! ArrayBuffer.isView( v ) && ! isListOp( v ) ) flattenDict( label, v, stage, false );
		else stage.push( [ label, formatValue( v ) ] );

	}

	for ( const [ path, spec ] of Object.entries( specsByPath ) ) {

		if ( path === '/' || path.includes( '.' ) || path.includes( '{' ) ) continue;
		const f = spec.fields || {};
		if ( f.typeName === undefined && f.specifier === undefined ) continue;

		const prim = newPrim( path, f.typeName || '', SPECIFIERS[ f.specifier ] || 'def' );

		for ( const [ k, v ] of Object.entries( f ) ) {

			if ( PRIM_SKIP.has( k ) || v === null || v === undefined ) continue;
			const label = META_LABELS[ k ] || k;
			if ( v && typeof v === 'object' && ! Array.isArray( v ) && ! ArrayBuffer.isView( v ) && ! isListOp( v ) ) flattenDict( label, v, prim.metadata, false );
			else prim.metadata.push( [ label, formatValue( v ) ] );

		}

		for ( const prop of f.properties || [] ) {

			const ps = specsByPath[ `${ path }.${ prop }` ];
			if ( ! ps ) continue;
			const pf = ps.fields || {};

			if ( ps.specType === SPEC_RELATIONSHIP || pf.targetPaths !== undefined ) {

				prim.relationships.push( { name: prop, targets: listOpItems( pf.targetPaths ), custom: !! pf.custom } );
				continue;

			}

			prim.attributes.push( {
				name: prop,
				type: pf.typeName || '',
				value: pf.default !== undefined ? formatValue( unpackInlinedVector( pf.default, pf.typeName ), pf.typeName ) : undefined,
				custom: !! pf.custom,
				uniform: pf.variability === 1,
				animated: !! pf.timeSamples,
				samples: pf.timeSamples?.times?.length || 0,
				connection: listOpItems( pf.connectionPaths )[ 0 ] || null,
			} );

		}

		prims.set( path, prim );

	}

	return { stage, prims };

}

/**
 * Crate files store small vectors such as (0, 45, 0) inline as one int8 per
 * component; the base parser hands those back as a single packed number.
 */
function unpackInlinedVector( value, typeName = '' ) {

	const size = tupleSize( typeName );
	if ( typeof value !== 'number' || size < 2 || size > 4 || typeName.endsWith( '[]' ) ) return value;
	const out = [];
	for ( let i = 0; i < size; i ++ ) {

		const byte = ( value >>> ( i * 8 ) ) & 0xFF;
		out.push( byte > 127 ? byte - 256 : byte );

	}

	return out;

}

function isListOp( v ) {

	const keys = Object.keys( v || {} );
	return keys.length > 0 && keys.every( ( k ) => [ 'explicit', 'explicitItems', 'prepend', 'prependedItems', 'append', 'appendedItems', 'add', 'addedItems', 'delete', 'deletedItems', 'reorder', 'orderedItems' ].includes( k ) );

}

function listOpItems( v ) {

	if ( ! v ) return [];
	if ( Array.isArray( v ) ) return v;
	return Object.values( v ).filter( Array.isArray ).flat();

}

// ------------------------------------------------------------------ entry points

function isCrate( bytes ) {

	const magic = 'PXR-USDC';
	if ( bytes.length < magic.length ) return false;
	for ( let i = 0; i < magic.length; i ++ ) if ( bytes[ i ] !== magic.charCodeAt( i ) ) return false;
	return true;

}

function toArrayBuffer( bytes ) {

	return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.buffer.slice( bytes.byteOffset, bytes.byteOffset + bytes.byteLength );

}

function fromLayerBytes( bytes ) {

	return isCrate( bytes ) ? fromUsdc( toArrayBuffer( bytes ) ) : fromUsda( new TextDecoder().decode( bytes ) );

}

/** Extracts metadata from the bytes of a .usd/.usda/.usdc/.usdz file. */
export function extractUsdMetadata( buffer ) {

	const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array( buffer );

	if ( bytes[ 0 ] === 0x50 && bytes[ 1 ] === 0x4B ) {

		// USDZ: the first USD layer in the archive is the root layer.
		const files = unzipSync( bytes );
		const rootName = Object.keys( files ).find( ( n ) => /\.usd[ac]?$/i.test( n ) );
		if ( ! rootName ) return null;
		const meta = fromLayerBytes( files[ rootName ] );
		meta.stage.unshift( [ 'package.rootLayer', rootName ] );
		return meta;

	}

	return fromLayerBytes( bytes );

}

/** Tags each object of a loaded USD model with the path of the prim it came from. */
export function attachUsdPaths( model, meta ) {

	if ( ! meta ) return 0;
	let matched = 0;

	const visit = ( obj, path ) => {

		if ( meta.prims.has( path ) ) {

			obj.userData.usdPath = path;
			matched ++;

		}

		for ( const child of obj.children ) {

			if ( ! child.name ) continue;
			visit( child, ( path === '/' ? '' : path ) + '/' + child.name );

		}

	};

	visit( model, '/' );
	if ( matched === 0 ) model.userData.usdPath = '/';
	return matched;

}
