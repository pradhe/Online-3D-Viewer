import { USDCParser } from 'three/addons/loaders/usd/USDCParser.js';

/**
 * Fixes for three.js' binary USD (crate) reader. Imported once, before any
 * USD file is parsed; affects both geometry loading and metadata reading.
 */

// Crate inlines small vectors as one signed byte per component. three.js
// handles float/int vectors but not double or half ones, so a translate of
// (0, 45, 0) authored by Pixar's tools arrives as a single number and the
// transform code crashes. Type enum → component count.
const INT8_INLINED_VECTORS = {
	19: 2, // Vec2d
	23: 3, // Vec3d
	25: 3, // Vec3h
	27: 4, // Vec4d
	29: 4, // Vec4h
};

const T_STRING = 10;

const readInlinedValue = USDCParser.prototype._readInlinedValue;

USDCParser.prototype._readInlinedValue = function ( valueRep ) {

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

// string[] attributes (e.g. custom tags) are skipped with a console warning.
const readArrayValue = USDCParser.prototype._readArrayValue;

USDCParser.prototype._readArrayValue = function ( valueRep ) {

	if ( valueRep.typeEnum !== T_STRING || valueRep.isCompressed ) return readArrayValue.call( this, valueRep );

	const reader = this.reader;
	const size = this.version.major === 0 && this.version.minor < 7 ? reader.readUint32() : reader.readUint64();
	const out = [];
	for ( let i = 0; i < size; i ++ ) out.push( this.tokens[ this.strings[ reader.readUint32() ] ] );
	return out;

};
