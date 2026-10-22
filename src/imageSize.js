/** Reads the pixel size of PNG, JPEG and WebP data from its header, without decoding it. */
export function imageSize( bytes ) {

	const u16 = ( i ) => ( bytes[ i ] << 8 ) | bytes[ i + 1 ];
	const u32 = ( i ) => ( ( bytes[ i ] << 24 ) | ( bytes[ i + 1 ] << 16 ) | ( bytes[ i + 2 ] << 8 ) | bytes[ i + 3 ] ) >>> 0;

	// PNG: signature, then the IHDR chunk with big-endian width and height.
	if ( bytes.length > 24 && bytes[ 0 ] === 0x89 && bytes[ 1 ] === 0x50 && bytes[ 2 ] === 0x4E && bytes[ 3 ] === 0x47 ) {

		return { width: u32( 16 ), height: u32( 20 ) };

	}

	// JPEG: walk the segments until a start-of-frame marker.
	if ( bytes.length > 4 && bytes[ 0 ] === 0xFF && bytes[ 1 ] === 0xD8 ) {

		let i = 2;

		while ( i + 9 < bytes.length ) {

			if ( bytes[ i ] !== 0xFF ) {

				i ++;
				continue;

			}

			const marker = bytes[ i + 1 ];
			if ( marker === 0xFF ) {

				i ++;
				continue;

			}

			const isFrame = marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC;
			if ( isFrame ) return { height: u16( i + 5 ), width: u16( i + 7 ) };
			if ( marker === 0xD8 || marker === 0x01 || ( marker >= 0xD0 && marker <= 0xD7 ) ) {

				i += 2;
				continue;

			}

			i += 2 + u16( i + 2 );

		}

		return null;

	}

	// WebP: RIFF container with a lossy (VP8 ), lossless (VP8L) or extended (VP8X) chunk.
	if ( bytes.length > 30 && bytes[ 0 ] === 0x52 && bytes[ 1 ] === 0x49 && bytes[ 8 ] === 0x57 && bytes[ 9 ] === 0x45 ) {

		const kind = String.fromCharCode( bytes[ 12 ], bytes[ 13 ], bytes[ 14 ], bytes[ 15 ] );

		if ( kind === 'VP8 ' ) return { width: ( bytes[ 26 ] | ( bytes[ 27 ] << 8 ) ) & 0x3FFF, height: ( bytes[ 28 ] | ( bytes[ 29 ] << 8 ) ) & 0x3FFF };
		if ( kind === 'VP8L' ) {

			const bits = bytes[ 21 ] | ( bytes[ 22 ] << 8 ) | ( bytes[ 23 ] << 16 ) | ( bytes[ 24 ] << 24 );
			return { width: ( bits & 0x3FFF ) + 1, height: ( ( bits >>> 14 ) & 0x3FFF ) + 1 };

		}

		if ( kind === 'VP8X' ) {

			return {
				width: 1 + ( bytes[ 24 ] | ( bytes[ 25 ] << 8 ) | ( bytes[ 26 ] << 16 ) ),
				height: 1 + ( bytes[ 27 ] | ( bytes[ 28 ] << 8 ) | ( bytes[ 29 ] << 16 ) ),
			};

		}

	}

	return null;

}
