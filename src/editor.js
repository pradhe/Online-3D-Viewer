import * as THREE from 'three';

/**
 * Editing for the Selection panel: material appearance, transforms, USD
 * attributes and metadata, custom properties, plus a USD "edits layer"
 * writer that saves every change as overrides on top of the original file.
 */

const VECTOR_SIZES = { 2: 2, 3: 3, 4: 4 };
const INT_TYPES = [ 'int', 'uint', 'int64', 'uint64', 'uchar' ];
const FLOAT_TYPES = [ 'half', 'float', 'double', 'timecode' ];
const KIND_VALUES = [ 'component', 'subcomponent', 'group', 'assembly', 'model' ];
const NEW_ATTR_TYPES = [ 'string', 'token', 'int', 'double', 'float', 'bool', 'float3', 'double3', 'color3f' ];

export function escapeHtml( s ) {

	return String( s ).replace( /[&<>"']/g, ( c ) => ( { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[ c ] ) );

}

function vectorSize( type ) {

	if ( /^quat[fdh]$/.test( type ) ) return 4;
	const m = type.match( /^(?:float|double|half|int|color|point|normal|vector|texCoord)(\d)[fdhi]?$/ );
	return m ? VECTOR_SIZES[ m[ 1 ] ] || 0 : 0;

}

function quoteUsd( s ) {

	return '"' + String( s ).replace( /\\/g, '\\\\' ).replace( /"/g, '\\"' ).replace( /\n/g, '\\n' ) + '"';

}

function fmtNum( n ) {

	return String( + Number( n ).toPrecision( 7 ) );

}

/**
 * Validates text typed for an attribute of USD type `type`.
 * Returns { usda, display } or { error }.
 */
export function parseAttrValue( type, text ) {

	const t = String( text ).trim();

	if ( type === 'bool' ) {

		if ( /^(true|1|yes|on)$/i.test( t ) ) return { usda: '1', display: 'true' };
		if ( /^(false|0|no|off)$/i.test( t ) ) return { usda: '0', display: 'false' };
		return { error: 'Use true or false.' };

	}

	if ( INT_TYPES.includes( type ) ) {

		if ( ! /^-?\d+$/.test( t ) ) return { error: 'Use a whole number.' };
		if ( type.startsWith( 'u' ) && t.startsWith( '-' ) ) return { error: 'Use a number of 0 or more.' };
		return { usda: t, display: t };

	}

	if ( FLOAT_TYPES.includes( type ) ) {

		const n = Number( t );
		if ( t === '' || ! Number.isFinite( n ) ) return { error: 'Use a number.' };
		return { usda: fmtNum( n ), display: fmtNum( n ) };

	}

	if ( type === 'string' || type === 'token' ) return { usda: quoteUsd( t ), display: t };

	if ( type === 'asset' ) {

		if ( t.includes( '@' ) ) return { error: 'Asset paths cannot contain @.' };
		return { usda: `@${ t }@`, display: t };

	}

	const size = vectorSize( type );
	if ( size ) {

		const nums = t.match( /-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi ) || [];
		if ( nums.length !== size || nums.some( ( n ) => ! Number.isFinite( Number( n ) ) ) ) return { error: `Use ${ size } numbers, like (${ Array( size ).fill( 0 ).join( ', ' ) }).` };
		const text = '(' + nums.map( fmtNum ).join( ', ' ) + ')';
		return { usda: text, display: text };

	}

	return { error: `Editing ${ type } values is not supported.` };

}

function isEditableAttr( a ) {

	if ( a.animated || a.connection || a.type.endsWith( '[]' ) ) return false;
	if ( a.name.startsWith( 'xformOp' ) ) return false;
	const t = a.type;
	return t === 'bool' || INT_TYPES.includes( t ) || FLOAT_TYPES.includes( t ) || [ 'string', 'token', 'asset' ].includes( t ) || vectorSize( t ) > 0;

}

/** Guesses a USD type for a dictionary value typed by the user. */
function dictEntry( key, text ) {

	const t = String( text ).trim();
	if ( /^(true|false)$/i.test( t ) ) return `bool ${ key } = ${ /^true$/i.test( t ) ? 1 : 0 }`;
	if ( /^-?\d+$/.test( t ) && Math.abs( Number( t ) ) < 2 ** 31 ) return `int ${ key } = ${ t }`;
	if ( t !== '' && Number.isFinite( Number( t ) ) ) return `double ${ key } = ${ fmtNum( t ) }`;
	if ( key === 'identifier' ) return `asset ${ key } = @${ t.replace( /@/g, '' ) }@`;
	return `string ${ key } = ${ quoteUsd( t ) }`;

}

function snapshotMaterial( m ) {

	return {
		color: m.color ? m.color.clone() : null,
		emissive: m.emissive ? m.emissive.clone() : null,
		opacity: m.opacity,
		transparent: m.transparent,
		roughness: m.roughness,
		metalness: m.metalness,
		shininess: m.shininess,
	};

}

function restoreMaterial( m, s ) {

	if ( s.color && m.color ) m.color.copy( s.color );
	if ( s.emissive && m.emissive ) m.emissive.copy( s.emissive );
	m.opacity = s.opacity;
	m.transparent = s.transparent;
	if ( s.roughness !== undefined ) m.roughness = s.roughness;
	if ( s.metalness !== undefined ) m.metalness = s.metalness;
	if ( s.shininess !== undefined ) m.shininess = s.shininess;
	m.needsUpdate = true;

}

function sameMaterialValues( a, b ) {

	const hex = ( c ) => ( c ? c.getHexString() : '' );
	return hex( a.color ) === hex( b.color ) && hex( a.emissive ) === hex( b.emissive ) && a.opacity === b.opacity &&
		a.roughness === b.roughness && a.metalness === b.metalness && a.shininess === b.shininess;

}

/** USD colours are linear, as are three.js colours internally. */
function linearTriple( color ) {

	return `(${ fmtNum( color.r ) }, ${ fmtNum( color.g ) }, ${ fmtNum( color.b ) })`;

}

export class Editor {

	constructor( { viewer, state, toast, onChange } ) {

		this.viewer = viewer;
		this.state = state;
		this.toast = toast;
		this.onChange = onChange;
		this.reset();

	}

	reset() {

		this.attrEdits = new Map(); // primPath -> Map(name -> { type, usda, display, custom, uniform, isNew })
		this.metaEdits = new Map(); // primPath -> Map(key -> value text)
		this.materialSnapshots = new Map(); // Material -> original values
		this.isolatedMeshes = new Map(); // Mesh -> material(s) it had before "only selected parts"
		this.propEdits = new Set(); // objects whose userData.props changed
		this.activeGroup = null;
		this.scope = 'all';

	}

	// ------------------------------------------------------------------ state helpers

	get meta() {

		return this.state.file?.usd || null;

	}

	primOf( obj ) {

		const path = obj?.userData?.usdPath;
		return this.meta && path ? this.meta.prims.get( path ) : null;

	}

	transformEdited() {

		const out = [];
		const original = this.viewer.originalMatrices;
		const model = this.viewer.model;
		// Objects driven by animation move every frame; they are not user edits.
		const animated = new Set( ( model?.animations || [] ).flatMap( ( c ) => c.tracks.map( ( t ) => t.name.split( '.' )[ 0 ] ) ) );
		model?.traverse( ( o ) => {

			const m = original.get( o );
			if ( ! m || animated.has( o.name ) || animated.has( o.uuid ) ) return;
			o.updateMatrix();
			if ( ! o.matrix.equals( m ) ) out.push( o );

		} );
		return out;

	}

	editedMaterials() {

		return [ ...this.materialSnapshots.entries() ].filter( ( [ m, s ] ) => ! sameMaterialValues( snapshotMaterial( m ), s ) ).map( ( [ m ] ) => m );

	}

	editCount() {

		let n = 0;
		this.attrEdits.forEach( ( m ) => {

			n += m.size;

		} );
		this.metaEdits.forEach( ( m ) => {

			n += m.size;

		} );
		return n + this.editedMaterials().length + this.transformEdited().length + this.propEdits.size;

	}

	changed() {

		this.onChange?.();

	}

	// ------------------------------------------------------------------ materials

	meshesIn( objects ) {

		const meshes = new Set();
		objects.forEach( ( o ) => o.traverse( ( c ) => {

			if ( c.isMesh ) meshes.add( c );

		} ) );
		return [ ...meshes ];

	}

	/** Parts that share a material: same USD binding, else the same material object. */
	materialKey( mesh, material ) {

		const prim = this.primOf( mesh );
		const binding = prim?.relationships.find( ( r ) => r.name === 'material:binding' )?.targets[ 0 ];
		return binding ? `usd:${ binding }` : `mat:${ material.uuid }`;

	}

	materialGroups( meshes ) {

		const groups = new Map();

		for ( const mesh of meshes ) {

			this.viewer.getOriginalMaterials( mesh ).forEach( ( m, index ) => {

				const key = this.materialKey( mesh, m );
				if ( ! groups.has( key ) ) groups.set( key, { key, name: m.name || '(unnamed)', sample: m, parts: [] } );
				groups.get( key ).parts.push( { mesh, index } );

			} );

		}

		return [ ...groups.values() ];

	}

	partsUsing( key ) {

		const all = this.meshesIn( this.viewer.model ? [ this.viewer.model ] : [] );
		return this.materialGroups( all ).find( ( g ) => g.key === key )?.parts || [];

	}

	/** Materials to change for the active group and scope; isolates shared ones for "selected only". */
	targetMaterials( group ) {

		const parts = this.scope === 'all' ? this.partsUsing( group.key ) : group.parts;

		if ( this.scope === 'selected' ) {

			// A material object may also be used by unselected parts (OBJ files share one); give the selection its own copy.
			const selectedMeshes = new Set( group.parts.map( ( p ) => p.mesh ) );
			const shared = new Map();

			for ( const { mesh, index } of parts ) {

				const mats = this.viewer.getOriginalMaterials( mesh );
				const m = mats[ index ];
				const usedElsewhere = this.meshesIn( [ this.viewer.model ] ).some( ( other ) => ! selectedMeshes.has( other ) && this.viewer.getOriginalMaterials( other ).includes( m ) );
				if ( ! this.isolatedMeshes.has( mesh ) ) this.isolatedMeshes.set( mesh, this.viewer.originalMaterials.get( mesh ) );
				if ( ! usedElsewhere ) continue;

				if ( ! shared.has( m ) ) {

					const copy = m.clone();
					copy.name = m.name;
					shared.set( m, copy );
					if ( this.materialSnapshots.has( m ) ) this.materialSnapshots.set( copy, this.materialSnapshots.get( m ) );

				}

				const next = [ ...mats ];
				next[ index ] = shared.get( m );
				this.viewer.replaceMaterial( mesh, Array.isArray( this.viewer.originalMaterials.get( mesh ) ) ? next : next[ 0 ] );

			}

		}

		const out = new Set();
		for ( const { mesh, index } of parts ) out.add( this.viewer.getOriginalMaterials( mesh )[ index ] );
		return [ ...out ];

	}

	applyMaterial( group, change ) {

		for ( const m of this.targetMaterials( group ) ) {

			if ( ! this.materialSnapshots.has( m ) ) this.materialSnapshots.set( m, snapshotMaterial( m ) );
			change( m );
			m.needsUpdate = true;

		}

	}

	resetMaterials( group ) {

		const parts = this.partsUsing( group.key );

		for ( const { mesh } of parts ) {

			if ( this.isolatedMeshes.has( mesh ) ) {

				this.viewer.replaceMaterial( mesh, this.isolatedMeshes.get( mesh ) );
				this.isolatedMeshes.delete( mesh );

			}

		}

		for ( const { mesh, index } of this.partsUsing( group.key ) ) {

			const m = this.viewer.getOriginalMaterials( mesh )[ index ];
			const snap = this.materialSnapshots.get( m );
			if ( snap ) {

				restoreMaterial( m, snap );
				this.materialSnapshots.delete( m );

			}

		}

	}

	appearanceSection( selection ) {

		const meshes = this.meshesIn( selection );
		if ( ! meshes.length ) return '';
		const groups = this.materialGroups( meshes );
		const group = groups.find( ( g ) => g.key === this.activeGroup ) || groups[ 0 ];
		this.activeGroup = group.key;
		const m = group.sample;
		const allCount = this.partsUsing( group.key ).length;
		const selCount = group.parts.length;
		const color = m.color ? `#${ m.color.getHexString() }` : '#ffffff';
		const emissive = m.emissive ? `#${ m.emissive.getHexString() }` : '#000000';
		const edited = [ ...this.materialSnapshots.keys() ].some( ( x ) => this.partsUsing( group.key ).some( ( p ) => this.viewer.getOriginalMaterials( p.mesh )[ p.index ] === x ) );
		const slider = ( id, label, value, min, max, step ) => `
			<label class="field range">
				<span>${ label } <output>${ fmtNum( value ) }</output></span>
				<input type="range" id="${ id }" min="${ min }" max="${ max }" step="${ step }" value="${ value }" />
			</label>`;

		return `
			<details class="edit-group" open>
				<summary>Appearance ${ edited ? '<span class="usd-badge edited">edited</span>' : '' }</summary>
				<div class="edit-body">
					${ groups.length > 1 ? `
					<label class="field">
						<span>Material</span>
						<select id="edit-mat-group">${ groups.map( ( g ) => `<option value="${ escapeHtml( g.key ) }" ${ g === group ? 'selected' : '' }>${ escapeHtml( g.name ) } (${ g.parts.length })</option>` ).join( '' ) }</select>
					</label>` : `<div class="edit-mat-name"><span class="chip" style="background:${ color }"></span>${ escapeHtml( group.name ) }</div>` }
					<div class="seg edit-scope" role="radiogroup" aria-label="Apply changes to">
						<button data-scope="all" class="${ this.scope === 'all' ? 'active' : '' }" title="Every part that uses this material">All parts (${ allCount })</button>
						<button data-scope="selected" class="${ this.scope === 'selected' ? 'active' : '' }" title="Only the selected parts">Selected (${ selCount })</button>
					</div>
					<div class="edit-colors">
						<label class="color-field"><input type="color" id="edit-color" value="${ color }" /><span>Colour</span><code id="edit-color-hex">${ color }</code></label>
						${ m.emissive ? `<label class="color-field"><input type="color" id="edit-emissive" value="${ emissive }" /><span>Glow</span><code id="edit-emissive-hex">${ emissive }</code></label>` : '' }
					</div>
					${ slider( 'edit-opacity', 'Opacity', m.opacity, 0, 1, 0.01 ) }
					${ m.roughness !== undefined ? slider( 'edit-roughness', 'Roughness', m.roughness, 0, 1, 0.01 ) : '' }
					${ m.metalness !== undefined ? slider( 'edit-metalness', 'Metalness', m.metalness, 0, 1, 0.01 ) : '' }
					${ m.shininess !== undefined ? slider( 'edit-shininess', 'Shininess', m.shininess, 0, 200, 1 ) : '' }
					${ this.viewer.renderMode !== 'shaded' ? '<p class="muted small">Switch Render mode to Shaded to see colours.</p>' : '' }
					<button class="btn small" id="edit-mat-reset" ${ edited ? '' : 'disabled' }>Reset appearance</button>
				</div>
			</details>`;

	}

	wireAppearance( root, selection ) {

		const meshes = this.meshesIn( selection );
		if ( ! meshes.length ) return;
		const group = () => this.materialGroups( meshes ).find( ( g ) => g.key === this.activeGroup );

		root.querySelector( '#edit-mat-group' )?.addEventListener( 'change', ( e ) => {

			this.activeGroup = e.target.value;
			this.changed();

		} );

		root.querySelectorAll( '[data-scope]' ).forEach( ( b ) => b.addEventListener( 'click', () => {

			this.scope = b.dataset.scope;
			this.changed();

		} ) );

		const colorInput = ( id, prop ) => {

			const input = root.querySelector( `#${ id }` );
			if ( ! input ) return;
			input.addEventListener( 'input', () => {

				this.applyMaterial( group(), ( m ) => m[ prop ]?.set( input.value ) );
				root.querySelector( `#${ id }-hex` ).textContent = input.value;

			} );
			input.addEventListener( 'change', () => this.changed() );

		};

		colorInput( 'edit-color', 'color' );
		colorInput( 'edit-emissive', 'emissive' );

		const sliderInput = ( id, apply ) => {

			const input = root.querySelector( `#${ id }` );
			if ( ! input ) return;
			input.addEventListener( 'input', () => {

				const v = Number( input.value );
				this.applyMaterial( group(), ( m ) => apply( m, v ) );
				input.parentElement.querySelector( 'output' ).textContent = fmtNum( v );

			} );
			input.addEventListener( 'change', () => this.changed() );

		};

		sliderInput( 'edit-opacity', ( m, v ) => {

			m.opacity = v;
			m.transparent = v < 1 || this.materialSnapshots.get( m )?.transparent;
			m.depthWrite = v >= 1;

		} );
		sliderInput( 'edit-roughness', ( m, v ) => {

			m.roughness = v;

		} );
		sliderInput( 'edit-metalness', ( m, v ) => {

			m.metalness = v;

		} );
		sliderInput( 'edit-shininess', ( m, v ) => {

			m.shininess = v;

		} );

		root.querySelector( '#edit-mat-reset' )?.addEventListener( 'click', () => {

			this.resetMaterials( group() );
			this.changed();

		} );

	}

	// ------------------------------------------------------------------ transform

	transformSection( obj ) {

		const animated = this.primOf( obj )?.attributes.some( ( a ) => a.animated && a.name.startsWith( 'xformOp' ) );
		const deg = ( r ) => fmtNum( THREE.MathUtils.radToDeg( r ) );
		const row = ( label, key, values ) => `
			<div class="vec-row">
				<span>${ label }</span>
				${ values.map( ( v, i ) => `<input type="number" step="any" id="edit-${ key }-${ i }" data-tf="${ key }" data-axis="${ i }" value="${ v }" aria-label="${ label } ${ 'XYZ'[ i ] }" />` ).join( '' ) }
			</div>`;
		const edited = this.transformEdited().includes( obj );

		return `
			<details class="edit-group" open>
				<summary>Transform ${ edited ? '<span class="usd-badge edited">edited</span>' : '' }</summary>
				<div class="edit-body">
					${ animated ? '<p class="muted small">This object is animated in the file; transform edits are not saved to the USD edits layer.</p>' : '' }
					<div class="vec-head"><span></span><span>X</span><span>Y</span><span>Z</span></div>
					${ row( 'Position', 'p', [ obj.position.x, obj.position.y, obj.position.z ].map( fmtNum ) ) }
					${ row( 'Rotation°', 'r', [ obj.rotation.x, obj.rotation.y, obj.rotation.z ].map( deg ) ) }
					${ row( 'Scale', 's', [ obj.scale.x, obj.scale.y, obj.scale.z ].map( fmtNum ) ) }
				</div>
			</details>`;

	}

	wireTransform( root, obj ) {

		root.querySelectorAll( '[data-tf]' ).forEach( ( input ) => input.addEventListener( 'input', () => {

			const v = Number( input.value );
			if ( input.value === '' || ! Number.isFinite( v ) ) return;
			const axis = 'xyz'[ input.dataset.axis ];
			if ( input.dataset.tf === 'p' ) obj.position[ axis ] = v;
			if ( input.dataset.tf === 'r' ) obj.rotation[ axis ] = THREE.MathUtils.degToRad( v );
			if ( input.dataset.tf === 's' ) obj.scale[ axis ] = v;
			obj.updateMatrixWorld( true );
			this.viewer.dispatchEvent( new CustomEvent( 'transformchange', { detail: { fromEditor: true } } ) );

		} ) );

		root.querySelectorAll( '[data-tf]' ).forEach( ( input ) => input.addEventListener( 'change', () => this.changed() ) );

	}

	syncTransformInputs( root, obj ) {

		if ( ! obj ) return;
		const values = {
			p: [ obj.position.x, obj.position.y, obj.position.z ],
			r: [ obj.rotation.x, obj.rotation.y, obj.rotation.z ].map( THREE.MathUtils.radToDeg ),
			s: [ obj.scale.x, obj.scale.y, obj.scale.z ],
		};
		root.querySelectorAll( '[data-tf]' ).forEach( ( input ) => {

			if ( document.activeElement === input ) return;
			input.value = fmtNum( values[ input.dataset.tf ][ input.dataset.axis ] );

		} );

	}

	// ------------------------------------------------------------------ USD properties

	usdLink( path ) {

		const primPath = path.split( '.' )[ 0 ];
		const target = this.state.usdObjects.get( primPath );
		return target
			? `<button class="usd-link" data-usd-select="${ escapeHtml( primPath ) }" title="Select ${ escapeHtml( primPath ) }">${ escapeHtml( path ) }</button>`
			: `<code>${ escapeHtml( path ) }</code>`;

	}

	attributesOf( prim ) {

		const edits = this.attrEdits.get( prim.path ) || new Map();
		const list = prim.attributes.map( ( a ) => ( { ...a, edit: edits.get( a.name ) } ) );
		edits.forEach( ( e, name ) => {

			if ( e.isNew ) list.push( { name, type: e.type, value: e.display, custom: true, uniform: false, animated: false, connection: null, edit: e } );

		} );
		return list.sort( ( a, b ) => ( b.custom - a.custom ) || a.name.localeCompare( b.name ) );

	}

	metadataOf( prim ) {

		const edits = this.metaEdits.get( prim.path ) || new Map();
		const rows = prim.metadata.map( ( [ k, v ] ) => ( { key: k, value: v, edit: edits.get( k ) } ) );
		edits.forEach( ( v, k ) => {

			if ( ! prim.metadata.some( ( [ key ] ) => key === k ) ) rows.push( { key: k, value: '', edit: v, isNew: true } );

		} );
		return rows;

	}

	usdSection( obj ) {

		const prim = this.primOf( obj );
		if ( ! prim ) return this.customPropsSection( obj );

		const editableMeta = ( key ) => key === 'doc' || key === 'kind' || key.startsWith( 'customData.' ) || key.startsWith( 'assetInfo.' );
		const metaRows = this.metadataOf( prim ).map( ( r ) => {

			const shown = r.edit !== undefined ? r.edit : r.value;
			const badge = r.edit !== undefined ? `<span class="usd-badge edited">edited</span><button class="revert" data-revert-meta="${ escapeHtml( r.key ) }" title="Undo this change">↺</button>` : '';
			const input = r.key === 'kind'
				? `<input class="inline-edit" list="usd-kinds" data-meta="${ escapeHtml( r.key ) }" value="${ escapeHtml( shown ) }" />`
				: `<input class="inline-edit" data-meta="${ escapeHtml( r.key ) }" value="${ escapeHtml( shown ) }" />`;
			return `<dt>${ escapeHtml( r.key ) } ${ badge }</dt><dd>${ editableMeta( r.key ) ? input : escapeHtml( shown ) }</dd>`;

		} ).join( '' );

		const attrs = this.attributesOf( prim );
		const attrRows = attrs.map( ( a ) => {

			const badges = [ a.custom ? 'custom' : '', a.uniform ? 'uniform' : '', a.animated ? 'animated' : '', a.edit ? ( a.edit.isNew ? 'new' : 'edited' ) : '' ].filter( Boolean )
				.map( ( b ) => `<span class="usd-badge ${ b }">${ b }</span>` ).join( '' );
			const revert = a.edit ? `<button class="revert" data-revert-attr="${ escapeHtml( a.name ) }" title="${ a.edit.isNew ? 'Remove this property' : 'Undo this change' }">${ a.edit.isNew ? '✕' : '↺' }</button>` : '';
			let value;

			if ( a.connection ) value = `→ ${ this.usdLink( a.connection ) }`;
			else if ( a.animated ) value = `${ a.samples ? `${ a.samples } keyframes` : 'Time-sampled' }${ a.value !== undefined ? ` · default ${ escapeHtml( a.value ) }` : '' }`;
			else if ( isEditableAttr( a ) ) {

				const shown = a.edit ? a.edit.display : ( a.value ?? '' );
				value = a.type === 'bool'
					? `<label class="inline-bool"><input type="checkbox" data-attr="${ escapeHtml( a.name ) }" data-type="bool" ${ shown === 'true' ? 'checked' : '' } /> ${ shown || 'false' }</label>`
					: `<input class="inline-edit" data-attr="${ escapeHtml( a.name ) }" data-type="${ escapeHtml( a.type ) }" value="${ escapeHtml( shown ) }" />`;

			} else value = a.value === undefined ? '<span class="muted">no value</span>' : escapeHtml( a.value );

			return `<li data-usd-filter="${ escapeHtml( ( a.name + ' ' + a.type ).toLowerCase() ) }">
				<div class="usd-attr-head"><span class="usd-attr-name">${ escapeHtml( a.name ) }</span><span class="usd-attr-type">${ escapeHtml( a.type ) }</span>${ badges }${ revert }</div>
				<div class="usd-attr-value">${ value }</div>
			</li>`;

		} ).join( '' );

		const relRows = prim.relationships.map( ( r ) => `<li>
				<div class="usd-attr-head"><span class="usd-attr-name">${ escapeHtml( r.name ) }</span><span class="usd-attr-type">rel</span></div>
				<div class="usd-attr-value">${ r.targets.length ? r.targets.map( ( t ) => this.usdLink( t ) ).join( '<br/>' ) : '<span class="muted">no targets</span>' }</div>
			</li>` ).join( '' );

		return `
			<div class="usd-block">
				<div class="sub-label">USD prim</div>
				<div class="usd-path"><code title="${ escapeHtml( prim.path ) }">${ escapeHtml( prim.path ) }</code><button class="btn small" data-usd-copy="${ escapeHtml( prim.path ) }">Copy</button></div>
				<datalist id="usd-kinds">${ KIND_VALUES.map( ( k ) => `<option value="${ k }"></option>` ).join( '' ) }</datalist>
				<dl class="props usd-props">
					<dt>Type</dt><dd>${ escapeHtml( prim.type || '(typeless)' ) }</dd>
					${ prim.specifier !== 'def' ? `<dt>Specifier</dt><dd>${ escapeHtml( prim.specifier ) }</dd>` : '' }
					${ metaRows }
				</dl>
				<div class="button-row">
					${ prim.metadata.some( ( [ k ] ) => k === 'doc' ) || this.metaEdits.get( prim.path )?.has( 'doc' ) ? '' : '<button class="btn small" data-add-meta="doc">+ doc</button>' }
					<button class="btn small" data-add-meta="customData">+ Custom data</button>
				</div>
				<details class="usd-group" open>
					<summary>Attributes <span class="muted">${ attrs.length }</span></summary>
					${ attrs.length > 8 ? '<input type="search" class="usd-filter" id="usd-attr-filter" placeholder="Filter attributes…" autocomplete="off" />' : '' }
					<ul class="usd-attrs">${ attrRows }</ul>
					${ this.addPropertyForm( true ) }
				</details>
				${ prim.relationships.length ? `
				<details class="usd-group" open>
					<summary>Relationships <span class="muted">${ prim.relationships.length }</span></summary>
					<ul class="usd-attrs">${ relRows }</ul>
				</details>` : '' }
			</div>`;

	}

	addPropertyForm( usd ) {

		return `
			<form class="add-prop" id="add-prop-form" autocomplete="off">
				<div class="add-prop-title">Add property</div>
				<input id="add-prop-name" placeholder="${ usd ? 'userProperties:name' : 'name' }" value="${ usd ? 'userProperties:' : '' }" required />
				<div class="add-prop-row">
					${ usd ? `<select id="add-prop-type" aria-label="Type">${ NEW_ATTR_TYPES.map( ( t ) => `<option>${ t }</option>` ).join( '' ) }</select>` : '' }
					<input id="add-prop-value" placeholder="Value" />
					<button class="btn small" type="submit">Add</button>
				</div>
			</form>`;

	}

	customPropsSection( obj ) {

		const props = obj.userData.props || {};
		const rows = Object.entries( props ).map( ( [ k, v ] ) => `<li>
				<div class="usd-attr-head"><span class="usd-attr-name">${ escapeHtml( k ) }</span><button class="revert" data-remove-prop="${ escapeHtml( k ) }" title="Remove this property">✕</button></div>
				<div class="usd-attr-value"><input class="inline-edit" data-prop="${ escapeHtml( k ) }" value="${ escapeHtml( v ) }" /></div>
			</li>` ).join( '' );

		return `
			<details class="usd-group" open>
				<summary>Custom properties <span class="muted">${ Object.keys( props ).length }</span></summary>
				${ rows ? `<ul class="usd-attrs">${ rows }</ul>` : '<p class="muted small edit-hint">Add your own key/value notes. They are kept in GLB exports.</p>' }
				${ this.addPropertyForm( false ) }
			</details>`;

	}

	wireProperties( root, obj ) {

		root.querySelectorAll( '[data-usd-select]' ).forEach( ( b ) => b.addEventListener( 'click', () => {

			const target = this.state.usdObjects.get( b.dataset.usdSelect );
			if ( target ) this.viewer.select( [ target ] );

		} ) );

		root.querySelectorAll( '[data-usd-copy]' ).forEach( ( b ) => b.addEventListener( 'click', async () => {

			try {

				await navigator.clipboard.writeText( b.dataset.usdCopy );
				b.textContent = 'Copied';

			} catch {

				const range = document.createRange();
				range.selectNodeContents( b.previousElementSibling );
				getSelection().removeAllRanges();
				getSelection().addRange( range );
				b.textContent = 'Selected';

			}

			setTimeout( () => {

				b.textContent = 'Copy';

			}, 1500 );

		} ) );

		const filter = root.querySelector( '.usd-filter' );
		filter?.addEventListener( 'input', () => {

			const q = filter.value.trim().toLowerCase();
			filter.parentElement.querySelectorAll( '[data-usd-filter]' ).forEach( ( li ) => {

				li.hidden = q && ! li.dataset.usdFilter.includes( q );

			} );

		} );

		const prim = this.primOf( obj );
		const commitOnEnter = ( input ) => input.addEventListener( 'keydown', ( e ) => {

			if ( e.key === 'Enter' ) input.blur();
			if ( e.key === 'Escape' ) {

				input.value = input.defaultValue;
				input.blur();

			}

		} );

		// USD attribute values
		root.querySelectorAll( '[data-attr]' ).forEach( ( input ) => {

			const isBool = input.type === 'checkbox';
			if ( ! isBool ) commitOnEnter( input );
			input.addEventListener( 'change', () => {

				const name = input.dataset.attr;
				const attr = this.attributesOf( prim ).find( ( a ) => a.name === name );
				const text = isBool ? String( input.checked ) : input.value;
				const parsed = parseAttrValue( attr.type, text );

				if ( parsed.error ) {

					input.classList.add( 'invalid' );
					this.toast( `${ name }: ${ parsed.error }`, 'error', 5000 );
					return;

				}

				input.classList.remove( 'invalid' );
				this.setAttrEdit( prim, attr, parsed );
				this.changed();

			} );

		} );

		root.querySelectorAll( '[data-revert-attr]' ).forEach( ( b ) => b.addEventListener( 'click', () => {

			this.attrEdits.get( prim.path )?.delete( b.dataset.revertAttr );
			this.changed();

		} ) );

		// USD metadata
		root.querySelectorAll( '[data-meta]' ).forEach( ( input ) => {

			commitOnEnter( input );
			input.addEventListener( 'change', () => {

				const key = input.dataset.meta;
				const original = prim.metadata.find( ( [ k ] ) => k === key )?.[ 1 ];
				const map = this.metaEdits.get( prim.path ) || new Map();
				if ( input.value === original ) map.delete( key );
				else map.set( key, input.value );
				this.metaEdits.set( prim.path, map );
				this.changed();

			} );

		} );

		root.querySelectorAll( '[data-revert-meta]' ).forEach( ( b ) => b.addEventListener( 'click', () => {

			this.metaEdits.get( prim.path )?.delete( b.dataset.revertMeta );
			this.changed();

		} ) );

		root.querySelectorAll( '[data-add-meta]' ).forEach( ( b ) => b.addEventListener( 'click', () => {

			let key = b.dataset.addMeta;
			if ( key === 'customData' ) {

				let i = 1;
				const taken = ( k ) => prim.metadata.some( ( [ m ] ) => m === k ) || this.metaEdits.get( prim.path )?.has( k );
				while ( taken( `customData.note${ i > 1 ? i : '' }` ) ) i ++;
				key = `customData.note${ i > 1 ? i : '' }`;

			}

			const map = this.metaEdits.get( prim.path ) || new Map();
			map.set( key, '' );
			this.metaEdits.set( prim.path, map );
			this.changed();
			requestAnimationFrame( () => root.querySelector( `[data-meta="${ CSS.escape( key ) }"]` )?.focus() );

		} ) );

		// Non-USD custom properties
		root.querySelectorAll( '[data-prop]' ).forEach( ( input ) => {

			commitOnEnter( input );
			input.addEventListener( 'change', () => {

				obj.userData.props = { ...obj.userData.props, [ input.dataset.prop ]: input.value };
				this.propEdits.add( obj );
				this.changed();

			} );

		} );

		root.querySelectorAll( '[data-remove-prop]' ).forEach( ( b ) => b.addEventListener( 'click', () => {

			const props = { ...obj.userData.props };
			delete props[ b.dataset.removeProp ];
			obj.userData.props = props;
			this.propEdits.add( obj );
			this.changed();

		} ) );

		// Add property
		root.querySelector( '#add-prop-form' )?.addEventListener( 'submit', ( e ) => {

			e.preventDefault();
			const name = root.querySelector( '#add-prop-name' ).value.trim();
			const value = root.querySelector( '#add-prop-value' ).value;

			if ( ! prim ) {

				if ( ! name ) return;
				obj.userData.props = { ...obj.userData.props, [ name ]: value };
				this.propEdits.add( obj );
				this.changed();
				return;

			}

			if ( ! /^[A-Za-z_][\w]*(?::[A-Za-z_][\w]*)*$/.test( name ) || name.endsWith( ':' ) ) {

				this.toast( 'Property names use letters, digits and _ , with : between namespaces (e.g. userProperties:color).', 'error', 6000 );
				return;

			}

			if ( this.attributesOf( prim ).some( ( a ) => a.name === name ) ) {

				this.toast( `${ name } already exists. Edit its value in the list instead.`, 'error', 5000 );
				return;

			}

			const type = root.querySelector( '#add-prop-type' ).value;
			const parsed = parseAttrValue( type, value === '' && type === 'bool' ? 'false' : value );

			if ( parsed.error ) {

				this.toast( `${ name }: ${ parsed.error }`, 'error', 5000 );
				return;

			}

			const map = this.attrEdits.get( prim.path ) || new Map();
			map.set( name, { type, usda: parsed.usda, display: parsed.display, custom: true, uniform: false, isNew: true } );
			this.attrEdits.set( prim.path, map );
			this.changed();

		} );

	}

	setAttrEdit( prim, attr, parsed ) {

		const map = this.attrEdits.get( prim.path ) || new Map();

		if ( ! attr.edit?.isNew && parsed.display === attr.value ) map.delete( attr.name );
		else map.set( attr.name, { type: attr.type, usda: parsed.usda, display: parsed.display, custom: attr.custom, uniform: attr.uniform, isNew: !! attr.edit?.isNew } );

		this.attrEdits.set( prim.path, map );

	}

	// ------------------------------------------------------------------ USD edits layer

	/** Writes every change as a USDA layer that sublayers the original file. */
	buildUsdEditLayer() {

		const meta = this.meta;
		if ( ! meta ) return null;

		const nodes = new Map(); // path -> { meta: [], attrs: [], defs: [] }
		const node = ( path ) => {

			if ( ! nodes.has( path ) ) nodes.set( path, { meta: [], dicts: {}, attrs: [], defs: [] } );
			return nodes.get( path );

		};

		// Metadata
		this.metaEdits.forEach( ( map, path ) => map.forEach( ( value, key ) => {

			const n = node( path );
			const dot = key.indexOf( '.' );
			if ( dot > 0 ) {

				const dict = key.slice( 0, dot );
				( n.dicts[ dict ] ||= [] ).push( dictEntry( key.slice( dot + 1 ), value ) );

			} else if ( key === 'doc' || key === 'kind' ) n.meta.push( `${ key } = ${ quoteUsd( value ) }` );

		} ) );

		// Attributes
		this.attrEdits.forEach( ( map, path ) => map.forEach( ( e, name ) => {

			node( path ).attrs.push( `${ e.custom ? 'custom ' : '' }${ e.uniform ? 'uniform ' : '' }${ e.type } ${ name } = ${ e.usda }` );

		} ) );

		// Transforms (local matrix; USD matrices are row-major with translation in the last row,
		// which is exactly three.js' column-major element order).
		const skipped = [];
		for ( const obj of this.transformEdited() ) {

			const path = obj.userData.usdPath;
			if ( ! path || path === '/' ) continue;
			const prim = meta.prims.get( path );
			if ( prim?.attributes.some( ( a ) => a.animated && a.name.startsWith( 'xformOp' ) ) ) {

				skipped.push( path );
				continue;

			}

			const e = obj.matrix.elements;
			const rows = [ 0, 4, 8, 12 ].map( ( i ) => `(${ e.slice( i, i + 4 ).map( fmtNum ).join( ', ' ) })` ).join( ', ' );
			node( path ).attrs.push( `matrix4d xformOp:transform = ( ${ rows } )`, 'uniform token[] xformOpOrder = ["xformOp:transform"]' );

		}

		// Materials
		this.writeMaterialEdits( node );

		if ( ! nodes.size ) return null;

		// Assemble the prim tree.
		const tree = { children: new Map() };
		for ( const path of nodes.keys() ) {

			let t = tree;
			for ( const name of path.split( '/' ).filter( Boolean ) ) {

				if ( ! t.children.has( name ) ) t.children.set( name, { children: new Map() } );
				t = t.children.get( name );

			}

		}

		const lines = [];
		const write = ( t, path, depth ) => {

			for ( const [ name, child ] of t.children ) {

				const childPath = `${ path }/${ name }`;
				const n = nodes.get( childPath );
				const pad = '    '.repeat( depth );
				const metaLines = [ ...( n?.meta || [] ) ];
				for ( const [ dict, entries ] of Object.entries( n?.dicts || {} ) ) metaLines.push( `${ dict } = {\n${ entries.map( ( x ) => `${ pad }        ${ x }` ).join( '\n' ) }\n${ pad }    }` );

				lines.push( `${ pad }over "${ name }"${ metaLines.length ? ` (\n${ metaLines.map( ( m ) => `${ pad }    ${ m }` ).join( '\n' ) }\n${ pad })` : '' }` );
				lines.push( `${ pad }{` );
				( n?.attrs || [] ).forEach( ( a ) => lines.push( `${ pad }    ${ a }` ) );
				( n?.defs || [] ).forEach( ( d ) => lines.push( d.split( '\n' ).map( ( l ) => `${ pad }    ${ l }` ).join( '\n' ) ) );
				write( child, childPath, depth + 1 );
				lines.push( `${ pad }}` );
				lines.push( '' );

			}

		};

		write( tree, '', 0 );

		const stage = new Map( meta.stage );
		const header = [ 'defaultPrim', 'upAxis', 'metersPerUnit', 'startTimeCode', 'endTimeCode', 'timeCodesPerSecond', 'framesPerSecond' ]
			.filter( ( k ) => stage.has( k ) )
			.map( ( k ) => ( [ 'defaultPrim', 'upAxis' ].includes( k ) ? `    ${ k } = ${ quoteUsd( stage.get( k ) ) }` : `    ${ k } = ${ stage.get( k ) }` ) );
		const source = this.state.file.name;

		return {
			skipped,
			text: [
				'#usda 1.0',
				'(',
				`    doc = ${ quoteUsd( `Edits to ${ source } made in MyCity 3D Viewer on ${ new Date().toISOString().slice( 0, 10 ) }. Keep this file next to ${ source }.` ) }`,
				...header,
				`    subLayers = [@./${ source.replace( /@/g, '' ) }@]`,
				')',
				'',
				...lines,
			].join( '\n' ),
		};

	}

	writeMaterialEdits( node ) {

		const meta = this.meta;
		const edited = new Set( this.editedMaterials() );
		const isolated = new Set( this.isolatedMeshes.keys() );
		if ( ! edited.size && ! isolated.size ) return;

		// Group parts by bound USD material.
		const byBinding = new Map();
		for ( const mesh of this.meshesIn( [ this.viewer.model ] ) ) {

			const prim = this.primOf( mesh );
			const binding = prim?.relationships.find( ( r ) => r.name === 'material:binding' )?.targets[ 0 ];
			if ( ! binding ) continue;
			const m = this.viewer.getOriginalMaterials( mesh )[ 0 ];
			if ( ! byBinding.has( binding ) ) byBinding.set( binding, [] );
			byBinding.get( binding ).push( { mesh, prim, m } );

		}

		for ( const [ binding, parts ] of byBinding ) {

			const shader = this.surfaceShaderOf( binding );
			const own = parts.filter( ( p ) => isolated.has( p.mesh ) && edited.has( p.m ) );
			const shared = parts.filter( ( p ) => ! isolated.has( p.mesh ) );
			const sharedChanged = shared.filter( ( p ) => edited.has( p.m ) );

			if ( sharedChanged.length ) {

				const ref = sharedChanged[ 0 ].m;
				const uniform = shared.every( ( p ) => sameMaterialValues( snapshotMaterial( p.m ), snapshotMaterial( ref ) ) );

				if ( shader && uniform ) {

					// "All parts" edits: override the shared material's inputs.
					node( shader ).attrs.push( ...this.shaderInputs( ref, this.materialSnapshots.get( ref ) ) );

				} else {

					own.push( ...sharedChanged );

				}

			}

			// "Selected parts" edits: give each such part its own material and bind it.
			const baseName = binding.split( '/' ).pop();

			for ( const p of own ) {

				// New materials go next to the original (or under the part's root prim if that is the stage root).
				const parent = binding.slice( 0, binding.lastIndexOf( '/' ) ) || p.prim.path.split( '/' ).slice( 0, 2 ).join( '/' );
				const name = `${ baseName }_${ p.prim.name }`.replace( /[^\w]/g, '_' );
				const matPath = `${ parent }/${ name }`;
				node( parent ).defs.push( [
					`def Material "${ name }"`,
					'{',
					`    token outputs:surface.connect = <${ matPath }/PBR.outputs:surface>`,
					'    def Shader "PBR"',
					'    {',
					'        uniform token info:id = "UsdPreviewSurface"',
					...this.shaderInputs( p.m, null ).map( ( l ) => `        ${ l }` ),
					'        token outputs:surface',
					'    }',
					'}',
				].join( '\n' ) );
				node( p.prim.path ).attrs.push( `rel material:binding = <${ matPath }>` );

			}

		}

	}

	surfaceShaderOf( materialPath ) {

		let fallback = null;

		for ( const [ path, prim ] of this.meta.prims ) {

			if ( ! path.startsWith( materialPath + '/' ) || prim.type !== 'Shader' ) continue;
			const id = prim.attributes.find( ( a ) => a.name === 'info:id' )?.value;
			if ( id === 'UsdPreviewSurface' ) return path;
			fallback = fallback || path;

		}

		return fallback;

	}

	/** UsdPreviewSurface inputs for a material; only changed ones when a snapshot is given. */
	shaderInputs( m, snap ) {

		const out = [];
		const differs = ( key ) => ! snap || ( snap[ key ]?.isColor ? ! snap[ key ].equals( m[ key ] ) : snap[ key ] !== m[ key ] );
		if ( m.color && differs( 'color' ) ) out.push( `color3f inputs:diffuseColor = ${ linearTriple( m.color ) }` );
		if ( m.emissive && differs( 'emissive' ) ) out.push( `color3f inputs:emissiveColor = ${ linearTriple( m.emissive ) }` );
		if ( m.roughness !== undefined && differs( 'roughness' ) ) out.push( `float inputs:roughness = ${ fmtNum( m.roughness ) }` );
		if ( m.metalness !== undefined && differs( 'metalness' ) ) out.push( `float inputs:metallic = ${ fmtNum( m.metalness ) }` );
		if ( differs( 'opacity' ) ) out.push( `float inputs:opacity = ${ fmtNum( m.opacity ) }` );
		return out;

	}

}
